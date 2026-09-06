import { randomId, rawDecodeJson } from './util.js';

export function normalizeToolCall(toolDataOrName, argsIfName = undefined) {
  let name;
  let args;
  if (typeof toolDataOrName === 'string') {
    name = toolDataOrName;
    args = argsIfName !== undefined ? argsIfName : {};
  } else if (toolDataOrName && typeof toolDataOrName === 'object') {
    const toolData = toolDataOrName;
    if (toolData.function && typeof toolData.function === 'object') {
      const fn = toolData.function;
      name = fn.name || toolData.name;
      args = fn.arguments ?? fn.parameters ?? fn.input ?? fn.args ?? fn.params ?? {};
    } else {
      name = toolData.name || toolData.tool || toolData.tool_name ||
        (typeof toolData.function === 'string' ? toolData.function : null) || toolData.action;
      args = toolData.arguments ?? toolData.parameters ?? toolData.input ?? toolData.args ??
        toolData.params ?? toolData.tool_input ?? toolData.action_input ?? {};
    }
  } else {
    return null;
  }

  if (!name || typeof name !== 'string') return null;
  let argsStr;
  if (args && typeof args === 'object') {
    argsStr = JSON.stringify(args);
  } else if (typeof args === 'string') {
    argsStr = args;
    try {
      JSON.parse(argsStr);
    } catch {
      argsStr = JSON.stringify(argsStr);
    }
  } else {
    argsStr = '{}';
  }
  return {
    id: randomId('call_', 8),
    type: 'function',
    function: { name: name.trim(), arguments: argsStr },
  };
}

export function cleanJsonStr(s) {
  s = s.trim();
  if (s.startsWith('```json')) s = s.slice(7);
  else if (s.startsWith('```')) s = s.slice(3);
  if (s.endsWith('```')) s = s.slice(0, -3);
  return s.trim();
}

// Spans of markdown fenced code blocks; tool-call markup inside a fence is
// documentation/example text, not an actual tool call. Unclosed fences extend to EOF.
function codeFenceSpans(text) {
  return [...text.matchAll(/```.*?(?:```|$)/gs)].map((m) => [m.index, m.index + m[0].length]);
}

export function parseTools(text) {
  let tools = [];
  let cleanText = text;
  const fenceSpans = codeFenceSpans(text);
  const fenced = (pos) => fenceSpans.some(([s, e]) => s <= pos && pos < e);

  const paramNames = new Set(['command', 'description', 'file_path', 'content', 'path', 'prompt', 'query', 'subject', 'old_string', 'new_string', 'url', 'input']);
  const toolMatches = [...text.matchAll(/<[｜|]{0,2}(?:DSML[｜|]{0,2})?(?:tool_call|invoke|function_call)\s+(?:name|tool)=['"]([^'"]+)['"][^>]*>/gi)];
  const realToolMatches = toolMatches.filter((tm) => !fenced(tm.index));

  if (realToolMatches.length) {
    for (let i = 0; i < realToolMatches.length; i++) {
      const tm = realToolMatches[i];
      const candidateName = tm[1].trim();
      const startIdx = tm.index + tm[0].length;
      const endIdx = i + 1 < realToolMatches.length ? realToolMatches[i + 1].index : text.length;
      const body = text.slice(startIdx, endIdx);
      const args = {};
      const pRe = /<[｜|]{0,2}(?:DSML[｜|]{0,2})?(?:parameter|tool_call|param|invoke)\s+name=['"]([^'"]+)['"][^>]*>([\s\S]*?)(?:<\/[｜|]{0,2}(?:DSML[｜|]{0,2})?(?:parameter|tool_call|param|invoke)>|(?=<[｜|]{0,2}(?:DSML[｜|]{0,2})?(?:parameter|tool_call|param|invoke)\s+name=)|$)/gi;
      for (const pm of body.matchAll(pRe)) {
        const pName = pm[1].trim();
        let pVal = pm[2].trim().replace(/<\/?(?:tool_calls?|invoke|function_call|parameter|param)\b[^>]*>/gi, '').trim();
        try {
          args[pName] = JSON.parse(pVal);
        } catch {
          args[pName] = pVal;
        }
      }
      const tagRe = /<([A-Za-z0-9_-]+)>([\s\S]*?)(?:<\/\1>|$)/gi;
      for (const pm of body.matchAll(tagRe)) {
        const tName = pm[1].trim().toLowerCase();
        if (paramNames.has(tName)) {
          let tVal = pm[2].trim().replace(/<\/?(?:tool_calls?|invoke|function_call|parameter|param)\b[^>]*>/gi, '').trim();
          try {
            args[tName] = JSON.parse(tVal);
          } catch {
            args[tName] = tVal;
          }
        }
      }
      if (candidateName) {
        const norm = normalizeToolCall(candidateName, args);
        if (norm) tools.push(norm);
      }
    }
  }

  if (tools.length) {
    cleanText = cleanText.replace(/<[｜|]{0,2}(?:DSML[｜|]{0,2})?tool_calls?[^>]*>[\s\S]*?(?:<\/[｜|]{0,2}(?:DSML[｜|]{0,2})?tool_calls?>|$)/gi, '').trim();
    cleanText = cleanText.replace(/<[｜|]{0,2}(?:DSML[｜|]{0,2})?(?:invoke|function_call)[^>]*>[\s\S]*?(?:<\/[｜|]{0,2}(?:DSML[｜|]{0,2})?(?:invoke|function_call)>|$)/gi, '').trim();
  }

  if (!tools.length && text.includes('DSML')) {
    const dsmlBlockPattern = /<[｜|]{2}DSML[｜|]{2}([A-Za-z0-9_]+)>([\s\S]*?)(?:<\/[｜|]{2}DSML[｜|]{2}\1>|$)/gi;
    const paramPatternB = /<[｜|]{2}DSML[｜|]{2}B([A-Za-z0-9_]+)[^>]*>([\s\S]*?)(?:<\/[｜|]{2}DSML[｜|]{2}B.*?>|$)/gi;
    for (const m of text.matchAll(dsmlBlockPattern)) {
      if (fenced(m.index)) continue;
      const toolName = m[1].trim();
      const body = m[2];
      const args = {};
      for (const pm of body.matchAll(paramPatternB)) {
        const pName = pm[1].toLowerCase().trim();
        const pVal = pm[2].trim();
        try {
          args[pName] = JSON.parse(pVal);
        } catch {
          args[pName] = pVal;
        }
      }
      const norm = normalizeToolCall(toolName, args);
      if (norm) tools.push(norm);
    }
    if (!tools.length) {
      const toolMatch = /[｜|]{2}DSML[｜|]{2}(Bash|Read|Write|Edit|Agent|TaskList|TaskCreate|WebSearch|[A-Za-z0-9_]+)/i.exec(text);
      if (toolMatch && !fenced(toolMatch.index)) {
        const candidate = toolMatch[1].trim();
        const toolName = candidate.toLowerCase().startsWith('b') && !['bdescription', 'bparam'].includes(candidate.toLowerCase()) ? 'Bash' : candidate;
        const args = {};
        const cmdMatch = /[｜|]{2}B["']?command["']?[^>]*>([\s\S]*?)(?:<\/[｜|]{2}B|$)/i.exec(text);
        const descMatch = /[｜|]{2}B["']?description["']?[^>]*>([\s\S]*?)(?:<\/[｜|]{2}B|$)/i.exec(text);
        if (cmdMatch) {
          args.command = cmdMatch[1].replace(/<\/?[｜|]{2}DSML[｜|]{2}[^>]*>/g, '').replace(/^[\s"'()]+|[\s"'()]+$/g, '');
        }
        if (descMatch) {
          args.description = descMatch[1].replace(/<\/?[｜|]{2}DSML[｜|]{2}[^>]*>/g, '').replace(/^[\s"'()]+|[\s"'()]+$/g, '');
        }
        const norm = normalizeToolCall(toolName, args);
        if (norm) tools.push(norm);
      }
    }
    if (tools.length) {
      cleanText = cleanText.replace(/<[｜|]{2}DSML[｜|]{2}[^>]*>[\s\S]*?(?:<\/[｜|]{2}DSML[｜|]{2}[^>]*>|$)/gi, '').trim();
      cleanText = cleanText.replace(/<\/?[｜|]{2}DSML[｜|]{2}[^>]*>/gi, '').trim();
    }
  }

  if (!tools.length) {
    const fnCallPattern = /<function_call>\s*<name>([^<]+)<\/name>\s*<arguments>([\s\S]*?)<\/arguments>\s*<\/function_call>/gi;
    for (const m of text.matchAll(fnCallPattern)) {
      if (fenced(m.index)) continue;
      const name = m[1].trim();
      const argsRaw = m[2].trim();
      let args;
      try {
        args = JSON.parse(argsRaw);
      } catch {
        args = argsRaw;
      }
      const norm = normalizeToolCall(name, args);
      if (norm) tools.push(norm);
    }
    if (tools.length) {
      cleanText = cleanText.replace(/<function_call>[\s\S]*?<\/function_call>/gi, '').trim();
    }
  }

  if (!tools.length) {
    const tagRegex = /<(?:tool_call|function_call)(?:\s+(?:name|tool|function)=['"]([^'"]+)['"])?\s*>/gi;
    const matches = [...text.matchAll(tagRegex)].filter((m) => !fenced(m.index));
    if (matches.length) {
      for (const m of matches) {
        const tagName = m[1];
        const afterTag = text.slice(m.index + m[0].length);
        const bracePos = afterTag.indexOf('{');
        if (bracePos !== -1) {
          const jsonSubstr = afterTag.slice(bracePos);
          let data = null;
          try {
            [data] = rawDecodeJson(jsonSubstr);
          } catch {
            // try a cleaned-up / brace-balanced version below
          }
          if (!data) {
            let cleanedJson = jsonSubstr.replace(/<\/?(?:tool_call|function_call|tool_calls|invoke)[^>]*>[\s\S]*/g, '').trim();
            const openB = (cleanedJson.match(/\{/g) || []).length;
            const closeB = (cleanedJson.match(/\}/g) || []).length;
            if (openB > closeB) cleanedJson += '}'.repeat(openB - closeB);
            try {
              data = JSON.parse(cleanedJson);
            } catch {
              // not parseable
            }
          }
          if (data && typeof data === 'object' && !Array.isArray(data)) {
            let name;
            let args;
            if (tagName) {
              name = tagName;
              if (data.arguments && typeof data.arguments === 'object') args = data.arguments;
              else if (data.parameters && typeof data.parameters === 'object') args = data.parameters;
              else if (data.input && typeof data.input === 'object') args = data.input;
              else args = Object.fromEntries(Object.entries(data).filter(([k]) => !['name', 'tool', 'function'].includes(k)));
            } else {
              name = data.name || data.tool || data.tool_name ||
                (typeof data.function === 'string' ? data.function : null) || data.action;
              args = data.arguments ?? data.parameters ?? data.input ?? data.args ?? data.params ?? data.tool_input ?? data.action_input;
              if (args == null) args = {};
            }
            if (name) {
              const norm = normalizeToolCall(name, args);
              if (norm) tools.push(norm);
            }
          }
        }
      }
      cleanText = text.replace(/<(?:tool_call|function_call)[^>]*>[\s\S]*?(?:<\/(?:tool_call|function_call)>|$)/g, '').trim();
    }
  }

  if (!tools.length) {
    const codeblockPattern = /```(?:tool_call|function_call)\s*([\s\S]*?)\s*```/g;
    for (const m of cleanText.matchAll(codeblockPattern)) {
      const cleaned = cleanJsonStr(m[1]);
      try {
        const data = JSON.parse(cleaned);
        if (data && typeof data === 'object') {
          const name = data.name || data.tool || (typeof data.function === 'string' ? data.function : null) || data.action;
          const args = data.arguments ?? data.parameters ?? data.input ?? data.args ?? {};
          const norm = normalizeToolCall(name, args);
          if (norm) tools.push(norm);
        }
      } catch {
        // not JSON
      }
    }
    if (tools.length) {
      cleanText = cleanText.replace(codeblockPattern, '').trim();
    }
  }

  if (!tools.length) {
    const jsonPattern = /```json\s*(\{[\s\S]*?\})\s*```/g;
    for (const m of cleanText.matchAll(jsonPattern)) {
      const cleaned = cleanJsonStr(m[1]);
      try {
        const data = JSON.parse(cleaned);
        if (data && typeof data === 'object' && ('name' in data || 'tool' in data || 'function' in data)) {
          const name = data.name || data.tool || (typeof data.function === 'string' ? data.function : null) || data.action;
          const args = data.arguments ?? data.parameters ?? data.input ?? data.args ?? {};
          const norm = normalizeToolCall(name, args);
          if (norm) tools.push(norm);
        }
      } catch {
        // not JSON
      }
    }
    if (tools.length) {
      cleanText = cleanText.replace(jsonPattern, '').trim();
    }
  }

  // The tool-call blocks themselves were already removed above; only leftover
  // bare tags are stripped here, so companion text is kept.
  cleanText = cleanText.replace(/<\/?(?:tool_calls?|invoke|function_call|parameter)[^>]*>/gi, '').trim();
  return [tools, cleanText];
}

export class StreamToolParser {
  constructor() {
    this.buffer = '';
    this.inTool = false;
    this.hasTool = false;
    this.jsonDone = false;
  }

  feed(chunk) {
    this.buffer += chunk;
    const results = [];
    for (;;) {
      if (this.inTool) {
        const endTags = ['</tool_call>', '</function_call>', '</invoke>', '</tool_calls>'];
        let endPos = -1;
        let endTagLen = 0;
        for (const tag of endTags) {
          const idx = this.buffer.indexOf(tag);
          if (idx !== -1 && (endPos === -1 || idx < endPos)) {
            endPos = idx;
            endTagLen = tag.length;
          }
        }
        if (endPos !== -1) {
          if (!this.jsonDone) {
            const toolXml = this.buffer.slice(0, endPos + endTagLen);
            const [parsed] = parseTools(toolXml);
            for (const item of parsed) results.push({ tool: item });
          }
          this.buffer = this.buffer.slice(endPos + endTagLen);
          this.inTool = false;
          this.jsonDone = false;
          continue;
        }
        const braceIdx = this.buffer.indexOf('{');
        if (braceIdx !== -1 && !this.jsonDone) {
          try {
            const [data, consumed] = rawDecodeJson(this.buffer.slice(braceIdx));
            const norm = normalizeToolCall(data);
            if (norm) {
              results.push({ tool: norm });
              this.jsonDone = true;
              this.buffer = this.buffer.slice(braceIdx + consumed);
              continue;
            }
          } catch {
            // incomplete JSON; wait for more chunks
          }
        }
        break;
      } else {
        const startTags = ['<tool_call', '<function_call', '<invoke', '<tool_calls'];
        let startPos = -1;
        for (const tag of startTags) {
          const idx = this.buffer.indexOf(tag);
          if (idx !== -1 && (startPos === -1 || idx < startPos)) startPos = idx;
        }
        if (startPos !== -1) {
          if (startPos > 0) results.push({ text: this.buffer.slice(0, startPos) });
          this.buffer = this.buffer.slice(startPos);
          this.inTool = true;
          this.hasTool = true;
          continue;
        }
        let hold = 0;
        for (const tag of startTags) {
          for (let i = 1; i < tag.length; i++) {
            if (this.buffer.endsWith(tag.slice(0, i))) hold = Math.max(hold, i);
          }
        }
        if (hold) {
          const textPart = this.buffer.slice(0, -hold);
          if (textPart) results.push({ text: textPart });
          this.buffer = this.buffer.slice(-hold);
        } else {
          if (this.buffer) results.push({ text: this.buffer });
          this.buffer = '';
        }
        break;
      }
    }
    return results;
  }

  flush() {
    const out = [];
    if (this.buffer && !this.inTool) {
      out.push({ text: this.buffer });
    } else if (this.inTool) {
      const stripped = this.buffer.replace(/<\/?[｜|]{0,2}(?:DSML[｜|]{0,2})?(?:tool_call|invoke|function_call|parameter)[^>]*>/gi, '').trim();
      if (stripped) out.push({ text: stripped });
    }
    this.buffer = '';
    return out;
  }
}
