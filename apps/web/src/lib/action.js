// Runs a change through the api with a request key that is REUSED if the person taps again
// with exactly the same details (so a retry never saves twice), and fresh otherwise.
// opts.local = { meta, result }: without internet the change is kept on the phone (see lib/offline/outbox.js).
import { useState, useRef } from 'preact/hooks';
import { call, newKey } from './api.js';

export function useAction(op) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const last = useRef({ key: null, body: null });
  const run = async (args, opts = {}) => {
    const body = JSON.stringify(args);
    if (last.current.body !== body) last.current = { key: newKey(), body };
    setBusy(true); setError(null);
    try {
      // a function is only called when the change is really kept on the phone (no internet)
      const k = last.current.key;
      const local = typeof opts.local === 'function' ? () => opts.local(k) : opts.local;
      const data = await call(op, args, { key: last.current.key, local });
      last.current = { key: null, body: null };
      return data;
    } catch (e) { setError(e); throw e; }
    finally { setBusy(false); }
  };
  return { run, busy, error, setError };
}
