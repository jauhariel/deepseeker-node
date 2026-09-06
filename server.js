import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import Fastify from 'fastify';
import fastifyFormbody from '@fastify/formbody';
import fastifyMultipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';

import { API_KEY, ADMIN_USER, ADMIN_PASSWORD, HOST, PORT, BASE_DIR, DISABLE_BROWSER } from './src/config.js';
import { initDb, getAuthToken, getTokens, getToken, pickToken, addToken, deleteToken } from './src/db.js';
import { uploadFile, getFileContent, cookiesValidOnDisk } from './src/deepseek.js';
import { handleChat, formatAnthropicResponse } from './src/handlers.js';
import { loginPage, dashboardPage } from './src/views.js';

initDb();

const app = Fastify({
  logger: false,
  bodyLimit: 32 * 1024 * 1024,
});

await app.register(fastifyFormbody);
await app.register(fastifyMultipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
await app.register(fastifyStatic, { root: path.join(BASE_DIR, 'static'), prefix: '/static/' });

// --- auth helpers -----------------------------------------------------------

function getApiKey(req) {
  const auth = req.headers['authorization'] || '';
  const apiKeyHeader = req.headers['x-api-key'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  if (auth) return auth;
  return apiKeyHeader;
}

function checkKey(req) {
  const key = getApiKey(req);
  const a = Buffer.from(String(key));
  const b = Buffer.from(API_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const SESSIONS = new Map(); // sid -> last-seen timestamp (ms)
const SESSION_TTL = 7 * 24 * 3600 * 1000;
const loginFails = { count: 0, lockedUntil: 0 };

function parseCookies(req) {
  const out = {};
  for (const pair of String(req.headers.cookie || '').split(';')) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    out[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return out;
}

// Returns true when the request carries a valid dashboard session (and passes the
// CSRF origin check). False means the caller should redirect to /login.
function checkAdmin(req) {
  const sid = parseCookies(req)['session_id'];
  const ts = sid ? SESSIONS.get(sid) : undefined;
  if (!sid || ts === undefined || Date.now() - ts > SESSION_TTL) return false;
  SESSIONS.set(sid, Date.now());
  const origin = req.headers['origin'] || '';
  if (origin) {
    let netloc = '';
    try { netloc = new URL(origin).host; } catch { /* ignore */ }
    if (netloc && netloc !== (req.headers['host'] || '')) return false;
  }
  return true;
}

// --- request body helpers ---------------------------------------------------

const THINK_ON = ['medium', 'high', 'max', 'ultra', 'extreme', 'enabled', 'adaptive', 'on'];
const THINK_OFF = ['low', 'none', 'off', 'disable', 'disabled', 'false'];

function isThinkingEnabled(body, req) {
  const effort = body.effort;
  if (effort != null) {
    const e = String(effort).trim().toLowerCase();
    if (THINK_ON.includes(e)) return true;
    if (THINK_OFF.includes(e)) return false;
  }

  const outCfg = body.output_config;
  if (outCfg && typeof outCfg === 'object') {
    const outEffort = outCfg.effort ?? outCfg.reasoning_effort;
    if (outEffort != null) {
      const e = String(outEffort).trim().toLowerCase();
      if (THINK_ON.includes(e)) return true;
      if (THINK_OFF.includes(e)) return false;
    }
  }

  const thinkingVal = body.thinking;
  if (thinkingVal && typeof thinkingVal === 'object') {
    const tType = String(thinkingVal.type || '').trim().toLowerCase();
    if (['enabled', 'adaptive', 'true'].includes(tType)) return true;
    if (tType === 'disabled') return false;
    const budget = thinkingVal.budget_tokens ?? 0;
    if (typeof budget === 'number' && budget > 0) return true;
    const tEffort = thinkingVal.effort ?? thinkingVal.reasoning_effort ?? thinkingVal.level;
    if (tEffort != null) {
      const e = String(tEffort).trim().toLowerCase();
      if (THINK_ON.includes(e)) return true;
      if (THINK_OFF.includes(e)) return false;
    }
  } else if (typeof thinkingVal === 'string') {
    const t = thinkingVal.trim().toLowerCase();
    if ([...THINK_ON, 'true'].includes(t)) return true;
    if (THINK_OFF.includes(t)) return false;
  } else if (typeof thinkingVal === 'boolean') {
    return thinkingVal;
  }

  const reasoningEffort = body.reasoning_effort;
  if (reasoningEffort != null) {
    const e = String(reasoningEffort).trim().toLowerCase();
    if (THINK_ON.includes(e)) return true;
    if (THINK_OFF.includes(e)) return false;
  }

  if (req) {
    const reqEffort = req.headers['anthropic-thinking'] || req.headers['x-anthropic-thinking'] || req.headers['effort'] || req.headers['x-effort'];
    if (reqEffort) {
      const e = String(reqEffort).trim().toLowerCase();
      if (THINK_ON.includes(e)) return true;
    }
  }
  return false;
}

function resolveModel(modelRaw) {
  if (!modelRaw || typeof modelRaw !== 'string') return 'expert';
  const m = modelRaw.toLowerCase();
  if (m.includes('instant') || m.includes('haiku') || m.includes('flash')) return 'instant';
  if (m.includes('vision')) return 'vision';
  return 'expert';
}

// Sends the result of handleChat: either a JSON payload or an SSE stream.
function sendChatResult(result, reply) {
  if (result.stream) {
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    });
    Readable.from(result.stream).pipe(reply.raw);
    return reply;
  }
  return reply.code(result.status || 200).send(result.json);
}

// --- OpenAI endpoints -------------------------------------------------------

app.post('/v1/chat/completions', async (req, reply) => {
  if (!checkKey(req)) return reply.code(401).send({ error: 'Invalid API key' });
  const body = req.body || {};
  const messages = body.messages || [];
  const model = resolveModel(body.model ?? 'expert');
  const result = await handleChat({
    messages,
    model,
    thinking: isThinkingEnabled(body, req),
    search: body.search ?? false,
    stream: body.stream ?? false,
    tools: body.tools ?? null,
    scope: getApiKey(req),
  });
  return sendChatResult(result, reply);
});

app.post('/v1/responses', async (req, reply) => {
  if (!checkKey(req)) return reply.code(401).send({ error: 'Invalid API key' });
  const body = req.body || {};
  const model = resolveModel(body.model ?? 'expert');
  let inputs = body.input ?? [];
  if (typeof inputs === 'string' || (inputs && typeof inputs === 'object' && !Array.isArray(inputs))) {
    inputs = [inputs];
  }

  const messages = [];
  for (const item of inputs) {
    if (typeof item === 'string') {
      messages.push({ role: 'user', content: item });
      continue;
    }
    const role = item.role || 'user';
    const content = item.content ?? [];
    let msgContent;
    if (typeof content === 'string') {
      msgContent = content;
    } else {
      msgContent = [];
      for (const c of content) {
        if (c.type === 'input_text') msgContent.push({ type: 'text', text: c.text });
        else if (c.type === 'input_file') msgContent.push({ type: 'file', file_id: c.file_id });
        else msgContent.push(c);
      }
    }
    messages.push({ role, content: msgContent });
  }

  const result = await handleChat({
    messages,
    model,
    thinking: isThinkingEnabled(body, req),
    search: body.search ?? false,
    stream: body.stream ?? false,
    tools: body.tools ?? null,
    scope: getApiKey(req),
  });

  if (body.stream) return sendChatResult(result, reply);

  if (result.json && 'choices' in result.json) {
    const message = result.json.choices[0].message;
    const outContent = [];
    if (message.content) outContent.push({ type: 'text', text: message.content });
    if (message.tool_calls) {
      for (const tc of message.tool_calls) {
        outContent.push({ type: 'tool_call', id: tc.id, name: tc.function.name, arguments: tc.function.arguments });
      }
    }
    const msgOutput = { type: 'message', role: 'assistant', content: outContent };
    if (message.reasoning_content) msgOutput.reasoning_content = message.reasoning_content;
    return reply.send({
      id: result.json.id,
      object: 'response',
      model: result.json.model,
      output: [msgOutput],
      usage: result.json.usage ?? {},
    });
  }
  return sendChatResult(result, reply);
});

// --- Anthropic endpoints ----------------------------------------------------

// Translate Anthropic message dicts into OpenAI-style dicts: tool_use blocks
// become assistant tool_calls and tool_result blocks become role="tool" messages.
function convertAnthropicMessages(messages) {
  const openaiMsgs = [];
  for (const m of messages) {
    let content = m.content ?? '';
    const toolCalls = [];
    const toolResults = [];
    if (Array.isArray(content)) {
      const parts = [];
      const imageParts = [];
      for (const c of content) {
        if (!c || typeof c !== 'object') continue;
        if (c.type === 'text') {
          parts.push(c.text || '');
        } else if (c.type === 'image') {
          imageParts.push(c);
        } else if (c.type === 'tool_use') {
          toolCalls.push({
            id: c.id || 'call_' + crypto.randomUUID().replace(/-/g, '').slice(0, 8),
            type: 'function',
            function: { name: c.name || '', arguments: JSON.stringify(c.input ?? {}) },
          });
        } else if (c.type === 'tool_result') {
          let resContent = c.content ?? '';
          if (Array.isArray(resContent)) {
            for (const item of resContent) {
              if (item && typeof item === 'object' && item.type === 'image') imageParts.push(item);
            }
            resContent = resContent.filter((item) => item && typeof item === 'object' && item.type === 'text').map((item) => item.text || '').join(' ');
          } else if (typeof resContent !== 'string') {
            resContent = String(resContent);
          }
          toolResults.push({ tool_call_id: c.tool_use_id || '', content: resContent });
        }
      }
      if (imageParts.length) {
        content = [...parts.filter((s) => s).map((s) => ({ type: 'text', text: s })), ...imageParts];
      } else {
        content = parts.filter((p) => p).join('\n');
      }
    }
    if (m.role === 'system') {
      if (content) openaiMsgs.push({ role: 'system', content });
      continue;
    }
    if (m.role === 'assistant') {
      if (typeof content === 'string' && (!content.trim() || content.trim() === '(no content)')) content = null;
      const msg = { role: 'assistant', content };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      if (msg.content == null && !toolCalls.length) continue;
      openaiMsgs.push(msg);
      continue;
    }
    for (const tr of toolResults) {
      openaiMsgs.push({ role: 'tool', tool_call_id: tr.tool_call_id, content: tr.content });
    }
    const hasContent = Array.isArray(content) ? content.length > 0 : Boolean(content);
    if (hasContent || !toolResults.length) {
      openaiMsgs.push({ role: m.role || 'user', content });
    }
  }
  return openaiMsgs;
}

const anthropicMessagesHandler = async (req, reply) => {
  if (!checkKey(req)) return reply.code(401).send({ error: 'Invalid API key' });
  const body = req.body || {};
  const system = body.system ?? '';
  const messages = body.messages || [];
  const model = resolveModel(body.model ?? 'expert');
  const tools = body.tools || [];

  const openaiMsgs = [];
  if (system) {
    let systemStr;
    if (Array.isArray(system)) {
      systemStr = system.filter((c) => c && typeof c === 'object' && c.type === 'text').map((c) => c.text || '').join(' ');
    } else {
      systemStr = String(system);
    }
    if (systemStr) openaiMsgs.push({ role: 'system', content: systemStr });
  }

  openaiMsgs.push(...convertAnthropicMessages(messages));

  const openaiTools = [];
  for (const t of tools) {
    if (t.type === 'function') {
      openaiTools.push({
        type: 'function',
        function: { name: t.name, description: t.description ?? 'NO DESCRIPTION', parameters: t.input_schema ?? {} },
      });
    } else if ('name' in t) {
      openaiTools.push({
        type: 'function',
        function: { name: t.name, description: t.description ?? '', parameters: t.input_schema ?? t.parameters ?? {} },
      });
    }
  }

  const outputConfig = body.output_config;
  if (outputConfig && typeof outputConfig === 'object' && outputConfig.format?.type === 'json_schema') {
    const jsonSchema = outputConfig.format.schema;
    if (jsonSchema) {
      openaiMsgs.unshift({ role: 'system', content: `You MUST return valid JSON adhering strictly to this JSON Schema:\n${JSON.stringify(jsonSchema)}` });
    }
  }

  const reqModel = body.model;
  const result = await handleChat({
    messages: openaiMsgs,
    model,
    thinking: isThinkingEnabled(body, req),
    search: false,
    stream: body.stream ?? false,
    tools: openaiTools.length ? openaiTools : null,
    isAnthropic: true,
    reqModel,
    scope: getApiKey(req),
  });

  if (body.stream) return sendChatResult(result, reply);
  if (!result.json || !('choices' in result.json)) return sendChatResult(result, reply);
  return reply.send(formatAnthropicResponse(result.json, reqModel));
};

app.post('/v1/messages', anthropicMessagesHandler);
app.post('/messages', anthropicMessagesHandler);

// --- models ------------------------------------------------------------------

const listModelsHandler = async (req, reply) => {
  if (!checkKey(req)) return reply.code(401).send({ error: 'Invalid API key' });

  const baseCapabilities = {
    batch: { supported: true },
    structured_outputs: { supported: true },
    thinking: { supported: true, types: { enabled: { supported: true }, adaptive: { supported: true } } },
    effort: { supported: true, low: { supported: true }, medium: { supported: true } },
    context_management: { clear_thinking_20251015: { supported: true }, compact_20260112: { supported: true }, supported: true },
  };

  const baseModels = [
    { id: 'instant', display_name: 'Instant', created: 1785456000, created_at: '2026-07-31T00:00:00Z', extra: {} },
    { id: 'expert', display_name: 'Expert', created: 1788134400, created_at: '2026-08-31T00:00:00Z', extra: { code_execution: { supported: true } } },
    { id: 'vision', display_name: 'Vision', created: 1785456000, created_at: '2026-07-31T00:00:00Z', extra: { image_input: { supported: true }, pdf_input: { supported: true } } },
  ].map(({ id, display_name, created, created_at, extra }) => ({
    id,
    object: 'model',
    type: 'model',
    name: id,
    display_name,
    created,
    created_at,
    owned_by: 'deeperseeker',
    capabilities: { ...baseCapabilities, ...extra },
  }));

  const claudeAliases = baseModels.map((m) => ({
    ...m,
    id: `anthropic/claude-${m.id}`,
    name: `anthropic/claude-${m.name}`,
    display_name: `Claude ${m.display_name}`,
  }));

  const allModels = [...baseModels, ...claudeAliases];
  return reply.send({
    object: 'list',
    data: allModels,
    has_more: false,
    first_id: allModels[0].id,
    last_id: allModels[allModels.length - 1].id,
  });
};

app.get('/v1/models', listModelsHandler);
app.get('/models', listModelsHandler);

// --- files -------------------------------------------------------------------

const filesUploadHandler = async (req, reply) => {
  if (!checkKey(req)) return reply.code(401).send({ error: 'Invalid API key' });
  const tokId = pickToken();
  if (!tokId) return reply.code(503).send({ error: 'No tokens available' });
  const tok = getToken(tokId);
  const data = await req.file();
  if (!data) return reply.code(400).send({ error: 'No file provided' });
  let fileBytes;
  try {
    fileBytes = await data.toBuffer();
  } catch (e) {
    if (e.statusCode === 413 || e.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.code(413).send({ error: 'File too large' });
    }
    throw e;
  }
  const filename = data.filename || 'file.bin';
  const contentType = data.mimetype || 'application/octet-stream';
  let fileInfo = null;
  for await (const [status, info] of uploadFile(fileBytes, filename, contentType, tok.token)) {
    if (status === 'success') {
      fileInfo = info;
      break;
    }
  }
  if (!fileInfo) return reply.code(500).send({ error: 'Upload failed' });

  if (req.url.startsWith('/v1/files/upload')) {
    return reply.send({
      id: fileInfo.file_id,
      type: 'file',
      filename,
      size: fileInfo.size,
      created_at: fileInfo.anthropic_timestamp,
    });
  }
  return reply.send({
    id: fileInfo.file_id,
    object: 'file',
    bytes: fileInfo.size,
    created_at: fileInfo.openai_timestamp,
    filename,
    purpose: 'answers',
  });
};

app.post('/v1/files', filesUploadHandler);
app.post('/v1/files/upload', filesUploadHandler);

const filesContentHandler = async (req, reply) => {
  if (!checkKey(req)) return reply.code(401).send({ error: 'Invalid API key' });
  const tokId = pickToken();
  if (!tokId) return reply.code(503).send({ error: 'No tokens available' });
  const tok = getToken(tokId);
  const gen = getFileContent(tok.token, req.params.fileId);
  let first;
  try {
    first = await gen.next();
  } catch {
    return reply.code(502).send({ error: 'File fetch failed' });
  }
  if (first.done) return reply.code(404).send({ error: 'File not found' });
  const mime = first.value || 'application/octet-stream';
  reply.raw.writeHead(200, { 'content-type': mime });
  Readable.from(gen).pipe(reply.raw);
  return reply;
};

app.get('/v1/files/:fileId/content', filesContentHandler);
app.get('/v1/files/:fileId', filesContentHandler);

// --- dashboard / auth --------------------------------------------------------

app.get('/login', async (req, reply) => {
  return reply.type('text/html').send(loginPage(null));
});

app.post('/login', async (req, reply) => {
  const { username = '', password = '' } = req.body || {};
  reply.type('text/html');
  if (Date.now() < loginFails.lockedUntil) {
    return reply.send(loginPage('Too many attempts. Try again later.'));
  }
  const safeEqual = (a, b) => {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  };
  if (safeEqual(username, ADMIN_USER) && safeEqual(password, ADMIN_PASSWORD)) {
    loginFails.count = 0;
    const sid = crypto.randomUUID();
    SESSIONS.set(sid, Date.now());
    reply.header('set-cookie', `session_id=${sid}; HttpOnly; SameSite=Lax; Path=/`);
    return reply.redirect('/dashboard');
  }
  loginFails.count++;
  if (loginFails.count >= 5) {
    loginFails.lockedUntil = Date.now() + 300000;
    loginFails.count = 0;
  }
  return reply.send(loginPage('Invalid username or password'));
});

app.get('/logout', async (req, reply) => {
  const sid = parseCookies(req)['session_id'];
  if (sid) SESSIONS.delete(sid);
  reply.header('set-cookie', 'session_id=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  return reply.redirect('/login');
});

app.get('/dashboard', async (req, reply) => {
  if (!checkAdmin(req)) return reply.redirect('/login');
  return reply.type('text/html').send(dashboardPage(getTokens()));
});

app.post('/tokens/add', async (req, reply) => {
  if (!checkAdmin(req)) return reply.redirect('/login');
  const authToken = String(req.body?.auth_token || '').trim().replace(/^['"]+|['"]+$/g, '');
  const alias = String(req.body?.alias || '').trim() || null;
  if (authToken) addToken(authToken, alias);
  return reply.redirect('/dashboard');
});

app.post('/tokens/:tokenId/delete', async (req, reply) => {
  if (!checkAdmin(req)) return reply.redirect('/login');
  deleteToken(parseInt(req.params.tokenId, 10));
  return reply.redirect('/dashboard');
});

app.get('/', async (req, reply) => {
  if (!checkAdmin(req)) return reply.redirect('/login');
  return reply.type('text/html').send(dashboardPage(getTokens()));
});

app.get('/health', async (req, reply) => {
  const active = getTokens().filter((t) => t.status === 'ACTIVE').length;
  const cookiesValid = cookiesValidOnDisk();
  // In browserless mode requests go cookieless, so cookies are not required.
  const ok = active > 0 && (cookiesValid || DISABLE_BROWSER);
  const data = { status: ok ? 'ok' : 'degraded' };
  if (checkKey(req)) {
    data.active_tokens = active;
    data.cookies_valid = cookiesValid;
    data.browser_disabled = DISABLE_BROWSER;
  }
  return reply.code(ok ? 200 : 503).send(data);
});

// --- start -------------------------------------------------------------------

app.listen({ host: HOST, port: PORT }).then((addr) => {
  console.log(`DeeperSeeker (Node) listening on ${addr}`);
  console.log(`Dashboard: http://${HOST}:${PORT}/`);
});
