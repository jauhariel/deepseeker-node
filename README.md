# DeeperSeeker (Node.js)

DeepSeek website reverse-proxy server — **Node.js rewrite** of the original Python/FastAPI project — supporting OpenAI & Anthropic API standards.

Built with [Fastify](https://fastify.dev) (fast, low-overhead HTTP), [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (embedded DB), [Playwright](https://playwright.dev) (cookie generation), and the same `deepseek_pow_solver.wasm` PoW solver via Node's native `WebAssembly` API.

⚠️ Warning: Automated use violates DeepSeek's Terms of Use.
Use a dedicated throwaway account, never your personal one.
Accounts may be banned at any time. Use at your own risk.

A kind request: do not spam the server, respect DeepSeek's limits, and use it for personal purposes only.

## Quickstart

```bash
npm install
cp .env.example .env
npm start
```

Playwright/Chromium is **optional** (see *Browserless mode* below). Install it only if you want the WAF-cookie fallback:

```bash
npm run setup:browser
```

Dashboard: `http://localhost:4000/`

## Browserless mode (no Chromium)

DeepSeek's API currently accepts requests with only the `Authorization: Bearer <userToken>` header — the AWS WAF cookie is not required. So by default this server sends requests **cookieless** and only falls back to launching Chromium (to mint a fresh `aws-waf-token`) when DeepSeek answers a request with HTTP 403.

To run with **no browser at all** (ideal for lightweight VPS):

```bash
npm ci --omit=dev --omit=optional   # skips playwright entirely
DEEPSEEKER_DISABLE_BROWSER=1 npm start
```

With `DEEPSEEKER_DISABLE_BROWSER=1` the server never launches Chromium; if DeepSeek ever enforces the WAF on the API, requests will fail with a clear 403 error instead — at that point install playwright or drop a valid `aws_cookies_deepseek.json` next to `server.js`.

A ready-made slim image is available as `Dockerfile.slim`:

```bash
docker build -f Dockerfile.slim -t deeperseeker-node:slim .
docker run -d --name deeperseeker-node -p 4000:4000 --env-file .env deeperseeker-node:slim
```

### VPS / Docker

```bash
cp .env.example .env
docker build -t deeperseeker-node .
docker run -d --name deeperseeker-node -p 4000:4000 --env-file .env --shm-size=1g deeperseeker-node
# or: docker compose up -d   (compose binds to 127.0.0.1:4000 only)
```

The container runs Chromium under `xvfb-run` automatically. SQLite data and cookies persist in the `deeperseeker_data` volume (`/app/data`).

Bare-metal (no Docker) on Debian/Ubuntu:

```bash
sudo apt-get install -y xvfb
npm ci --omit=dev
npm run setup:browser
xvfb-run -a -s '-screen 0 1280x720x24' npm start
```

Resource guide: the Node process idles around ~60–100 MB RAM. Chromium only runs briefly when refreshing the WAF cookie and needs ~300–500 MB transiently — a 1 GB VPS is comfortable, 512 MB usually works but tight.

## Configuration (`.env`)

| Variable | Description | Default |
|---|---|---|
| `DEEPSEEKER_API_KEY` | Bearer API key required to access endpoints | `dseeker` |
| `DEEPSEEKER_ADMIN_USER` | Dashboard login username | `admin` |
| `DEEPSEEKER_ADMIN_PASSWORD` | Dashboard login password | `admin` |
| `HOST` | Bind address (`127.0.0.1` = local only, `0.0.0.0` = expose) | `127.0.0.1` |
| `PORT` | Server port | `4000` |
| `DEEPSEEKER_MAX_HISTORY_TOKENS` | History budget for session rebuilds | `24000` |
| `DEEPSEEKER_MAX_TOOL_RESULT_TOKENS` | Tool-result budget for session rebuilds | `12000` |
| `DEEPSEEKER_DISABLE_BROWSER` | `1` = never launch Chromium; run fully cookieless | unset |
| `DEEPSEEKER_PUBLIC_URL` | Public base URL shown in docs/dashboard (auto-detected from request if unset) | unset |
| `DEEPSEEKER_DEFAULT_MODEL` | Model used when a request omits `model` (`instant`/`vision`/`expert`) | `instant` |
| `DEEPSEEKER_FORCE_THINKING` | `1` = enable thinking/reasoning on every request regardless of client flags | unset |

## Auth Token Setup

1. Open incognito window → `chat.deepseek.com` → Login
2. Console (F12): `JSON.parse(localStorage.getItem("userToken")).value`
3. Paste raw token string into Dashboard (`/dashboard`). Close incognito window.

## API Endpoints & Usage

- **OpenAI Base**: `http://localhost:4000/v1`
  - `POST /v1/chat/completions` (streaming & non-streaming)
  - `POST /v1/responses` (Responses API)
  - `GET /v1/models`
  - `POST /v1/files`
  - `GET /v1/files/{file_id}`
  - `GET /v1/files/{file_id}/content`
- **Anthropic Base**: `http://localhost:4000`
  - `POST /v1/messages` (also at `/messages`)
  - `POST /v1/files/upload`
- **Auth Key**: Configured in `.env` (`DEEPSEEKER_API_KEY`)
- **Models**: `instant` (flash), `vision` (flash + vision), `expert` (pro) — also exposed as `anthropic/claude-instant`, `anthropic/claude-vision`, `anthropic/claude-expert` aliases for Claude Desktop auto-discovery. If no `model` is sent, requests default to `instant` (configurable via `DEEPSEEKER_DEFAULT_MODEL`).

Request flags (both API styles):

| Flag | Effect |
|---|---|
| `"stream": true` | Server-sent events streaming |
| `"search": true` | Enable DeepSeek web search (Anthropic: also via a `web_search` server tool) |
| `"thinking": {"type": "enabled"}` | Enable reasoning (also `"reasoning_effort": "high"` / `"effort": "high"`) |
| `"tools": [...]` | Function/tool calling (OpenAI or Anthropic schema) |

## Features (parity with the Python version)

- **Multi-Token Pooling**: Random active token rotation.
- **API Key Management**: Create additional API keys from the dashboard for other people/apps — they authenticate like the master key but can be revoked individually.
- **Usage Monitoring**: Per-key and per-model request/token/cost tracking, 24h/7d/all-time stats, and a recent-requests log on the dashboard.
- **Context-Based Session Selector**: SHA-256 signature over the canonicalized message history (up to the last assistant turn), model, and API key scope, to match and resume existing web chat sessions. Session creation is lock-protected against duplicates.
- **Full History Injection**: Injects full conversation history into new sessions when the signature is not in the DB or on account failover.
- **Automatic Rate-Limit Recovery**: Auto-marks tokens `RATE_LIMITED` on HTTP 401/403/429, fails over to a new token, transfers full context (including files), single retry.
- **Long-Context Resilience**: Empty/broken upstream sessions are discarded and retried once on a fresh session; unrecoverable errors become proper JSON API errors.
- **Tool Calling & Streaming**: SSE streaming with think-tag reassembly across chunk boundaries and multi-format tool-call parsing (DSML XML, `<tool_call>`, `<function_call>`, JSON) into OpenAI/Anthropic tool schemas.
- **File & Vision Support**: Base64/URL image extraction (with SSRF protection), file upload, vision-model file forking.
- **Claude Desktop Compatible**: Rich `/v1/models` capability metadata + `anthropic/claude-*` aliases.
- **Hardened Dashboard**: Session TTL, brute-force login lockout (5 attempts → 5 min), CSRF origin check.

## Differences from the Python version

- **Token counting is approximate.** The Python version uses the `deepseek-tokenizer` BPE (no maintained Node port), so this rewrite estimates token counts (≈4 chars/token Latin, ≈1.5 chars/token CJK). `usage` and `cost` figures are informational.
- The PoW solver runs the identical `deepseek_pow_solver.wasm` through Node's built-in `WebAssembly` instead of wasmtime.

## Pricing (per 1M tokens)

| Model Tier | Input Cost (Cache Miss) | Output Cost |
|---|---|---|
| **DeepSeek V4 Flash** (`instant`) | $0.44 | $1.32 |
| **DeepSeek V4 Flash Exp** (`vision`) | $0.44 | $1.32 |
| **DeepSeek V4 Pro** (`expert`) | $1.32 | $3.96 |

## Project layout

```
server.js        Fastify routes (OpenAI/Anthropic/files/dashboard)
src/config.js    env loading & constants
src/db.js        better-sqlite3: tokens, sessions
src/deepseek.js  upstream API: cookies (Playwright), PoW (wasm), chat, files
src/prompt.js    prompt building, signatures, file extraction, SSRF guard
src/tools.js     tool-call parsing (batch + streaming)
src/handlers.js  chat orchestration, retries, SSE streamers, response formatters
src/views.js     dashboard/login HTML
wasm/            deepseek_pow_solver.wasm
```

## Disclaimer

Educational purpose only. This project is not affiliated with, endorsed by, or sponsored by DeepSeek. Use responsibly and in accordance with DeepSeek's terms of service.
