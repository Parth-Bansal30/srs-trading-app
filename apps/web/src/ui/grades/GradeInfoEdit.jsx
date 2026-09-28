// Edit a grade's notes (in the person's own language): what it is, uses, watch out, the customer line.
// Figures (composition, strength) stay as they are. Saved through the backend (needs the Rates permission).
import { useEffect, useState } from 'preact/hooks';
import { t, lang } from '../../lib/i18n.js';
import { APP } from '../../config/app.js';
import { useAction } from '../../lib/action.js';
import { Sheet } from '../Sheet.jsx';
import { tri, triList } from './GradeInfo.jsx';

const IDX = { en: 0, hi: 1, hn: 2 };
const three = (v, fill) => { const a = Array.isArray(v) ? [...v] : [v ?? fill, v ?? fill, v ?? fill]; while (a.length < 3) a.push(a[0] ?? fill); return a; };

export function GradeInfoEdit({ m, open, onClose, onSaved }) {
  const [v, setV] = useState({ what: '', good: '', watch: '', tell: '' });
  const a = useAction('updateMaterial');
  useEffect(() => {
    if (!open || !m) return;
    const i = m.info || {};
    setV({ what: tri(i.what), good: triList(i.good).join('\n'), watch: tri(i.watch), tell: tri(i.tell) });
  }, [open, m?.id]);
  if (!m) return null;
  const k = IDX[lang.value] ?? 0;
  const save = () => {
    const i = structuredClone(m.info || {});
    for (const f of ['what', 'watch', 'tell']) { const arr = three(i[f], ''); arr[k] = v[f].trim(); i[f] = arr; }
    const good = Array.isArray(i.good) && Array.isArray(i.good[0]) ? i.good.map((x) => [...x]) : [[], [], []];
    while (good.length < 3) good.push([...good[0]]);
    good[k] = v.good.split('\n').map((x) => x.trim()).filter(Boolean);
    i.good = good;
    a.run({ material_id: m.id, changes: { info: i } }).then(onSaved).catch(() => {});
  };
  const set = (f) => (e) => setV({ ...v, [f]: e.currentTarget.value });
  const langName = APP.languages.find((x) => x.id === lang.value)?.label || '';
  return (
    <Sheet open={open} onClose={onClose} title={`${t('gi_edit')} · ${m.code}`}
      footer={<button class="btn btn-accent btn-block" disabled={a.busy || !v.what.trim()} onClick={save}>{t('save')}</button>}>
      <div class="faint" style="font-size:13px;font-weight:600;margin-bottom:12px">{t('gi_edit_note', langName)}</div>
      <div class="lbl">{t('gi_edit_what')}</div>
      <textarea class="textarea" rows={5} value={v.what} onInput={set('what')} />
      <div class="lbl" style="margin-top:12px">{t('gi_edit_uses')}</div>
      <textarea class="textarea" rows={6} value={v.good} onInput={set('good')} />
      <div class="lbl" style="margin-top:12px">{t('gi_watch')}</div>
      <textarea class="textarea" rows={3} value={v.watch} onInput={set('watch')} />
      <div class="lbl" style="margin-top:12px">{t('gi_tell')}</div>
      <textarea class="textarea" rows={2} value={v.tell} onInput={set('tell')} />
      {a.error && <div class="error">{a.error.message}</div>}
    </Sheet>
  );
}
