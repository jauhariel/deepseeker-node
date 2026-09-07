import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const BASE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(BASE_DIR);

dotenv.config();

export const API_KEY = process.env.DEEPSEEKER_API_KEY || 'dseeker';
export const ADMIN_USER = process.env.DEEPSEEKER_ADMIN_USER || 'admin';
export const ADMIN_PASSWORD = process.env.DEEPSEEKER_ADMIN_PASSWORD || 'admin';
export const HOST = process.env.HOST || '127.0.0.1';
export const PORT = parseInt(process.env.PORT || '4000', 10);

// Token budgets for injected history when (re)building a session prompt.
export const MAX_HISTORY_TOKENS = parseInt(process.env.DEEPSEEKER_MAX_HISTORY_TOKENS || '24000', 10);
export const MAX_TOOL_RESULTS_TOKENS = parseInt(process.env.DEEPSEEKER_MAX_TOOL_RESULT_TOKENS || '12000', 10);

export const DEEPSEEK_BASE = 'https://chat.deepseek.com';
export const COOKIE_FILE = path.join(BASE_DIR, 'aws_cookies_deepseek.json');
export const WASM_PATH = path.join(BASE_DIR, 'wasm', 'deepseek_pow_solver.wasm');
export const DB_FILE = path.join(BASE_DIR, 'deeperseeker.db');

// When set (1/true/yes), never launch Chromium for WAF cookies — requests go
// cookieless and a WAF challenge becomes a hard error instead of a browser launch.
export const DISABLE_BROWSER = /^(1|true|yes)$/i.test(process.env.DEEPSEEKER_DISABLE_BROWSER || '');

// Public-facing base URL shown in docs/dashboard (e.g. https://api.example.com).
// When unset, pages derive it from the incoming request's Host header.
export const PUBLIC_URL = (process.env.DEEPSEEKER_PUBLIC_URL || '').replace(/\/+$/, '');

// Model used when a request does not specify one.
const _defaultModel = (process.env.DEEPSEEKER_DEFAULT_MODEL || 'instant').toLowerCase();
export const DEFAULT_MODEL = ['instant', 'vision', 'expert'].includes(_defaultModel) ? _defaultModel : 'instant';

// When set (1/true/yes), every chat request runs with thinking enabled,
// regardless of what the client sends (escape hatch for clients that
// cannot toggle reasoning themselves).
export const FORCE_THINKING = /^(1|true|yes)$/i.test(process.env.DEEPSEEKER_FORCE_THINKING || '');
