/**
 * Talks to the Supabase dev project over HTTPS (Management API). The access token is read
 * from .env (git-ignored) and never printed. Direct database connections aren't available
 * from Claude's shell, so all database work goes through here.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || 'xwyhgsukvspwinsskyjo'; // srs-trading-dev

function token() {
  if (process.env.SUPABASE_ACCESS_TOKEN) return process.env.SUPABASE_ACCESS_TOKEN;
  const envFile = path.join(ROOT, '.env');
  if (fs.existsSync(envFile)) {
    const line = fs.readFileSync(envFile, 'utf8').split(/\r?\n/).find((l) => l.startsWith('SUPABASE_ACCESS_TOKEN='));
    if (line) return line.slice('SUPABASE_ACCESS_TOKEN='.length).trim();
  }
  throw new Error('SUPABASE_ACCESS_TOKEN missing (put it in .env)');
}

/** Run SQL; returns the rows of the last statement. Throws with the database's message on error. */
export async function query(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text;
    try { msg = JSON.parse(text).message || text; } catch {}
    const err = new Error(msg.replace(/^Failed to run sql query: /, ''));
    err.status = res.status;
    throw err;
  }
  return JSON.parse(text);
}

/** SQL string literal. */
export const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
