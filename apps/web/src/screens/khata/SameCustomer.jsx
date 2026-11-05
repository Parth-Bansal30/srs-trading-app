// "Already in khata?" while a customer is added (6 Nov 2026, plan v2 F9). Same phone (last 10 digits) → a clear
// question; a very similar name → a softer one. "Use this one" picks the customer already there; "Different person"
// saves the new one and the answer is kept (the server remembers it, and a later check never asks again).
// Nothing is decided by the app.
import { useEffect, useRef, useState } from 'preact/hooks';
import { similarCustomers } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { call } from '../../lib/api.js';
import { online } from '../../lib/net.js';
import { money } from '../../lib/format.js';
import { avatarColour, firstLetter } from '../../lib/customers.js';
import { loadCatalog } from '../../lib/catalog.js';
import { Icon } from '../../ui/kit.jsx';
import './khata.css';

/**
 * const same = useSameCustomer(customers)
 *   await same.ask({ name, phone }) → true when it may save now (no match, or already answered); else shows the box
 *   same.box(onUse) → the question (null when not asking); same.notSame → ids to send as not_same
 */
export function useSameCustomer(customers) {
  const [hits, setHits] = useState(null);
  const [brief, setBrief] = useState({});
  const [answered, setAnswered] = useState([]);
  const [said, setSaid] = useState(false);
  const ref = useRef(null);
  useEffect(() => { if (hits) requestAnimationFrame(() => ref.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' })); }, [hits]);
  const reset = () => { setHits(null); setBrief({}); setAnswered([]); setSaid(false); };
  const ask = async (who) => {
    if (said) return true;
    // the newest list (a customer added a minute ago on another phone counts too); without internet, the phone's copy
    let list = customers || [];
    if (online.value) { try { list = (await loadCatalog(true)).customers || list; } catch { /* the phone's copy */ } }
    const m = similarCustomers(list, who, answered);
    if (!m.length) return true;
    setHits(m);
    if (online.value) {
      call('customerBrief', { ids: m.slice(0, 3).map((x) => x.c.id) })
        .then((l) => setBrief(Object.fromEntries((l || []).map((b) => [b.id, b])))).catch(() => {});
    }
    return false;
  };
  const different = () => { const ids = [...answered, ...(hits || []).map((x) => x.c.id)]; setAnswered(ids); setSaid(true); setHits(null); return ids; };
  const box = (onUse, onDifferent) => hits && (
    <div class={`same-box ${hits[0].strong ? 'strong' : ''}`} ref={ref}>
      <div class="t"><Icon name="Users" size={17} /> {hits[0].strong ? t('same_t_phone') : t('same_t_name')}</div>
      {hits.slice(0, 3).map(({ c, why }) => {
        const b = brief[c.id];
        return (
          <div class="same-row">
            <span class="cav sm" style={`background:${avatarColour(c.id)}`}>{firstLetter(c.name)}</span>
            <span class="grow" style="min-width:0"><b class="ellip" style="display:block">{c.name}</b>
              <span class="s">{[why === 'phone' ? t('same_why_phone', c.phone || '') : t('same_why_name'),
                b && b.slips != null ? t('same_slips', b.slips) : null, b && b.due > 0 ? t('same_due', money(b.due, false)) : null].filter(Boolean).join(' · ')}</span></span>
            <button class="btn btn-brand" style="min-height:40px;padding:0 14px" onClick={() => onUse(c)}>{t('same_use')}</button>
          </div>
        );
      })}
      <button class="btn btn-ghost btn-block" style="margin-top:8px" onClick={() => { const ids = different(); onDifferent?.(ids); }}>{t('same_different')}</button>
    </div>
  );
  return { ask, box, reset, asking: !!hits, notSame: answered };
}
