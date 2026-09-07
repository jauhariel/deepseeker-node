import fs from 'node:fs';
import { COOKIE_FILE, WASM_PATH, DISABLE_BROWSER } from './config.js';
import { Mutex, sleep, guessMimeType } from './util.js';

const DS_BASE = 'https://chat.deepseek.com';

const TZ_OFFSET = String(Math.trunc(-new Date().getTimezoneOffset() * 60));

export function getHeaders(authToken, pow = null) {
  const headers = {
    'accept': '*/*',
    'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
    'content-type': 'application/json',
    'origin': DS_BASE,
    'priority': 'u=1, i',
    'referer': DS_BASE + '/',
    'sec-ch-ua': '"Not=A?Brand";v="99", "Google Chrome";v="151", "Chromium";v="151"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Linux"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin',
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-client-locale': 'en_US',
    'x-client-platform': 'web',
    'x-client-timezone-offset': TZ_OFFSET,
    'x-client-version': '2.3.0',
  };
  if (authToken) headers['authorization'] = `Bearer ${authToken}`;
  if (pow) headers['x-ds-pow-response'] = pow;
  return headers;
}

function cookieHeader(cookieObj) {
  return Object.entries(cookieObj).map(([k, v]) => `${k}=${v}`).join('; ');
}

function readCookieFile() {
  try {
    if (fs.existsSync(COOKIE_FILE)) {
      const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf-8'));
      if (cookies.expiry != null && cookies.expiry > Date.now() / 1000) {
        return cookies.cookie;
      }
    }
  } catch {
    // fall through and regenerate
  }
  return null;
}

// Cached WAF cookies only — never launches a browser. Returns null when there is
// no valid cookie file; requests are then sent cookieless (DeepSeek's API
// currently accepts that; the browser path below is only a fallback).
export function getCachedCookies() {
  return readCookieFile();
}

const cookieMutex = new Mutex();

export async function regenerateCookies() {
  if (DISABLE_BROWSER) {
    throw new Error('DeepSeek returned a WAF challenge (HTTP 403) and DEEPSEEKER_DISABLE_BROWSER=1 prevents cookie regeneration. Unset it, or place a valid aws_cookies_deepseek.json next to server.js.');
  }
  return cookieMutex.run(async () => {
    const recheck = readCookieFile();
    if (recheck) return recheck;
    await generateCookies();
    const cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf-8'));
    return cookies.cookie;
  });
}

// fetch() wrapper for DeepSeek API calls: attaches the cached WAF cookie when
// present, and on HTTP 403 regenerates cookies via a real browser and retries once.
async function dsFetch(url, { method = 'GET', headers = {}, body, timeoutMs = 30000 } = {}) {
  const makeOpts = () => {
    const h = { ...headers };
    const cached = getCachedCookies();
    if (cached) h.cookie = cookieHeader(cached);
    const opts = { method, headers: h };
    if (timeoutMs) opts.signal = AbortSignal.timeout(timeoutMs);
    if (body !== undefined) opts.body = body;
    return opts;
  };
  let resp = await fetch(url, makeOpts());
  if (resp.status === 403) {
    try {
      await regenerateCookies();
    } catch {
      return resp; // browser unavailable/disabled — surface the original 403
    }
    resp = await fetch(url, makeOpts());
  }
  return resp;
}

async function generateCookies() {
  // Lazy import so the project runs fine without playwright installed
  // (browserless mode). Only needed when DeepSeek issues a WAF challenge.
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    throw new Error('playwright is not installed. Run `npm install playwright && npx playwright install chromium`, or set DEEPSEEKER_DISABLE_BROWSER=1 to run cookieless.');
  }
  // DeepSeek blocks headless browsers, so this launches a visible Chromium window.
  const launchOpts = { headless: false };
  if (typeof process.geteuid === 'function' && process.geteuid() === 0) {
    launchOpts.args = ['--no-sandbox'];
  }
  const browser = await chromium.launch(launchOpts);
  let cookies;
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(DS_BASE + '/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('body');
    try {
      await page.waitForURL('**/sign_in*', { timeout: 30000 });
    } catch {
      // no redirect to sign-in; cookies are already set
    }
    cookies = await context.cookies();
  } finally {
    await browser.close();
  }
  const finalCookies = {};
  let expiry = null;
  for (const c of cookies) {
    if (c.name === 'aws-waf-token') expiry = c.expires;
    finalCookies[c.name] = c.value;
  }
  finalCookies['ds_cookie_preference'] = '%257B%2522level%2522%253A%2522all%2522%257D';
  if (!expiry || expiry < 0) expiry = Date.now() / 1000 + 1800;
  const tmpPath = COOKIE_FILE + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify({ cookie: finalCookies, expiry }));
  fs.renameSync(tmpPath, COOKIE_FILE);
}

export function cookiesValidOnDisk() {
  try {
    const c = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf-8'));
    return Boolean(c.expiry && c.expiry > Date.now() / 1000);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// PoW challenge solver (WebAssembly, same .wasm as the Python wasmtime path)
// ---------------------------------------------------------------------------

let powModulePromise = null;

function getPowModule() {
  if (!powModulePromise) {
    powModulePromise = fs.promises.readFile(WASM_PATH).then((bytes) => WebAssembly.compile(bytes));
  }
  return powModulePromise;
}

export async function findPowAnswer(challengeData) {
  const module = await getPowModule();
  const instance = await WebAssembly.instantiate(module, {});
  const { memory, alloc, solve_pow } = instance.exports;
  const writeString = (text) => {
    const data = new TextEncoder().encode(text);
    const ptr = alloc(data.length);
    new Uint8Array(memory.buffer).set(data, ptr);
    return [ptr, data.length];
  };
  const [chPtr, chLen] = writeString(challengeData.challenge);
  const [saltPtr, saltLen] = writeString(challengeData.salt);
  let result;
  try {
    // ptr/len are i32; expire_at/difficulty are i64 and must be BigInt in the JS WebAssembly API.
    result = solve_pow(chPtr, chLen, saltPtr, saltLen, BigInt(challengeData.expire_at), BigInt(challengeData.difficulty));
  } catch (e) {
    if (!(e instanceof TypeError)) throw e;
    result = solve_pow(chPtr, chLen, saltPtr, saltLen, challengeData.expire_at, challengeData.difficulty);
  }
  if (typeof result === 'bigint') {
    if (result < 0n) result += 1n << 64n;
    if (result === (1n << 64n) - 1n) return null;
    return Number(result);
  }
  return result;
}

export async function createChallengePow(targetPath, authToken) {
  const resp = await dsFetch(`${DS_BASE}/api/v0/chat/create_pow_challenge`, {
    method: 'POST',
    headers: getHeaders(authToken),
    body: JSON.stringify({ target_path: targetPath }),
    timeoutMs: 20000,
  });
  const data = await resp.json();
  return data.data.biz_data.challenge;
}

export async function solveCreatePow(targetPath, authToken) {
  const pow = await createChallengePow(targetPath, authToken);
  const answer = await findPowAnswer(pow);
  if (answer == null) throw new Error('PoW solve failed');
  const jsonData = {
    algorithm: 'DeepSeekHashV1',
    challenge: pow.challenge,
    salt: pow.salt,
    answer,
    signature: pow.signature,
    target_path: targetPath,
  };
  return Buffer.from(JSON.stringify(jsonData)).toString('base64');
}

export async function createNewChat(authToken) {
  const resp = await dsFetch(`${DS_BASE}/api/v0/chat_session/create`, {
    method: 'POST',
    headers: getHeaders(authToken),
    timeoutMs: 20000,
  });
  const data = await resp.json();
  return data.data.biz_data.chat_session.id;
}

// Async-iterate a fetch body line by line (like aiohttp's `async for line in resp.content`).
async function* iterateLines(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        yield buf.slice(0, idx);
        buf = buf.slice(idx + 1);
      }
    }
    buf += decoder.decode();
    if (buf) yield buf;
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

export async function* sendMessage(chatId, authToken, message, parentMessageId, thinking = false, search = false, modelType = null, fileIdsInput = []) {
  if (parentMessageId === 0) parentMessageId = null;

  let fileIds;
  if (modelType === 'expert') {
    fileIds = [...fileIdsInput];
  } else if (modelType === 'vision' && fileIdsInput.length) {
    // Vision model needs files forked to the vision task type first.
    const headers = getHeaders(authToken);
    fileIds = [];
    for (const fid of fileIdsInput) {
      const resp = await dsFetch(`${DS_BASE}/api/v0/file/fork_file_task`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ file_id: fid, to_model_type: 'vision' }),
      });
      let respJson = await resp.json();
      let status = respJson.data.biz_data.status;
      const fileId = respJson.data.biz_data.id;
      const deadline = Date.now() + 300000;
      while ((status === 'PENDING' || status === 'PARSING') && Date.now() < deadline) {
        await sleep(300);
        const r = await dsFetch(`${DS_BASE}/api/v0/file/fetch_files?file_ids=${fileId}`, { headers });
        respJson = await r.json();
        status = respJson.data.biz_data.files[0].status;
      }
      if (status === 'SUCCESS') fileIds.push(fileId);
    }
  } else {
    fileIds = fileIdsInput;
  }

  const powHeader = await solveCreatePow('/api/v0/chat/completion', authToken);
  const jsonData = {
    chat_session_id: chatId,
    parent_message_id: parentMessageId,
    model_type: modelType,
    prompt: message,
    ref_file_ids: fileIds,
    thinking_enabled: thinking,
    search_enabled: search,
    preempt: false,
    action: null,
  };

  const resp = await dsFetch(`${DS_BASE}/api/v0/chat/completion`, {
    method: 'POST',
    headers: getHeaders(authToken, powHeader),
    body: JSON.stringify(jsonData),
    timeoutMs: 600000,
  });
  if (resp.status !== 200) {
    const errorText = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${errorText}`);
  }

  let thinkOpen = false;
  let gotOutput = false;
  const emptyError = () => new Error('Empty response from DeepSeek (prompt may exceed the session context limit)');

  function* appendFragment(fragment) {
    if (fragment.type === 'RESPONSE') {
      if (thinkOpen) {
        yield '\n</think>\n\n';
        thinkOpen = false;
      }
      gotOutput = true;
      yield fragment.content ?? '';
    } else if (fragment.type === 'THINK') {
      if (!thinkOpen) {
        yield '<think>\n';
        thinkOpen = true;
      }
      gotOutput = true;
      yield fragment.content ?? '';
    } else {
      gotOutput = true;
      yield fragment.content ?? '';
    }
  }

  for await (const line of iterateLines(resp.body)) {
    if (!line) continue;
    const decodedLine = line.trim();
    if (!decodedLine.startsWith('data: ')) continue;
    let data;
    try {
      data = JSON.parse(decodedLine.slice(6));
    } catch {
      continue;
    }
    if (data.p === 'response/status' && data.v === 'FINISHED') {
      if (thinkOpen) yield '\n</think>\n\n';
      if (!gotOutput) throw emptyError();
      return;
    }
    if (data.o === 'BATCH' && Array.isArray(data.v)) {
      // BATCH wraps sub-operations. Besides quasi_status FINISHED it can carry
      // real content, e.g. {"p":"response","o":"BATCH","v":[{"p":"fragments",
      // "o":"APPEND","v":[{"type":"RESPONSE","content":"##"}]}]} — dropping it
      // eats the first characters of the reply.
      for (const op of data.v) {
        if (!op || typeof op !== 'object') continue;
        if (op.p === 'quasi_status' && op.v === 'FINISHED') {
          if (thinkOpen) yield '\n</think>\n\n';
          if (!gotOutput) throw emptyError();
          return;
        }
        if (op.p === 'fragments' && op.o === 'APPEND' && Array.isArray(op.v)) {
          for (const fragment of op.v) {
            yield* appendFragment(fragment);
          }
        } else if (typeof op.v === 'string' && op.v && String(op.p).endsWith('/content')) {
          gotOutput = true;
          yield op.v;
        }
      }
      continue;
    }
    if (data.v && typeof data.v === 'object' && !Array.isArray(data.v) && 'response' in data.v) {
      const fragments = data.v.response?.fragments;
      if (fragments) {
        for (const fragment of fragments) {
          if (fragment.type === 'THINK') {
            if (!thinkOpen) {
              yield '<think>\n';
              thinkOpen = true;
            }
            gotOutput = true;
            yield fragment.content ?? '';
          } else {
            if (thinkOpen) {
              yield '\n</think>\n\n';
              thinkOpen = false;
            }
            gotOutput = true;
            yield fragment.content ?? '';
          }
        }
      }
      continue;
    }
    if (data.p === 'response/fragments' && data.o === 'APPEND') {
      const fragments = data.v;
      if (Array.isArray(fragments)) {
        for (const fragment of fragments) {
          yield* appendFragment(fragment);
        }
      }
      continue;
    }
    // String deltas carry content either bare ({"v":"..."}) or path-scoped to a
    // fragment content append ({"p":"response/fragments/-1/content","v":"..."}).
    // Control messages ({"p":".../status","v":"FINISHED"},
    // {"p":"response/conversation_mode","v":"SEARCH"}) must not leak into the text.
    const v = data.v;
    if (typeof v === 'string' && v && (data.p === undefined || String(data.p).endsWith('/content'))) {
      gotOutput = true;
      yield v;
    }
  }
  if (thinkOpen) yield '\n</think>\n\n';
  if (!gotOutput) throw emptyError();
}

export async function* uploadFile(fileBytes, fileName, fileContentType, authToken) {
  const fileSize = fileBytes.length;
  const powResponse = await solveCreatePow('/api/v0/file/upload_file', authToken);
  const boundary = '----WebKitFormBoundaryTB0pXOQR2RL219Hu';
  const safeName = (fileName || '').replace(/[^ -~]/g, '_').replace(/"/g, '_') || 'file.bin';
  const reconstructedBody = Buffer.concat([
    Buffer.from(`--${boundary}\r\n`),
    Buffer.from(`Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n`),
    Buffer.from(`Content-Type: ${fileContentType || 'application/octet-stream'}\r\n\r\n`),
    fileBytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const headers = {
    ...getHeaders(authToken, powResponse),
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'x-file-size': String(fileSize),
  };
  const resp = await dsFetch(`${DS_BASE}/api/v0/file/upload_file`, {
    method: 'POST',
    headers,
    body: reconstructedBody,
    timeoutMs: 120000,
  });
  const respJson = await resp.json();
  const fileId = respJson.data.biz_data.id;
  yield ['uploaded', fileId];
  let jsData = respJson.data.biz_data;
  let status = jsData.status;
  const plainHeaders = getHeaders(authToken);
  const deadline = Date.now() + 300000;
  while ((status === 'PENDING' || status === 'PARSING') && Date.now() < deadline) {
    yield ['uploaded', fileId];
    await sleep(300);
    const r = await dsFetch(`${DS_BASE}/api/v0/file/fetch_files?file_ids=${fileId}`, { headers: plainHeaders });
    jsData = (await r.json()).data.biz_data.files[0];
    status = jsData.status;
  }
  if (status === 'SUCCESS' || (status === 'CONTENT_EMPTY' && String(fileContentType).startsWith('image/'))) {
    const tpData = new Date(jsData.updated_at * 1000);
    yield ['success', {
      file_id: fileId,
      openai_timestamp: Math.trunc(jsData.updated_at),
      size: jsData.file_size,
      anthropic_timestamp: tpData.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    }];
  } else {
    yield ['error', fileId];
  }
}

export async function* getFileContent(authToken, fileId) {
  const headers = getHeaders(authToken);
  const fetchMeta = async () => {
    const resp = await dsFetch(`${DS_BASE}/api/v0/file/fetch_files?file_ids=${fileId}`, { headers });
    return (await resp.json()).data.biz_data.files[0];
  };
  let jsData = await fetchMeta();
  yield guessMimeType(jsData.file_name);
  const deadline = Date.now() + 60000;
  while ((jsData.status === 'PENDING' || jsData.status === 'PARSING') && Date.now() < deadline && !jsData.signed_path) {
    await sleep(500);
    jsData = await fetchMeta();
  }
  if (!jsData.signed_path) return;
  // Signed download URL on a different host; no auth/cookie headers needed.
  const filePath = 'https://files.deepseeksvc.com/api' + jsData.signed_path + '&ty=r';
  const dataResp = await fetch(filePath);
  const reader = dataResp.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.length) yield Buffer.from(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}
