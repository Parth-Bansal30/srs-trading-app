// A panel that slides up from the bottom (phones) / a centred dialog (laptops).
import { useEffect } from 'preact/hooks';
import { Icon } from './kit.jsx';

export function Sheet({ open, onClose, title, children, footer }) {
  useEffect(() => {
    if (!open) return;
    const k = (e) => e.key === 'Escape' && onClose?.();
    addEventListener('keydown', k);
    document.body.style.overflow = 'hidden';
    return () => { removeEventListener('keydown', k); document.body.style.overflow = ''; };
  }, [open]);
  if (!open) return null;
  return (
    <div class="sheet-wrap" onClick={(e) => e.target === e.currentTarget && onClose?.()}>
      <div class="sheet" role="dialog" aria-modal="true">
        <div class="sheet-grab" />
        <div class="row" style="margin-bottom:12px">
          <div class="grow" style="font-size:19px;font-weight:800;letter-spacing:-.02em">{title}</div>
          {onClose && <button class="round" onClick={onClose} aria-label="close"><Icon name="X" size={18} /></button>}
        </div>
        <div class="sheet-body">{children}</div>
        {footer && <div class="sheet-foot">{footer}</div>}
      </div>
    </div>
  );
}
