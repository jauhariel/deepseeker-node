import { escapeHtml } from './util.js';

function baseLayout(title, content) {
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
        <span class="brand">DeeperSeeker</span>
        <span class="nav-links">
            <a href="/">Dashboard</a>
            <a href="/logout">Logout</a>
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
  return baseLayout('Login - DeeperSeeker', content);
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

export function dashboardPage({ tokens, apiKeys, stats, recent, masterKey }) {
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
    <table>
        <thead>
            <tr><th>Label</th><th>Key</th><th>Created</th><th class="num">Requests</th><th class="num">Tokens</th><th class="num">Cost</th><th></th></tr>
        </thead>
        <tbody>
            ${keyRows}
        </tbody>
    </table>
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
    ${tokens.length ? `<table>
        <thead>
            <tr><th>ID</th><th>Alias</th><th>Token</th><th>Status</th><th></th></tr>
        </thead>
        <tbody>
            ${tokenRows}
        </tbody>
    </table>` : '<p class="muted">No tokens yet.</p>'}
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
    <table>
        <thead>
            <tr><th>Time</th><th>Key</th><th>Endpoint</th><th>Model</th><th class="num">In</th><th class="num">Out</th><th class="num">Cost</th></tr>
        </thead>
        <tbody>
            ${recentRows}
        </tbody>
    </table>
</section>` : '';

  const apiSection = `
<section>
    <h2>API</h2>
    <p>OpenAI base URL: <code>http://localhost:4000/v1</code> &nbsp;·&nbsp; Anthropic base URL: <code>http://localhost:4000</code></p>
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
