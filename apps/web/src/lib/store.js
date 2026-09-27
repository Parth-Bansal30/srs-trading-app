// Small wrapper around the phone's local storage (can be unavailable in private mode).
export const store = {
  get(k) { try { return localStorage.getItem(`srs:${k}`); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(`srs:${k}`); else localStorage.setItem(`srs:${k}`, v); } catch { /* ignore */ } },
  json(k) { try { return JSON.parse(localStorage.getItem(`srs:${k}`) || 'null'); } catch { return null; } },
  setJson(k, v) { this.set(k, v == null ? null : JSON.stringify(v)); },
};
