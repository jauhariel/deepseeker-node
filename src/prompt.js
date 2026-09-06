import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { MAX_HISTORY_TOKENS, MAX_TOOL_RESULTS_TOKENS } from './config.js';
import { uploadFile } from './deepseek.js';
import { countTokens, stableStringify, guessExtension, guessMimeType } from './util.js';

export function extractSystem(messages) {
  for (const m of messages) {
    if (m.role === 'system') return m.content;
  }
  return null;
}

export function extractTools(tools) {
  if (!tools || !tools.length) return null;
  const finalTools = [];
  for (const t of tools) {
    if (t.type === 'function') {
      const fn = t.function || {};
      finalTools.push(`Tool: ${fn.name || ''}\nDescription: ${fn.description || ''}\nParameters: ${JSON.stringify(fn.parameters || {})}`);
    } else if ('name' in t) {
      finalTools.push(`Tool: ${t.name || ''}\nDescription: ${t.description || ''}\nParameters: ${JSON.stringify(t.input_schema ?? t.parameters ?? {})}`);
    } else if (['computer_use', 'text_editor', 'bash'].includes(t.type)) {
      finalTools.push(`Tool: ${t.type}\nDescription: ${JSON.stringify(t)}`);
    } else {
      finalTools.push(`Tool: ${JSON.stringify(t)}`);
    }
  }
  return finalTools.length ? finalTools.join('\n\n') : null;
}

export function extractToolResults(messages, latestOnly = false) {
  let targetMessages = messages;
  if (latestOnly) {
    let lastAstIdx = -1;
    for (let idx = messages.length - 1; idx >= 0; idx--) {
      if (messages[idx].role === 'assistant') {
        lastAstIdx = idx;
        break;
      }
    }
    if (lastAstIdx !== -1) targetMessages = messages.slice(lastAstIdx + 1);
  }
  const toolsFinal = [];
  for (const m of targetMessages) {
    if (m.role === 'tool') {
      const name = m.name || 'tool';
      const callId = m.tool_call_id || '';
      let content = m.content ?? '';
      if (Array.isArray(content)) {
        content = content.filter((c) => c && typeof c === 'object' && c.type === 'text').map((c) => c.text || '').join(' ');
      }
      toolsFinal.push(`Tool: ${name} (Call ID: ${callId})\nResult: ${content}`);
    }
  }
  return toolsFinal.length ? toolsFinal.join('\n\n') : null;
}

// --- SSRF protection: only allow http(s) URLs resolving to public addresses ---

function isPublicIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 0 || p[0] === 10 || p[0] === 127) return false;
    if (p[0] === 169 && p[1] === 254) return false;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return false;
    if (p[0] === 192 && p[1] === 168) return false;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return false;
    if (p[0] === 198 && (p[1] === 18 || p[1] === 19)) return false;
    if (p[0] >= 224) return false; // multicast / reserved
    return true;
  }
  if (net.isIPv6(ip)) {
    const norm = ip.toLowerCase();
    if (norm === '::1' || norm === '::') return false;
    if (norm.startsWith('fc') || norm.startsWith('fd')) return false; // unique local
    if (/^fe[89ab]/.test(norm)) return false; // link-local
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(norm);
    if (mapped) return isPublicIp(mapped[1]);
    return true;
  }
  return false;
}

async function assertPublicUrl(url) {
  const parts = new URL(url);
  if (!['http:', 'https:'].includes(parts.protocol) || !parts.hostname) {
    throw new Error('unsupported url');
  }
  const infos = await dns.lookup(parts.hostname, { all: true });
  for (const info of infos) {
    if (!isPublicIp(info.address)) throw new Error('url resolves to non-public address');
  }
}

function b64Decode(data) {
  const cleaned = String(data).replace(/[^A-Za-z0-9+/=]/g, '');
  try {
    return Buffer.from(cleaned, 'base64');
  } catch {
    return null;
  }
}

export async function extractAndUploadFiles(messages, authToken, lastUserOnly = false) {
  const resultFileIds = [];
  let scan = messages;
  if (lastUserOnly) {
    for (let idx = messages.length - 1; idx >= 0; idx--) {
      if (messages[idx].role === 'user') {
        scan = messages.slice(idx);
        break;
      }
    }
  }
  for (const msg of scan) {
    const content = msg.content;
    if (!content || typeof content === 'string') continue;
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type === 'text') continue;

      if (part.type === 'image_url') {
        const url = part.image_url?.url;
        if (!url) continue;
        if (url.startsWith('http')) {
          await assertPublicUrl(url);
          const filename = new URL(url).pathname.split('/').filter(Boolean).pop() || 'image';
          const mimeType = guessMimeType(filename) || 'application/octet-stream';
          const resp = await fetch(url);
          const buf = Buffer.from(await resp.arrayBuffer());
          if (buf.length > 20 * 1024 * 1024) continue;
          for await (const [status, data] of uploadFile(buf, filename, mimeType, authToken)) {
            if (status === 'success') resultFileIds.push(data.file_id);
          }
        } else {
          const urlParts = url.split(',', 2);
          if (urlParts.length !== 2) continue;
          const [mimeBase, base64Data] = urlParts;
          const mimeType = mimeBase.split(':')[1]?.split(';')[0];
          if (!mimeType) continue;
          const filename = 'inline_uploaded_' + crypto.randomUUID() + guessExtension(mimeType);
          const dataBytes = b64Decode(base64Data.includes('data:') ? base64Data.split('data:')[1] : base64Data);
          if (!dataBytes) continue;
          for await (const [status, data] of uploadFile(dataBytes, filename, mimeType, authToken)) {
            if (status === 'success') resultFileIds.push(data.file_id);
          }
        }
      } else if (part.type === 'file') {
        const file = part.file || {};
        if (file.file_id) resultFileIds.push(file.file_id);
        if (file.file_data) {
          const filename = file.filename || 'file.bin';
          const dataParts = file.file_data.split(',', 2);
          if (dataParts.length !== 2) continue;
          const [mimeBase, base64Data] = dataParts;
          const mimeType = mimeBase.split(':')[1]?.split(';')[0];
          const dataBytes = b64Decode(base64Data.includes('data:') ? base64Data.split('data:')[1] : base64Data);
          if (!dataBytes) continue;
          for await (const [status, data] of uploadFile(dataBytes, filename, mimeType, authToken)) {
            if (status === 'success') resultFileIds.push(data.file_id);
          }
        }
      } else if (part.type === 'document' || part.type === 'image') {
        const source = part.source || {};
        if (source.type === 'base64') {
          const base64Data = source.data?.includes(',') ? source.data.split(',')[1] : source.data;
          const mimeType = source.media_type;
          const filename = 'inline_uploaded_' + crypto.randomUUID() + guessExtension(mimeType);
          const dataBytes = b64Decode(base64Data);
          if (!dataBytes) continue;
          for await (const [status, data] of uploadFile(dataBytes, filename, mimeType, authToken)) {
            if (status === 'success') resultFileIds.push(data.file_id);
          }
        } else if (source.type === 'file') {
          resultFileIds.push(source.file_id);
        }
      }
    }
  }
  return resultFileIds;
}

export function extractUserMsg(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      const content = messages[i].content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        const parts = content.filter((c) => c && typeof c === 'object' && c.type === 'text').map((c) => c.text || '');
        if (parts.length) return parts.join('\n');
      }
    }
  }
  return '';
}

// Drop the oldest parts until the total fits the token budget (always keeps the newest part).
function capParts(parts, maxTokens) {
  if (!parts.length) return [parts, false];
  const sizes = parts.map((p) => countTokens(p));
  let total = sizes.reduce((a, b) => a + b, 0);
  if (total <= maxTokens) return [parts, false];
  let drop = 0;
  while (total > maxTokens && drop < parts.length - 1) {
    total -= sizes[drop];
    drop++;
  }
  return [parts.slice(drop), true];
}

function cappedText(text, maxTokens, marker) {
  const [parts, truncated] = capParts(text.split('\n\n'), maxTokens);
  return (truncated ? marker + '\n' : '') + parts.join('\n\n');
}

export function canonicalizeMessages(messages) {
  const canon = [];
  for (const m of messages) {
    const role = m.role || '';
    let content = m.content ?? '';
    const toolCalls = m.tool_calls;

    if (toolCalls && Array.isArray(toolCalls) && toolCalls.length) {
      const tcParts = [];
      for (const tc of toolCalls) {
        const fn = tc.function || {};
        const name = fn.name || tc.name;
        let args = fn.arguments ?? tc.arguments;
        if (typeof args === 'string') {
          try { args = JSON.parse(args); } catch { /* keep string */ }
        }
        tcParts.push('<tool_call>' + stableStringify({ arguments: args, name }) + '</tool_call>');
      }
      content = tcParts.join('\n');
    } else if (Array.isArray(content)) {
      const parts = [];
      for (const c of content) {
        if (c && typeof c === 'object') {
          if (c.type === 'text') {
            parts.push(c.text || '');
          } else if (c.type === 'tool_use') {
            parts.push('<tool_call>' + stableStringify({ arguments: c.input ?? {}, name: c.name }) + '</tool_call>');
          } else if (c.type === 'tool_result') {
            let resContent = c.content ?? '';
            if (Array.isArray(resContent)) {
              resContent = resContent.filter((item) => item && typeof item === 'object' && item.type === 'text').map((item) => item.text || '').join(' ');
            }
            parts.push('[Tool Result for ' + String(c.tool_use_id || 'tool') + ']: ' + String(resContent));
          }
        }
      }
      content = parts.join('\n');
    } else if (typeof content === 'string') {
      content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      content = content.replace(/<tool_call>([\s\S]*?)<\/tool_call>/g, (match, rawJson) => {
        try {
          const d = JSON.parse(rawJson.trim());
          return '<tool_call>' + stableStringify({ arguments: d.arguments ?? {}, name: d.name }) + '</tool_call>';
        } catch {
          return match;
        }
      });
    }

    canon.push({ role, content: String(content).trim() });
  }
  return canon;
}

export function generateSignature(messages, model, scope = '') {
  let lastAstIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      lastAstIdx = i;
      break;
    }
  }
  const history = lastAstIdx === -1 ? messages : messages.slice(0, lastAstIdx + 1);
  const canonHistory = canonicalizeMessages(history);
  const dump = stableStringify(canonHistory);
  return crypto.createHash('sha256').update(`${model}_${scope}_${dump}`, 'utf-8').digest('hex');
}

const TOOL_INSTRUCTIONS =
  'TOOL USE INSTRUCTIONS:\n' +
  'You have access to tools. When you need to call a tool, output ONLY the tool call XML block and nothing else:\n' +
  '<tool_call>{"name": "tool_name", "arguments": {"param": "value"}}</tool_call>\n' +
  'Never repeat past messages, history, or XML tags. Output exactly one tool call block when invoking a tool.';

export function buildPrompt(messages, tools, model, isFirstMessage = false) {
  let finalPrompt = '';
  const toolsExtract = extractTools(tools);

  if (isFirstMessage) {
    if (toolsExtract) finalPrompt += `[TOOLS]\n${toolsExtract}\n\n`;
    let systemPrompt = extractSystem(messages);
    if (systemPrompt) {
      if (toolsExtract) systemPrompt += '\n\n' + TOOL_INSTRUCTIONS;
      finalPrompt += `[SYSTEM]\n${systemPrompt}\n\n`;
    } else if (toolsExtract) {
      finalPrompt += `[SYSTEM]\n${TOOL_INSTRUCTIONS}\n\n`;
    }

    if (messages.length > 1) {
      const historyParts = [];
      for (const msg of messages.slice(0, -1)) {
        const role = msg.role || 'unknown';
        if (role === 'system' || role === 'tool') continue;
        let content = msg.content ?? '';
        if (Array.isArray(content)) {
          content = content.filter((c) => c && typeof c === 'object' && c.type === 'text').map((c) => c.text || '').join(' ');
        }
        if (content) historyParts.push(`${role.toUpperCase()}: ${content}`);
      }
      if (historyParts.length) {
        const [capped, truncated] = capParts(historyParts, MAX_HISTORY_TOKENS);
        const marker = truncated ? '[... earlier conversation history truncated ...]\n' : '';
        finalPrompt += `[PREVIOUS CONVERSATION HISTORY]\n${marker}${capped.join('\n')}\n\n`;
      }
    }

    let toolsResultExtract = extractToolResults(messages, false);
    if (toolsResultExtract) {
      toolsResultExtract = cappedText(toolsResultExtract, MAX_TOOL_RESULTS_TOKENS, '[... earlier tool results truncated ...]');
      finalPrompt += `[TOOL RESULTS]\n${toolsResultExtract}\n\n`;
    }

    const userMsg = extractUserMsg(messages);
    if (userMsg) finalPrompt += `[USER]\n${userMsg}\n\n`;
  } else {
    let lastAstIdx = -1;
    for (let idx = messages.length - 1; idx >= 0; idx--) {
      if (messages[idx].role === 'assistant') {
        lastAstIdx = idx;
        break;
      }
    }
    const trailingMessages = lastAstIdx !== -1 ? messages.slice(lastAstIdx + 1) : [messages[messages.length - 1]];
    let toolsResultExtract = extractToolResults(messages, true);
    if (toolsResultExtract) {
      toolsResultExtract = cappedText(toolsResultExtract, MAX_TOOL_RESULTS_TOKENS, '[... earlier tool results truncated ...]');
      finalPrompt += `[TOOL RESULTS]\n${toolsResultExtract}\n\n`;
    }

    const trailingUserParts = [];
    for (const m of trailingMessages) {
      if (m.role === 'user') {
        const c = m.content ?? '';
        if (typeof c === 'string' && c) {
          trailingUserParts.push(c);
        } else if (Array.isArray(c)) {
          const txt = c.filter((p) => p && typeof p === 'object' && p.type === 'text').map((p) => p.text || '').join(' ');
          if (txt) trailingUserParts.push(txt);
        }
      }
    }

    if (trailingUserParts.length) {
      finalPrompt += `[USER]\n${trailingUserParts.join('\n')}\n\n`;
    } else if (!toolsResultExtract) {
      const userMsg = extractUserMsg(messages);
      if (userMsg) finalPrompt += `[USER]\n${userMsg}\n\n`;
    }

    if (toolsExtract) finalPrompt += TOOL_INSTRUCTIONS + '\n';
  }

  return finalPrompt;
}
