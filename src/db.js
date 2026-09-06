import Database from 'better-sqlite3';
import { DB_FILE } from './config.js';

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
  `);
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

export function saveSession(sig, tokenId, sessionId, parentMessageId = 0) {
  db.prepare(`INSERT OR REPLACE INTO sessions (signature, token_id, deepseek_session_id, parent_message_id)
              VALUES (?, ?, ?, ?)`).run(sig, tokenId, sessionId, parentMessageId);
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

// Flat peak-hour rates (per 1M tokens) per https://api-docs.deepseek.com/quick_start/pricing
export const DEEPSEEK_TARIFFS = {
  'deepseek-v4-flash': { cache_miss_input: 0.44, output_generation: 1.32 },
  'deepseek-v4-flash-exp': { cache_miss_input: 0.44, output_generation: 1.32 },
  'deepseek-v4-pro': { cache_miss_input: 1.32, output_generation: 3.96 },
};
