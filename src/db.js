import Database from 'better-sqlite3';
import { DB_FILE, MAX_SESSIONS, PRUNE_EVERY } from './config.js';

const db = new Database(DB_FILE, { timeout: 30000 });
db.pragma('journal_mode = WAL');

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alias TEXT,
      token TEXT,
      status TEXT DEFAULT 'ACTIVE'
    );
    CREATE TABLE IF NOT EXISTS sessions (
      signature TEXT PRIMARY KEY,
      token_id INTEGER,
      deepseek_session_id TEXT,
      parent_message_id INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS session_map (
      old_session TEXT PRIMARY KEY,
      new_session TEXT,
      token_id INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      label TEXT,
      api_key TEXT UNIQUE,
      created_at INTEGER,
      active INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER,
      api_key TEXT,
      endpoint TEXT,
      model TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      cost REAL
    );
    CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_log(ts);
  `);
  try {
    pruneSessions();
  } catch (e) {
    console.warn('[db] startup session pruning failed (non-fatal):', e.message || e);
  }
}

export function getAuthToken() {
  const row = db.prepare('SELECT token FROM tokens LIMIT 1').get();
  return row ? row.token : null;
}

export function addToken(token, alias = null) {
  let nextId = 1;
  if (db.prepare('SELECT 1 FROM tokens WHERE id = 1').get()) {
    const row = db.prepare(`
      SELECT min(t1.id + 1) AS next_id
      FROM tokens t1
      LEFT JOIN tokens t2 ON t1.id + 1 = t2.id
      WHERE t2.id IS NULL
    `).get();
    nextId = row && row.next_id ? row.next_id : 1;
  }
  db.prepare("INSERT INTO tokens (id, alias, token, status) VALUES (?, ?, ?, 'ACTIVE')").run(nextId, alias, token);
}

export function getTokens() {
  return db.prepare('SELECT id, alias, token, status FROM tokens').all();
}

export function getToken(tokenId) {
  return db.prepare('SELECT id, alias, token, status FROM tokens WHERE id = ?').get(tokenId) || null;
}

export function deleteToken(tokenId) {
  db.prepare('DELETE FROM tokens WHERE id = ?').run(tokenId);
}

export function pickToken() {
  const row = db.prepare("SELECT id FROM tokens WHERE status = 'ACTIVE' ORDER BY RANDOM() LIMIT 1").get();
  if (row) return row.id;
  const any = db.prepare('SELECT id FROM tokens ORDER BY id LIMIT 1').get();
  return any ? any.id : null;
}

export function markLimited(tokenId) {
  console.warn(`[db] token #${tokenId} marked RATE_LIMITED`);
  db.prepare('UPDATE tokens SET status = ? WHERE id = ?').run('RATE_LIMITED', tokenId);
}

export function markActive(tokenId) {
  db.prepare('UPDATE tokens SET status = ? WHERE id = ?').run('ACTIVE', tokenId);
}

export function findSession(sig) {
  const row = db.prepare('SELECT token_id, deepseek_session_id, parent_message_id FROM sessions WHERE signature = ?').get(sig);
  if (!row) return null;
  return { token_id: row.token_id, session_id: row.deepseek_session_id, parent_message_id: row.parent_message_id };
}

// Every request stores 2 session rows and nothing removed them, so the DB
// grew unbounded — on volume-limited deployments a full disk freezes all
// requests. Prune keeps the newest MAX_SESSIONS rows (rowid = insertion order).
let saveCounter = 0;

export function pruneSessions() {
  const deleted = db.prepare(
    'DELETE FROM sessions WHERE rowid NOT IN (SELECT rowid FROM sessions ORDER BY rowid DESC LIMIT ?)'
  ).run(MAX_SESSIONS).changes;
  const deletedMap = db.prepare(
    "DELETE FROM session_map WHERE created_at < datetime('now', '-7 days')"
  ).run().changes;
  if (deleted || deletedMap) {
    console.info(`[db] pruned ${deleted} session signature(s) and ${deletedMap} stale session_map row(s)`);
  }
}

export function saveSession(sig, tokenId, sessionId, parentMessageId = 0) {
  db.prepare(`INSERT OR REPLACE INTO sessions (signature, token_id, deepseek_session_id, parent_message_id)
              VALUES (?, ?, ?, ?)`).run(sig, tokenId, sessionId, parentMessageId);
  saveCounter++;
  if (saveCounter >= PRUNE_EVERY) {
    saveCounter = 0;
    try {
      pruneSessions();
    } catch (e) {
      console.warn('[db] session pruning failed (non-fatal):', e.message || e);
    }
  }
}

export function deleteSession(sig) {
  db.prepare('DELETE FROM sessions WHERE signature = ?').run(sig);
}

export function deleteSessionsForChat(tokenId, sessionId) {
  db.prepare('DELETE FROM sessions WHERE token_id = ? AND deepseek_session_id = ?').run(tokenId, sessionId);
}

// Each successful /chat/completion appends one user + one assistant message, so
// the next turn's parent is P + 2 (see the original project's note on this invariant).
export function nextParent(parentMessageId) {
  return parentMessageId + 2;
}

// --- API keys ---------------------------------------------------------------

export function addApiKey(label, apiKey) {
  db.prepare('INSERT INTO api_keys (label, api_key, created_at, active) VALUES (?, ?, ?, 1)')
    .run(label || null, apiKey, Math.floor(Date.now() / 1000));
}

export function listApiKeys() {
  return db.prepare('SELECT id, label, api_key, created_at, active FROM api_keys ORDER BY id').all();
}

export function deleteApiKey(id) {
  db.prepare('DELETE FROM api_keys WHERE id = ?').run(id);
}

export function isApiKeyValid(key) {
  if (!key) return false;
  return Boolean(db.prepare('SELECT 1 FROM api_keys WHERE api_key = ? AND active = 1').get(key));
}

// --- usage log ----------------------------------------------------------------

export function logUsage({ apiKey, endpoint, model, promptTokens, completionTokens, cost }) {
  db.prepare(`INSERT INTO usage_log (ts, api_key, endpoint, model, prompt_tokens, completion_tokens, cost)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(Math.floor(Date.now() / 1000), apiKey, endpoint, model, promptTokens, completionTokens, cost);
}

function sumWindow(sinceTs) {
  return db.prepare(`SELECT COUNT(*) AS requests,
                            COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                            COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                            COALESCE(SUM(cost), 0) AS cost
                     FROM usage_log WHERE ts >= ?`).get(sinceTs);
}

export function usageStats() {
  const now = Math.floor(Date.now() / 1000);
  return {
    total: sumWindow(0),
    day: sumWindow(now - 86400),
    week: sumWindow(now - 7 * 86400),
    byKey: db.prepare(`SELECT api_key, COUNT(*) AS requests,
                              COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens,
                              COALESCE(SUM(cost), 0) AS cost
                       FROM usage_log GROUP BY api_key ORDER BY requests DESC`).all(),
    byModel: db.prepare(`SELECT model, COUNT(*) AS requests,
                                COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS tokens,
                                COALESCE(SUM(cost), 0) AS cost
                         FROM usage_log GROUP BY model ORDER BY requests DESC`).all(),
  };
}

export function recentUsage(limit = 25) {
  return db.prepare(`SELECT id, ts, api_key, endpoint, model, prompt_tokens, completion_tokens, cost
                     FROM usage_log ORDER BY id DESC LIMIT ?`).all(limit);
}

// Flat peak-hour rates (per 1M tokens) per https://api-docs.deepseek.com/quick_start/pricing
export const DEEPSEEK_TARIFFS = {
  'deepseek-v4-flash': { cache_miss_input: 0.44, output_generation: 1.32 },
  'deepseek-v4-flash-exp': { cache_miss_input: 0.44, output_generation: 1.32 },
  'deepseek-v4-pro': { cache_miss_input: 1.32, output_generation: 3.96 },
};
