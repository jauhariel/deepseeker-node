// Small shared helpers.

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Approximate token count. The original Python project uses the deepseek-tokenizer
// BPE; there is no maintained Node port, so we estimate (~4 chars/token for Latin
// text, ~1.5 chars/token for CJK). Cost figures in responses are informational only.
export function countTokens(text) {
  if (!text) return 0;
  const s = String(text);
  let cjk = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3000 && code <= 0x30ff) ||
      (code >= 0xff00 && code <= 0xffef) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjk++;
    }
  }
  const rest = s.length - cjk;
  return Math.ceil(rest / 4 + cjk / 1.5);
}

// Minimal promise-chain mutex (serializes async critical sections).
export class Mutex {
  constructor() {
    this._tail = Promise.resolve();
    this._active = 0;
  }
  get busy() {
    return this._active > 0;
  }
  async run(fn) {
    this._active++;
    const result = this._tail.then(() => fn());
    this._tail = result.then(
      () => undefined,
      () => undefined
    );
    try {
      return await result;
    } finally {
      this._active--;
    }
  }
}

// Equivalent of Python's json.JSONDecoder().raw_decode: parse the first JSON value
// at the start of `s` and return [value, consumedLength]. Throws if none.
export function rawDecodeJson(s) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') {
      depth--;
      if (depth === 0) {
        return [JSON.parse(s.slice(0, i + 1)), i + 1];
      }
    }
  }
  throw new Error('no complete JSON value at start of string');
}

// Emulate Python's json.dumps(str) with ensure_ascii=True.
function pyJsonString(s) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    const ch = s[i];
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (code < 0x20 || code > 0x7e) out += '\\u' + code.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

// Equivalent of Python's json.dumps(value, sort_keys=True) (default separators
// ", " / ": ", ensure_ascii=True), so signatures match the Python implementation.
export function stableStringify(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(', ') + ']';
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => pyJsonString(k) + ': ' + stableStringify(value[k])).join(', ') + '}';
  }
  if (typeof value === 'string') return pyJsonString(value);
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return JSON.stringify(value);
}

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.ts': 'text/typescript',
  '.json': 'application/json', '.csv': 'text/csv', '.xml': 'application/xml',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.py': 'text/x-python', '.java': 'text/x-java', '.c': 'text/x-c', '.cpp': 'text/x-c++',
};

const EXT_BY_MIME = Object.fromEntries(Object.entries(MIME_BY_EXT).map(([ext, mime]) => [mime, ext]));

export function guessMimeType(filename) {
  const m = /\.([A-Za-z0-9]+)$/.exec(filename || '');
  if (!m) return null;
  return MIME_BY_EXT['.' + m[1].toLowerCase()] || null;
}

export function guessExtension(mimeType) {
  return EXT_BY_MIME[mimeType] || '.bin';
}

export function randomId(prefix, len = 8) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return prefix + out;
}

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
