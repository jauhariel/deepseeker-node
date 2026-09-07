import { escapeHtml } from './util.js';

function baseLayout(title, content, { authed = true } = {}) {
  const navLinks = authed
    ? '<a href="/dashboard">Dashboard</a>\n            <a href="/logout">Logout</a>'
    : '<a href="#docs">Docs</a>\n            <a href="/dashboard">Dashboard</a>\n            <a href="/login">Login</a>';
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="/static/style.css">
</head>
<body>
    <nav>
        <a href="/" class="brand">DeeperSeeker</a>
        <span class="nav-links">
            ${navLinks}
        </span>
    </nav>
    <main>
        ${content}
    </main>
</body>
</html>`;
}

export function loginPage(error = null) {
  const content = `
<div class="login-box">
  <h1>Sign in</h1>
  ${error ? `<p class="form-error">${escapeHtml(error)}</p>` : ''}
  <form method="post" action="/login">
      <input type="text" name="username" placeholder="Username" required>
      <input type="password" name="password" placeholder="Password" required>
      <button type="submit" class="btn-block">Login</button>
  </form>
</div>`;
  return baseLayout('Login - DeeperSeeker', content, { authed: false });
}

export function landingPage(baseUrl = 'http://localhost:4000') {
  const content = `
<div class="hero">
    <p class="hero-eyebrow">DeepSeek web reverse proxy</p>
    <h1 class="hero-title">One endpoint. OpenAI &amp; Anthropic compatible.</h1>
    <p class="hero-sub">DeeperSeeker turns a DeepSeek web account into a local API server with token pooling, session continuity, tool calling, streaming, and per-key usage tracking.</p>
    <div class="hero-actions">
        <a href="/dashboard" class="btn-link btn-primary">Open Dashboard</a>
        <a href="https://github.com/jauhariel/deepseeker-node" class="btn-link btn-secondary">GitHub</a>
    </div>
</div>

<section id="docs">
    <h2>Quick Start</h2>
    <p class="hint">Point any OpenAI- or Anthropic-compatible client at this server and authenticate with your API key (the master key from <code>.env</code>, or any key created on the dashboard).</p>
    <div class="docs-grid">
        <div>
            <h3>OpenAI</h3>
            <p class="muted">Base URL: <code>${escapeHtml(baseUrl)}/v1</code></p>
            <pre class="codeblock">curl ${escapeHtml(baseUrl)}/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "expert",
    "messages": [{"role": "user", "content": "Hello!"}],
    "stream": false
  }'</pre>
        </div>
        <div>
            <h3>Anthropic</h3>
            <p class="muted">Base URL: <code>${escapeHtml(baseUrl)}</code></p>
            <pre class="codeblock">curl ${escapeHtml(baseUrl)}/v1/messages \\
  -H "x-api-key: YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "expert",
    "max_tokens": 1024,
    "messages": [{"role": "user", "content": "Hello!"}]
  }'</pre>
        </div>
    </div>
    <p class="hint">Set <code>"stream": true</code> for server-sent events. Also available: <code>POST /v1/responses</code>, <code>GET /v1/models</code>, <code>POST /v1/files</code>, <code>GET /v1/files/{id}/content</code>, <code>POST /v1/files/upload</code>.</p>
</section>

<section>
    <h2>With the OpenAI SDK</h2>
    <pre class="codeblock">from openai import OpenAI

client = OpenAI(base_url="${escapeHtml(baseUrl)}/v1", api_key="YOUR_API_KEY")

resp = client.chat.completions.create(
    model="expert",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(resp.choices[0].message.content)</pre>
</section>

<section>
    <h2>Models</h2>
    <div class="table-wrap"><table>
        <thead>
            <tr><th>Model</th><th>Tier</th><th>Input / 1M tokens</th><th>Output / 1M tokens</th></tr>
        </thead>
        <tbody>
            <tr><td><code>instant</code></td><td>DeepSeek V4 Flash</td><td class="num">$0.44</td><td class="num">$1.32</td></tr>
            <tr><td><code>vision</code></td><td>DeepSeek V4 Flash Exp (image input)</td><td class="num">$0.44</td><td class="num">$1.32</td></tr>
            <tr><td><code>expert</code></td><td>DeepSeek V4 Pro (default)</td><td class="num">$1.32</td><td class="num">$3.96</td></tr>
        </tbody>
    </table></div>
    <p class="hint" style="margin-top:10px;">Aliases <code>anthropic/claude-instant</code>, <code>anthropic/claude-vision</code>, <code>anthropic/claude-expert</code> are also exposed for Claude Desktop auto-discovery. If no model is sent, requests default to <code>expert</code>.</p>
</section>

<section>
    <h2>Setup: DeepSeek Auth Token</h2>
    <ol class="steps-list">
        <li>Open an <strong>incognito/private</strong> window and log in at <a href="https://chat.deepseek.com" target="_blank">chat.deepseek.com</a>.</li>
        <li>Open DevTools (F12) → Console, then run: <code>JSON.parse(localStorage.getItem("userToken")).value</code></li>
        <li>Copy the raw token (no quotes) into the <a href="/dashboard">dashboard</a>.</li>
        <li>Close the incognito window to keep the session alive. Logging out of DeepSeek in a browser invalidates the token.</li>
    </ol>
</section>

<section>
    <h2>Features</h2>
    <div class="feature-grid">
        <div class="feature"><h3>Token pooling</h3><p>Multiple DeepSeek accounts with random rotation and automatic rate-limit failover.</p></div>
        <div class="feature"><h3>Session continuity</h3><p>Requests resume the same web chat via history signatures; long conversations survive restarts.</p></div>
        <div class="feature"><h3>Tool calling</h3><p>DSML, XML, and JSON tool-call formats normalized into OpenAI/Anthropic schemas.</p></div>
        <div class="feature"><h3>Streaming</h3><p>SSE for both API styles, with reasoning (&lt;think&gt;) streams intact across chunk boundaries.</p></div>
        <div class="feature"><h3>Files &amp; vision</h3><p>Image and document upload, URL/base64 extraction, vision-model file forking.</p></div>
        <div class="feature"><h3>Multi-key access</h3><p>Issue revocable API keys and monitor requests, tokens, and cost per key.</p></div>
    </div>
</section>

<div class="warning">
    Automated use violates DeepSeek's Terms of Use. Use a dedicated throwaway account — never your personal one — and respect DeepSeek's limits. Educational purpose only; not affiliated with DeepSeek.
</div>`;
  return baseLayout('DeeperSeeker', content, { authed: false });
}

function maskKey(k) {
  const s = String(k ?? '');
  if (s.length <= 12) return escapeHtml(s);
  return `${escapeHtml(s.slice(0, 8))}…${escapeHtml(s.slice(-4))}`;
}

const fmtInt = (n) => Number(n || 0).toLocaleString('en-US');
const fmtCost = (c) => '$' + Number(c || 0).toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0');
const fmtTs = (ts) => {
  const d = new Date(ts * 1000);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

function statCard(label, value, sub) {
  return `<div class="stat">
      <div class="stat-label">${escapeHtml(label)}</div>
      <div class="stat-value">${escapeHtml(value)}</div>
      ${sub ? `<div class="stat-sub">${escapeHtml(sub)}</div>` : ''}
    </div>`;
}

export function dashboardPage({ tokens, apiKeys, stats, recent, masterKey, baseUrl = 'http://localhost:4000' }) {
  const keyLabels = new Map();
  keyLabels.set(masterKey, 'master');
  for (const k of apiKeys) keyLabels.set(k.api_key, k.label || `key #${k.id}`);
  const labelFor = (k) => keyLabels.get(k) || 'revoked';

  // --- usage overview ---
  const statGrid = `
  <div class="stat-grid">
    ${statCard('Requests (24h)', fmtInt(stats.day.requests), `${fmtInt(stats.week.requests)} this week`)}
    ${statCard('Tokens (24h)', fmtInt(stats.day.prompt_tokens + stats.day.completion_tokens), `${fmtInt(stats.total.prompt_tokens + stats.total.completion_tokens)} all time`)}
    ${statCard('Cost (24h)', fmtCost(stats.day.cost), `${fmtCost(stats.total.cost)} all time`)}
  </div>`;

  // --- per-model bars ---
  const maxModelTokens = Math.max(1, ...stats.byModel.map((m) => m.tokens));
  const modelRows = stats.byModel.map((m) => {
    const pct = Math.max(2, Math.round((m.tokens / maxModelTokens) * 100));
    return `<div class="bar-row">
        <span class="bar-name">${escapeHtml(m.model)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>
        <span class="bar-val num">${fmtInt(m.requests)} req · ${fmtInt(m.tokens)} tok · ${fmtCost(m.cost)}</span>
      </div>`;
  }).join('\n');
  const modelSection = stats.byModel.length
    ? `<section><h2>Usage by Model</h2>${modelRows}</section>`
    : '';

  // --- api keys ---
  const usageByKey = new Map(stats.byKey.map((r) => [r.api_key, r]));
  const masterUsage = usageByKey.get(masterKey);
  const keyRows = [
    `<tr>
        <td><span class="badge badge-master">master</span></td>
        <td><code>${maskKey(masterKey)}</code></td>
        <td class="muted">from .env</td>
        <td class="num">${fmtInt(masterUsage?.requests)}</td>
        <td class="num">${fmtInt(masterUsage?.tokens)}</td>
        <td class="num">${fmtCost(masterUsage?.cost)}</td>
        <td></td>
    </tr>`,
    ...apiKeys.map((k) => {
      const u = usageByKey.get(k.api_key);
      return `<tr>
        <td>${escapeHtml(k.label || '—')}</td>
        <td><code>${maskKey(k.api_key)}</code></td>
        <td class="muted">${fmtTs(k.created_at)}</td>
        <td class="num">${fmtInt(u?.requests)}</td>
        <td class="num">${fmtInt(u?.tokens)}</td>
        <td class="num">${fmtCost(u?.cost)}</td>
        <td>
            <form method="post" action="/keys/${k.id}/delete" style="display:inline"
                  onsubmit="return confirm('Revoke this API key?')">
                <button type="submit" class="btn-sm btn-danger">Revoke</button>
            </form>
        </td>
    </tr>`;
    }),
  ].join('\n');

  const keysSection = `
<section>
    <h2>API Keys</h2>
    <p class="hint">Give these keys to other people or apps. They authenticate exactly like the master key but can be revoked individually. Usage is tracked per key.</p>
    <form method="post" action="/keys/add" class="form-inline">
        <input type="text" name="label" placeholder="Label (e.g. alice, mobile-app)" style="width:220px">
        <input type="text" name="api_key" placeholder="Custom key (optional — auto-generated if empty)" style="width:340px">
        <button type="submit">Create Key</button>
    </form>
    <div class="table-wrap"><table>
        <thead>
            <tr><th>Label</th><th>Key</th><th>Created</th><th class="num">Requests</th><th class="num">Tokens</th><th class="num">Cost</th><th></th></tr>
        </thead>
        <tbody>
            ${keyRows}
        </tbody>
    </table></div>
</section>`;

  // --- deepseek tokens ---
  const tokenRows = tokens.map((tok) => {
    const statusClass = tok.status === 'ACTIVE' ? 'ok' : tok.status === 'RATE_LIMITED' ? 'warn' : 'err';
    return `<tr>
                <td>${tok.id}</td>
                <td>${tok.alias ? escapeHtml(tok.alias) : '—'}</td>
                <td><code>${escapeHtml(tok.token.slice(0, 12))}…${escapeHtml(tok.token.slice(-4))}</code></td>
                <td><span class="status ${statusClass}">${escapeHtml(tok.status)}</span></td>
                <td>
                    <form method="post" action="/tokens/${tok.id}/delete" style="display:inline"
                          onsubmit="return confirm('Delete?')">
                        <button type="submit" class="btn-sm btn-danger">Delete</button>
                    </form>
                </td>
            </tr>`;
  }).join('\n            ');

  const tokensSection = `
<section>
    <h2>DeepSeek Auth Tokens (${tokens.length})</h2>
    <details>
        <summary>How to get an auth token</summary>
        <ol>
            <li>Open an <strong>incognito/private</strong> window</li>
            <li>Go to <a href="https://chat.deepseek.com" target="_blank">chat.deepseek.com</a> and login</li>
            <li>Open DevTools (F12) → Console → paste: <code>JSON.parse(localStorage.getItem("userToken")).value</code></li>
            <li>Copy the token (no surrounding quotes) and paste below</li>
            <li><strong>Close the incognito window</strong> to preserve the login</li>
        </ol>
    </details>
    <div class="warning">If you logout from DeepSeek in browser, this token stops working.</div>
    <form method="post" action="/tokens/add" class="form-inline">
        <input type="text" name="alias" placeholder="Alias (optional)" style="width:180px">
        <input type="text" name="auth_token" placeholder="Paste auth token here (no quotes)" style="width:380px">
        <button type="submit">Add Token</button>
    </form>
    ${tokens.length ? `<div class="table-wrap"><table>
        <thead>
            <tr><th>ID</th><th>Alias</th><th>Token</th><th>Status</th><th></th></tr>
        </thead>
        <tbody>
            ${tokenRows}
        </tbody>
    </table></div>` : '<p class="muted">No tokens yet.</p>'}
</section>`;

  // --- recent requests ---
  const recentRows = recent.map((r) => `<tr>
        <td class="muted">${fmtTs(r.ts)}</td>
        <td>${escapeHtml(labelFor(r.api_key))}</td>
        <td><code>${escapeHtml(r.endpoint)}</code></td>
        <td>${escapeHtml(r.model)}</td>
        <td class="num">${fmtInt(r.prompt_tokens)}</td>
        <td class="num">${fmtInt(r.completion_tokens)}</td>
        <td class="num">${fmtCost(r.cost)}</td>
    </tr>`).join('\n');

  const recentSection = recent.length ? `
<section>
    <h2>Recent Requests</h2>
    <div class="table-wrap"><table>
        <thead>
            <tr><th>Time</th><th>Key</th><th>Endpoint</th><th>Model</th><th class="num">In</th><th class="num">Out</th><th class="num">Cost</th></tr>
        </thead>
        <tbody>
            ${recentRows}
        </tbody>
    </table></div>
</section>` : '';

  const apiSection = `
<section>
    <h2>API</h2>
    <p>OpenAI base URL: <code>${escapeHtml(baseUrl)}/v1</code> &nbsp;·&nbsp; Anthropic base URL: <code>${escapeHtml(baseUrl)}</code></p>
    <p>Models: <code>instant</code>, <code>vision</code>, <code>expert</code> (default when omitted: <code>expert</code>)</p>
</section>`;

  const content = `
<h1>Dashboard</h1>
${statGrid}
${keysSection}
${modelSection}
${recentSection}
${tokensSection}
${apiSection}`;
  return baseLayout('Dashboard - DeeperSeeker', content);
}
