// Choose a grade from the shop's list (search by name).
import { useState } from 'preact/hooks';
import { t } from '../../lib/i18n.js';
import { can } from '../../lib/session.js';
import { money } from '../../lib/format.js';
import { Sheet } from '../../ui/Sheet.jsx';
import { Icon } from '../../ui/kit.jsx';
import { GradeInfo, InfoButton } from '../../ui/grades/GradeInfo.jsx';

export function GradePicker({ open, materials, onClose, onPick }) {
  const [q, setQ] = useState('');
  const [info, setInfo] = useState(null);
  const list = materials.filter((m) => m.active && m.code.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <>
    <Sheet open={open && !info} onClose={onClose} title={t('choose_grade')}>
      <div class="field" style="margin-bottom:12px"><Icon name="Search" size={18} /><input value={q} onInput={(e) => setQ(e.currentTarget.value)} placeholder={t('search_grade')} /></div>
      <div class="card">
        {list.map((m) => (
          <button class="li" onClick={() => onPick(m)}>
            <div class="grow"><div class="t">{m.code}</div><div class="s">{t(`fam_${m.family}`)}</div></div>
            {can('money') && m.sell_rate != null && <span class="num" style="font-weight:700">{money(m.sell_rate)}/kg</span>}
            <InfoButton onClick={() => setInfo(m)} label={`${m.code} info`} />
          </button>
        ))}
      </div>
    </Sheet>
    <GradeInfo m={info} materials={materials} open={open && !!info} onClose={() => setInfo(null)}
      onUse={(alt) => { setInfo(null); onPick(alt); }} />
    </>
  );
}
