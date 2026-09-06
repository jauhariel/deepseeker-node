import crypto from 'node:crypto';
import {
  getAuthToken, getToken, pickToken, findSession, saveSession, deleteSessionsForChat,
  markActive, markLimited, nextParent, DEEPSEEK_TARIFFS, logUsage,
} from './db.js';
import { createNewChat, sendMessage } from './deepseek.js';
import { buildPrompt, extractAndUploadFiles, generateSignature } from './prompt.js';
import { parseTools, StreamToolParser } from './tools.js';
import { countTokens, Mutex } from './util.js';

class HttpError extends Error {}

function httpCode(e) {
  const m = /^HTTP (\d{3}):/.exec(String(e.message || e));
  return m ? parseInt(m[1], 10) : null;
}

export function apiErrorPayload(e, isAnthropic = false) {
  const m = /^HTTP (\d{3}):/.exec(String(e.message || e));
  let code = m ? parseInt(m[1], 10) : 502;
  if (code < 400 || code > 599) code = 502;
  const message = String(e.message || e).slice(0, 500);
  if (isAnthropic) {
    return [code, { type: 'error', error: { type: 'api_error', message } }];
  }
  return [code, { error: { message, type: 'api_error', code } }];
}

// Consume the first chunk eagerly so upstream errors surface before streaming starts.
async function preflightStream(gen) {
  const first = await gen.next();
  return (async function* () {
    if (!first.done) yield first.value;
    yield* gen;
  })();
}

async function collectResponse(gen) {
  let text = '';
  for await (const chunk of gen) text += chunk;
  return text;
}

function messagesText(messages) {
  const parts = [];
  for (const m of messages) {
    const c = m.content ?? '';
    if (Array.isArray(c)) {
      parts.push(c.filter((p) => p && typeof p === 'object' && p.type === 'text').map((p) => p.text || '').join(' '));
    } else {
      parts.push(String(c));
    }
  }
  return parts.join('\n');
}

function stripThinkAndTags(cleanText) {
  return cleanText
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .trim()
    .replace(/<\/?(?:tool_calls?|invoke|function_call|parameter)[^>]*>/gi, '')
    .trim();
}

export function computeCost(model, inTokens, outTokens) {
  const tariffKey = model === 'expert' ? 'deepseek-v4-pro' : model === 'vision' ? 'deepseek-v4-flash-exp' : 'deepseek-v4-flash';
  const tariff = DEEPSEEK_TARIFFS[tariffKey];
  return (inTokens / 1_000_000) * tariff.cache_miss_input + (outTokens / 1_000_000) * tariff.output_generation;
}

// Save both the current signature and the next-turn signature (current history +
// the assistant reply just produced) so the next request resumes this session.
function saveSessionPair(sig, tokenId, sessionId, parentMessageId, messages, parsedTools, cleanText, model, scope) {
  const nextMessages = [...messages];
  const astMsg = { role: 'assistant' };
  if (parsedTools.length) astMsg.tool_calls = parsedTools;
  else astMsg.content = cleanText;
  nextMessages.push(astMsg);
  const nextSig = generateSignature(nextMessages, model, scope);
  saveSession(sig, tokenId, sessionId, nextParent(parentMessageId));
  saveSession(nextSig, tokenId, sessionId, nextParent(parentMessageId));
}

const sigLocks = new Map();

function lockFor(sig) {
  let lock = sigLocks.get(sig);
  if (!lock) {
    lock = new Mutex();
    sigLocks.set(sig, lock);
  }
  return lock;
}

export async function handleChat(opts) {
  const { messages, model, thinking = false, search = false, stream = false, tools = null, isAnthropic = false, reqModel = null, scope = '', _retried = false, endpoint = 'unknown' } = opts;
  const authToken = getAuthToken();
  if (!authToken) {
    return { status: 401, json: { error: 'No auth token. Add via dashboard.' } };
  }

  const sig = generateSignature(messages, model, scope);
  let sess = findSession(sig);
  let tokenId, sessionId, parentMessageId;

  if (sess) {
    tokenId = sess.token_id;
    sessionId = sess.session_id;
    parentMessageId = sess.parent_message_id;
    const tok = getToken(tokenId);
    if (!tok || tok.status === 'RATE_LIMITED') {
      // Fail over to a fresh token: new web chat session + full history injection.
      const newTokenId = pickToken();
      if (newTokenId && (!tok || newTokenId !== tokenId)) {
        const newTok = getToken(newTokenId);
        if (newTok) {
          let gen;
          try {
            deleteSessionsForChat(tokenId, sessionId);
            const newSessionId = await createNewChat(newTok.token);
            const prompt = buildPrompt(messages, tools || [], model, true);
            const fileIds = await extractAndUploadFiles(messages, newTok.token);
            gen = await preflightStream(sendMessage(newSessionId, newTok.token, prompt, 0, thinking, search, model === 'instant' ? null : model, fileIds));
            if (stream) {
              return { stream: isAnthropic
                ? streamAnthropicResponse(gen, model, messages, newTokenId, newSessionId, sig, tools, reqModel, 0, scope, endpoint)
                : streamResponse(gen, model, messages, newTokenId, newSessionId, sig, tools, 0, scope, endpoint) };
            }
            const respText = await collectResponse(gen);
            markActive(newTokenId);
            const [parsedTools, cleanText] = parseTools(respText);
            const stripped = stripThinkAndTags(cleanText);
            saveSessionPair(sig, newTokenId, newSessionId, 0, messages, parsedTools, stripped, model, scope);
            const payload = formatResponse(respText, model, messages, tools);
            logUsage({ apiKey: scope || 'unknown', endpoint, model, promptTokens: payload.usage.prompt_tokens, completionTokens: payload.usage.completion_tokens, cost: payload.usage.cost });
            return { status: 200, json: payload };
          } catch (e) {
            if (_retried) {
              const [code, payload] = apiErrorPayload(e, isAnthropic);
              return { status: code, json: payload };
            }
            return handleChat({ ...opts, _retried: true });
          }
        }
      }
      return { status: 429, json: { error: { message: 'No active tokens available (all rate limited). Try again later.', type: 'rate_limit_error' } } };
    }
  } else {
    // Lock-protected session creation so concurrent identical requests don't
    // spawn duplicate web chat sessions.
    await lockFor(sig).run(async () => {
      sess = findSession(sig);
      if (!sess) {
        tokenId = pickToken();
        if (!tokenId) return;
        const tok = getToken(tokenId);
        if (!tok) return;
        sessionId = await createNewChat(tok.token);
        saveSession(sig, tokenId, sessionId, 0);
        parentMessageId = 0;
      } else {
        tokenId = sess.token_id;
        sessionId = sess.session_id;
        parentMessageId = sess.parent_message_id;
      }
    });
    if (!tokenId) return { status: 503, json: { error: 'No tokens available' } };
    if (!sessionId) return { status: 503, json: { error: 'Token not found' } };
  }

  const tok = getToken(tokenId);
  if (!tok) return { status: 503, json: { error: 'Token expired' } };

  const isFirst = parentMessageId === 0;
  try {
    const fileIds = await extractAndUploadFiles(messages, tok.token, !isFirst);
    const prompt = buildPrompt(messages, tools || [], model, isFirst);

    let gen = sendMessage(sessionId, tok.token, prompt, parentMessageId, thinking, search, model === 'instant' ? null : model, fileIds);
    gen = await preflightStream(gen);
    if (stream) {
      return { stream: isAnthropic
        ? streamAnthropicResponse(gen, model, messages, tokenId, sessionId, sig, tools, reqModel, parentMessageId, scope, endpoint)
        : streamResponse(gen, model, messages, tokenId, sessionId, sig, tools, parentMessageId, scope, endpoint) };
    }
    const respText = await collectResponse(gen);
    markActive(tokenId);

    const [parsedTools, cleanText] = parseTools(respText);
    const stripped = stripThinkAndTags(cleanText);
    saveSessionPair(sig, tokenId, sessionId, parentMessageId, messages, parsedTools, stripped, model, scope);
    const payload = formatResponse(respText, model, messages, tools);
    logUsage({ apiKey: scope || 'unknown', endpoint, model, promptTokens: payload.usage.prompt_tokens, completionTokens: payload.usage.completion_tokens, cost: payload.usage.cost });
    return { status: 200, json: payload };
  } catch (e) {
    const code = httpCode(e);
    if ([401, 403, 429].includes(code)) markLimited(tokenId);
    deleteSessionsForChat(tokenId, sessionId);
    if (_retried) {
      const [status, payload] = apiErrorPayload(e, isAnthropic);
      return { status, json: payload };
    }
    if (![401, 403, 429].includes(code) && parentMessageId === 0) {
      const [status, payload] = apiErrorPayload(e, isAnthropic);
      return { status, json: payload };
    }
    return handleChat({ ...opts, _retried: true });
  }
}

// Hold back partial "<think>"/"</think>" tag suffixes so tags split across chunk
// boundaries are reassembled without truncation.
async function* holdThinkTags(gen) {
  let carry = '';
  for await (let chunk of gen) {
    chunk = carry + chunk;
    carry = '';
    let hold = 0;
    for (const tag of ['<think>', '</think>']) {
      for (let i = 1; i < tag.length; i++) {
        if (chunk.endsWith(tag.slice(0, i))) hold = Math.max(hold, i);
      }
    }
    if (hold) {
      carry = chunk.slice(-hold);
      chunk = chunk.slice(0, -hold);
    }
    if (chunk) yield chunk;
  }
  if (carry) yield carry;
}

const sseData = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

export async function* streamResponse(gen, model, messages, tokenId, sessionId, sig, tools, parentMessageId = 0, scope = '', endpoint = 'unknown') {
  const parser = new StreamToolParser();
  let fullText = '';
  let isThinking = false;
  let aborted = false;
  let failed = false;
  try {
    for await (let chunk of holdThinkTags(gen)) {
      if (!chunk) continue;
      fullText += chunk;

      if (chunk.includes('<think>')) {
        isThinking = true;
        chunk = chunk.replace('<think>', '').replace(/^\n+/, '');
      }

      let endThinking = false;
      if (chunk.includes('</think>')) {
        isThinking = false;
        endThinking = true;
        const parts = chunk.split('</think>');
        const thinkPart = parts[0];
        chunk = parts.length > 1 ? parts[1].replace(/^\n+/, '') : '';
        if (thinkPart) {
          yield sseData({ choices: [{ delta: { reasoning_content: thinkPart } }] });
        }
      }

      if (isThinking && chunk) {
        yield sseData({ choices: [{ delta: { reasoning_content: chunk } }] });
        continue;
      }

      if (endThinking && !chunk) continue;

      for (const r of parser.feed(chunk)) {
        if ('text' in r) {
          yield sseData({ choices: [{ delta: { content: r.text } }] });
        }
      }
    }
    markActive(tokenId);
  } catch (e) {
    failed = true;
    const code = httpCode(e);
    if ([401, 403, 429].includes(code)) markLimited(tokenId);
    console.error('streamResponse failed:', e);
    try {
      yield sseData({ error: { message: String(e.message || e).slice(0, 300) } });
    } catch { /* client disconnected */ }
  } finally {
    const [parsedTools, cleanTextRaw] = parseTools(fullText);
    const cleanText = stripThinkAndTags(cleanTextRaw);

    if (!failed) {
      saveSessionPair(sig, tokenId, sessionId, parentMessageId, messages, parsedTools, cleanText, model, scope);
      const inTokens = countTokens(messagesText(messages));
      const outTokens = countTokens(fullText);
      logUsage({ apiKey: scope || 'unknown', endpoint, model, promptTokens: inTokens, completionTokens: outTokens, cost: computeCost(model, inTokens, outTokens) });
    }

    if (!aborted && !failed) {
      try {
        if (!parsedTools.length) {
          for (const r of parser.flush()) {
            if ('text' in r) {
              yield sseData({ choices: [{ delta: { content: r.text } }] });
            }
          }
        }

        if (parsedTools.length) {
          for (let i = 0; i < parsedTools.length; i++) {
            const tc = parsedTools[i];
            const deltaTc = { index: i, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } };
            yield sseData({ choices: [{ delta: { tool_calls: [deltaTc] } }] });
          }
          yield sseData({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
        } else {
          yield sseData({ choices: [{ delta: {}, finish_reason: 'stop' }] });
        }
        yield 'data: [DONE]\n\n';
      } catch { /* client disconnected mid-flush */ }
    }
  }
}

export async function* streamAnthropicResponse(gen, model, messages, tokenId, sessionId, sig, tools, reqModel = null, parentMessageId = 0, scope = '', endpoint = 'unknown') {
  const msgId = `msg_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const inTokens = countTokens(messagesText(messages));
  const modelName = reqModel || model;
  yield `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', content: [], model: modelName, stop_reason: null, stop_sequence: null, usage: { input_tokens: inTokens, output_tokens: 1 } } })}\n\n`;

  const parser = new StreamToolParser();
  let fullText = '';
  let textBlockStarted = false;
  let blockIndex = 0;
  let aborted = false;
  let failed = false;
  let isThinking = false;

  try {
    for await (let chunk of holdThinkTags(gen)) {
      if (!chunk) continue;
      fullText += chunk;

      if (chunk.includes('<think>')) {
        isThinking = true;
        chunk = chunk.replace('<think>', '').replace(/^\n+/, '');
        yield `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: blockIndex, content_block: { type: 'thinking' } })}\n\n`;
      }

      let endThinking = false;
      if (chunk.includes('</think>')) {
        isThinking = false;
        endThinking = true;
        const parts = chunk.split('</think>');
        const thinkPart = parts[0];
        chunk = parts.length > 1 ? parts[1].replace(/^\n+/, '') : '';
        if (thinkPart) {
          yield `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: blockIndex, delta: { type: 'thinking_delta', thinking: thinkPart } })}\n\n`;
        }
      }

      if (isThinking && chunk) {
        yield `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: blockIndex, delta: { type: 'thinking_delta', thinking: chunk } })}\n\n`;
        continue;
      }

      if (endThinking) {
        yield `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: blockIndex })}\n\n`;
        blockIndex++;
        if (!chunk) continue;
      }

      for (const r of parser.feed(chunk)) {
        if ('text' in r) {
          if (!textBlockStarted) {
            yield `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } })}\n\n`;
            textBlockStarted = true;
          }
          yield `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: r.text } })}\n\n`;
        }
      }
    }
    markActive(tokenId);
  } catch (e) {
    failed = true;
    const code = httpCode(e);
    if ([401, 403, 429].includes(code)) markLimited(tokenId);
    console.error('streamAnthropicResponse failed:', e);
    try {
      yield `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: String(e.message || e).slice(0, 300) } })}\n\n`;
    } catch { /* client disconnected */ }
  } finally {
    const [parsedTools, cleanTextRaw] = parseTools(fullText);
    const outTokens = countTokens(fullText);
    const cleanText = stripThinkAndTags(cleanTextRaw);

    if (!failed) {
      saveSessionPair(sig, tokenId, sessionId, parentMessageId, messages, parsedTools, cleanText, model, scope);
      logUsage({ apiKey: scope || 'unknown', endpoint, model, promptTokens: inTokens, completionTokens: outTokens, cost: computeCost(model, inTokens, outTokens) });
    }

    let idx = blockIndex;
    let tailEvents = '';
    const textBlock = (text) =>
      `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } })}\n\n` +
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text } })}\n\n` +
      `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}\n\n`;

    if (isThinking) {
      tailEvents += `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}\n\n`;
      idx++;
    }

    let flushedText = '';
    if (!parsedTools.length) {
      for (const r of parser.flush()) {
        if ('text' in r) flushedText += r.text;
      }
    }

    if (!textBlockStarted && !parsedTools.length && (cleanText || flushedText)) {
      tailEvents += textBlock(cleanText || flushedText);
    } else if (textBlockStarted && !parsedTools.length) {
      tailEvents += `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}\n\n`;
    }

    if (parsedTools.length) {
      for (const tc of parsedTools) {
        const toolInput = typeof tc.function.arguments === 'string' ? JSON.parse(tc.function.arguments) : tc.function.arguments;
        const jsonStr = JSON.stringify(toolInput);
        tailEvents += `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: tc.id, name: tc.function.name, input: {} } })}\n\n`;
        tailEvents += `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: jsonStr } })}\n\n`;
        tailEvents += `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}\n\n`;
        idx++;
      }
      tailEvents += `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: outTokens } })}\n\n`;
    } else {
      tailEvents += `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: outTokens } })}\n\n`;
    }
    tailEvents += `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`;

    if (!aborted && !failed) {
      try {
        for (const evt of tailEvents.split('\n\n')) {
          if (evt.trim()) yield evt + '\n\n';
        }
      } catch { /* client disconnected mid-flush */ }
    }
  }
}

export function formatResponse(text, model, messages, tools = null) {
  const [parsedTools, cleanTextRaw] = parseTools(text);

  let reasoning = null;
  const match = /<think>\s*([\s\S]*?)\s*<\/think>\s*/.exec(text);
  if (match) reasoning = match[1].trim();
  const cleanText = stripThinkAndTags(cleanTextRaw);

  const inTokens = countTokens(messagesText(messages));
  const outTokens = countTokens(text);
  const cost = computeCost(model, inTokens, outTokens);

  const msgDict = {
    role: 'assistant',
    content: parsedTools.length ? null : cleanText,
    tool_calls: parsedTools.length ? parsedTools : null,
  };
  if (reasoning) msgDict.reasoning_content = reasoning;

  return {
    id: `chatcmpl-${crypto.randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: msgDict,
      finish_reason: parsedTools.length ? 'tool_calls' : 'stop',
    }],
    usage: {
      prompt_tokens: inTokens,
      completion_tokens: outTokens,
      total_tokens: inTokens + outTokens,
      cost: Math.round(cost * 1e6) / 1e6,
    },
  };
}

export function formatAnthropicResponse(result, model) {
  const choice = result.choices[0];
  const msg = choice.message;
  const antContent = [];

  if (msg.reasoning_content) {
    antContent.push({ type: 'thinking', thinking: msg.reasoning_content });
  }
  if (msg.content) {
    antContent.push({ type: 'text', text: msg.content });
  }
  if (msg.tool_calls) {
    for (const tc of msg.tool_calls) {
      const args = tc.function.arguments;
      const toolInput = typeof args === 'string' ? JSON.parse(args) : args;
      antContent.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input: toolInput });
    }
  }
  const usage = result.usage || {};
  let msgId = result.id;
  if (!msgId.startsWith('msg_')) msgId = `msg_${msgId.replace('chatcmpl-', '')}`;
  return {
    id: msgId,
    type: 'message',
    role: 'assistant',
    content: antContent,
    model,
    stop_reason: msg.tool_calls ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: usage.prompt_tokens ?? 0,
      output_tokens: usage.completion_tokens ?? 0,
    },
  };
}
