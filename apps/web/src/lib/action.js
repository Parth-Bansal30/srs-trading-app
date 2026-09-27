// Runs a change through the api with a request key that is REUSED if the person taps again
// with exactly the same details (so a retry never saves twice), and fresh otherwise.
import { useState, useRef } from 'preact/hooks';
import { call } from './api.js';

export function useAction(op) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const last = useRef({ key: null, body: null });
  const run = async (args) => {
    const body = JSON.stringify(args);
    if (last.current.body !== body) last.current = { key: crypto.randomUUID ? crypto.randomUUID() : String(Math.random()), body };
    setBusy(true); setError(null);
    try { const data = await call(op, args, { key: last.current.key }); last.current = { key: null, body: null }; return data; }
    catch (e) { setError(e); throw e; }
    finally { setBusy(false); }
  };
  return { run, busy, error, setError };
}
