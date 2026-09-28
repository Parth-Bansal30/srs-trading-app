// The app's own pictures: the brand mark (same as the home-screen icon) and the stack of steel rounds.

/** Saffron tile with three bars — the app icon. `light` = bars in cream, for dark backgrounds. */
export function Mark({ size = 40, light = false }) {
  const bar = light ? '#F5F3EE' : '#1B2130';
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <rect width="48" height="48" rx="14" fill="#E08A2B" />
      <rect x="11" y="12" width="26" height="6" rx="3" fill={bar} />
      <rect x="11" y="21" width="20" height="6" rx="3" fill={bar} opacity=".85" />
      <rect x="11" y="30" width="14" height="6" rx="3" fill={bar} opacity=".7" />
    </svg>
  );
}

let pileId = 0;
/** End view of a stack of round bars. `hot` = which ones are saffron (counted from the bottom-left). */
export function Pile({ rows = 6, r = 22, hot = [], width = 360, fade = false }) {
  const id = `p${++pileId}`;
  const H = rows * r * 1.75 + r;
  const out = [];
  let k = 0;
  for (let row = 0; row < rows; row++) {
    const n = rows - row;
    const y = H - r - row * r * 1.74;
    const x0 = width / 2 - (n - 1) * r * 1.02;
    for (let i = 0; i < n; i++, k++) {
      const x = x0 + i * r * 2.04;
      const h = hot.includes(k);
      out.push(
        <g key={k}>
          <circle cx={x} cy={y} r={r} fill={`url(#${id}${h ? 'h' : 'c'})`} stroke={h ? '#F6B874' : fade ? 'rgba(0,0,0,.08)' : 'rgba(255,255,255,.14)'} stroke-width="1.2" />
          <circle cx={x} cy={y} r={r * 0.62} fill="none" stroke={h ? 'rgba(43,23,0,.25)' : fade ? 'rgba(0,0,0,.06)' : 'rgba(255,255,255,.07)'} stroke-width="1.2" />
          <circle cx={x - r * 0.3} cy={y - r * 0.32} r={r * 0.16} fill={`rgba(255,255,255,${h ? 0.45 : 0.12})`} />
        </g>,
      );
    }
  }
  return (
    <svg width={width} height={H} viewBox={`0 0 ${width} ${H}`} aria-hidden="true" style="display:block">
      <defs>
        <radialGradient id={`${id}c`} cx="35%" cy="30%" r="80%">
          <stop offset="0" stop-color={fade ? '#B9B3A8' : '#4A5570'} /><stop offset="1" stop-color={fade ? '#8F887C' : '#262D3F'} />
        </radialGradient>
        <radialGradient id={`${id}h`} cx="35%" cy="30%" r="80%"><stop offset="0" stop-color="#F7B363" /><stop offset="1" stop-color="#C9731C" /></radialGradient>
      </defs>
      {out}
    </svg>
  );
}
