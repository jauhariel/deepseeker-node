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
        <a href="/">Dashboard</a>
        <span class="sep">|</span>
        <a href="/logout">Logout</a>
        <span class="sep">|</span>
        <span class="brand">DeeperSeeker</span>
    </nav>
    <main>
        ${content}
    </main>
</body>
</html>`;
}

export function loginPage(error = null) {
  const content = `
<h1>Login</h1>
${error ? `<p style="color:red;">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/login">
    <div style="margin-bottom:10px;">
        <input type="text" name="username" placeholder="Username" required style="width:300px;">
    </div>
    <div style="margin-bottom:10px;">
        <input type="password" name="password" placeholder="Password" required style="width:300px;">
    </div>
    <button type="submit">Login</button>
</form>`;
  return baseLayout('Login - DeeperSeeker', content);
}

export function dashboardPage(tokens) {
  const rows = tokens.map((tok) => {
    const statusClass = tok.status === 'ACTIVE' ? 'ok' : tok.status === 'RATE_LIMITED' ? 'warn' : 'err';
    const masked = `${escapeHtml(tok.token.slice(0, 12))}…${escapeHtml(tok.token.slice(-4))}`;
    return `<tr>
                <td>${tok.id}</td>
                <td>${tok.alias ? escapeHtml(tok.alias) : '—'}</td>
                <td><code>${masked}</code></td>
                <td>
                    <span class="status ${statusClass}">
                        ${escapeHtml(tok.status)}
                    </span>
                </td>
                <td>
                    <form method="post" action="/tokens/${tok.id}/delete" style="display:inline"
                          onsubmit="return confirm('Delete?')">
                        <button type="submit" class="btn-sm btn-danger">Delete</button>
                    </form>
                </td>
            </tr>`;
  }).join('\n            ');

  const content = `
<h1>Dashboard</h1>

<section>
    <h2>Add Auth Token</h2>
    <div class="steps">
        <p><strong>Steps:</strong></p>
        <ol>
            <li>Open <strong>incognito/private</strong> window</li>
            <li>Go to <a href="https://chat.deepseek.com" target="_blank">chat.deepseek.com</a> and login</li>
            <li>Open DevTools (F12) → Console → paste:</li>
        </ol>
        <code>JSON.parse(localStorage.getItem("userToken")).value</code>
        <ol start="4">
            <li>Copy the token and paste below</li>
            <li><strong>Remove any surrounding quotes</strong> — paste only the raw token string</li>
            <li><strong>Close the incognito window</strong> to preserve the login</li>
        </ol>
    </div>
    <div class="warning">
        If you logout from DeepSeek in browser, this token stops working.
    </div>
    <form method="post" action="/tokens/add">
        <input type="text" name="alias" placeholder="Alias (optional, e.g. personal, work)" style="width:200px">
        <input type="text" name="auth_token" placeholder="Paste auth token here (no quotes)" style="width:400px">
        <button type="submit">Add Token</button>
    </form>
</section>

<section>
    <h2>Tokens (${tokens.length})</h2>
    ${tokens.length ? `<table>
        <thead>
            <tr>
                <th>ID</th>
                <th>Alias</th>
                <th>Token</th>
                <th>Status</th>
                <th>Actions</th>
            </tr>
        </thead>
        <tbody>
            ${rows}
        </tbody>
    </table>` : '<p>No tokens yet.</p>'}
</section>

<section>
    <h2>API</h2>
    <p>OpenAI: <code>http://localhost:4000/v1</code></p>
    <p>Anthropic: <code>http://localhost:4000</code></p>
    <p>Models: <code>instant</code>, <code>vision</code>, <code>expert</code></p>
</section>`;
  return baseLayout('Dashboard - DeeperSeeker', content);
}
