// Shows a full-size paper (slip / statement) shrunk to fit the screen width.
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

export function Preview({ children, max = 1 }) {
  const box = useRef(null); const inner = useRef(null);
  const [fit, setFit] = useState({ s: 0.5, h: 300 });
  useLayoutEffect(() => {
    const measure = () => {
      if (!box.current || !inner.current) return;
      const avail = box.current.clientWidth - 28;
      const w = inner.current.offsetWidth || 1;
      const s = Math.min(max, avail / w);
      setFit({ s, h: inner.current.offsetHeight * s });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box.current); ro.observe(inner.current);
    return () => ro.disconnect();
  }, [children]);
  return (
    <div class="pp-preview" ref={box}>
      <div style={`width:${(inner.current?.offsetWidth || 0) * fit.s}px;height:${fit.h}px`}>
        <div class="pp-scale" ref={inner} style={`transform:scale(${fit.s});width:max-content`}>{children}</div>
      </div>
    </div>
  );
}
