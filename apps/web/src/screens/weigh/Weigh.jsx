// Weighing — for the weigher: sizes and expected weight, big weight boxes, weigh-together. No money.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { splitBatchWeight, canWeighTogether } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { company } from '../../lib/session.js';
import { call } from '../../lib/api.js';
import { useAction } from '../../lib/action.js';
import { kg, shortDate, time } from '../../lib/format.js';
import { dimText, lengthsText, shapeName, totalPcs } from '../../lib/orders.js';
import { go } from '../../lib/router.js';
import { toast } from '../../ui/toast.js';
import { SHAPE_LOOK } from '../../config/options.js';
import { Icon, TopBar, LangPill, Skeleton } from '../../ui/kit.jsx';
import './weigh.css';

export function WeighList() {
  const [list, setList] = useState(null);
  const tz = company.value?.timezone;
  useEffect(() => { call('weighingList', {}).then(setList).catch(() => setList([])); }, []);
  return (
    <>
      <TopBar title={t('nav_weigh')} sub={list ? t('n_waiting', list.length) : ''} onBack={null} right={<LangPill />} />
      <div class="page">
        {!list ? <Skeleton h={90} /> : list.length === 0 ? <div class="card li"><div class="iconbox tone-ok"><Icon name="CircleCheck" /></div><div class="t">{t('weigh_none')}</div></div> :
          list.map((o) => (
            <button class="card li" style="margin-bottom:10px" onClick={() => go(`/weigh/${o.id}`)}>
              <div class="iconbox tone-accent"><Icon name="Scale" /></div>
              <div class="grow"><div class="t num">#{o.slip_no} · {o.customer}</div><div class="s">{t('n_items', o.items.length)} · {shortDate(o.created_at, tz)} {time(o.created_at, tz)}</div></div>
              <Icon name="ChevronRight" size={18} />
            </button>
          ))}
      </div>
    </>
  );
}

export function Weigh({ id }) {
  const [o, setO] = useState(undefined);
  const [w, setW] = useState({});            // item id → typed weight
  const [picked, setPicked] = useState([]);  // ticked for weigh-together
  const [batches, setBatches] = useState([]); // [{ item_ids, total }]
  const [total, setTotal] = useState('');
  const [warn, setWarn] = useState(null);
  const save = useAction('recordWeights');

  useEffect(() => {
    call('weighingList', { order_id: id }).then(([x]) => {
      setO(x || null);
      if (x) setW(Object.fromEntries(x.items.filter((i) => i.actual_weight != null).map((i) => [i.id, String(Number(i.actual_weight))])));
    }).catch(() => setO(null));
  }, [id]);

  const inBatch = (iid) => batches.find((b) => b.item_ids.includes(iid));
  const preview = useMemo(() => {
    const out = {};
    batches.forEach((b) => {
      const parts = splitBatchWeight(b.item_ids.map((x) => o.items.find((i) => i.id === x).expected_weight || 0), Number(b.total));
      b.item_ids.forEach((x, k) => { out[x] = parts[k]; });
    });
    return out;
  }, [batches, o]);

  if (o === undefined) return <><TopBar title={t('nav_weigh')} /><div class="page"><Skeleton h={140} /></div></>;
  if (o === null) return <><TopBar title={t('nav_weigh')} /><div class="page"><div class="card li muted">{t('weigh_none')}</div></div></>;

  const items = o.items;
  const hasWeight = (i) => inBatch(i.id) || Number(w[i.id]) > 0;
  const nDone = items.filter(hasWeight).length;
  const pickedGrade = picked.length ? items.find((i) => i.id === picked[0]).grade_code : null;
  const toggle = (i) => {
    if (inBatch(i.id)) return;
    if (picked.includes(i.id)) return setPicked(picked.filter((x) => x !== i.id));
    const next = [...picked, i.id].map((x) => items.find((it) => it.id === x));
    if (!canWeighTogether(next.map((it) => ({ matId: it.material_id })))) return toast(t('wsel_bad'));
    setPicked(next.map((it) => it.id));
  };
  const apply = () => {
    if (picked.length < 2 || !(Number(total) > 0)) return;
    setBatches([...batches, { item_ids: picked, total: Number(total) }]);
    setPicked([]); setTotal('');
  };
  const submit = async (finish) => {
    try {
      const r = await save.run({
        order_id: o.id,
        weights: items.filter((i) => !inBatch(i.id) && Number(w[i.id]) > 0).map((i) => ({ item_id: i.id, weight: Number(w[i.id]) })),
        batches: batches.map((b) => ({ total_weight: b.total, item_ids: b.item_ids })),
        submit: finish,
      });
      if (r.warnings?.length) setWarn(r.warnings);
      if (finish) { toast(t('weigh_done_msg', o.slip_no)); go('/weigh'); } else toast(t('weights_kept'));
    } catch { /* message shown below */ }
  };

  return (
    <div class="weigh">
      <TopBar title={`#${o.slip_no} · ${o.customer}`} sub={t('n_items', items.length)} right={<LangPill />} />
      <div class="page" style="padding-bottom:150px">
        {items.map((i) => {
          const b = inBatch(i.id);
          const val = b ? preview[i.id] : w[i.id] || '';
          const ok = Number(val) > 0 && i.expected_weight && Math.abs(Number(val) - i.expected_weight) / i.expected_weight <= 0.05;
          return (
            <div class={`card witem ${picked.includes(i.id) ? 'picked' : ''}`}>
              <div class="row">
                <div class="iconbox tone-neutral"><Icon name={SHAPE_LOOK[i.shape]?.icon || 'Box'} size={20} stroke={2} /></div>
                <div class="grow"><div class="wt">{i.grade_code} · {shapeName(i.shape)} <span class="num">{dimText(i)}</span></div>
                  <div class="muted num" style="font-size:14px">{lengthsText(i)} · {totalPcs(i)} {t('pcs')}</div></div>
                <button class={`tick ${picked.includes(i.id) ? 'on' : ''}`} disabled={!!b} onClick={() => toggle(i)} aria-label={t('together_hint')}>{picked.includes(i.id) && <Icon name="Check" size={18} stroke={3} />}</button>
              </div>
              <div class="row" style="margin-top:12px">
                <div class="exp"><div class="faint" style="font-size:12px;font-weight:600">{t('expected')}</div><div class="num" style="font-size:18px;font-weight:700">{i.expected_weight ? kg(i.expected_weight) : '–'}</div></div>
                <div class={`wbox ${ok ? 'ok' : ''} ${b ? 'batch' : ''}`}>
                  <input class="num" inputmode="decimal" disabled={!!b} value={val} placeholder={t('type_weight')}
                    onInput={(e) => setW({ ...w, [i.id]: e.currentTarget.value.replace(/[^\d.]/g, '') })} />
                  <span>{ok ? <Icon name="CircleCheck" size={22} stroke={2.4} /> : 'kg'}</span>
                </div>
              </div>
              {b && <div class="row" style="justify-content:space-between;margin-top:8px"><span class="faint" style="font-size:13px;font-weight:600">{t('in_batch')} · {kg(b.total)}</span>
                <button class="link" onClick={() => setBatches(batches.filter((x) => x !== b))}>{t('undo_batch')}</button></div>}
            </div>
          );
        })}

        {picked.length >= 2 ? (
          <div class="card pad together">
            <div style="font-weight:700">{t('together_title', pickedGrade, picked.length)}</div>
            <div class="row" style="margin-top:10px">
              <div class="wbox grow"><input class="num" inputmode="decimal" value={total} onInput={(e) => setTotal(e.currentTarget.value.replace(/[^\d.]/g, ''))} placeholder={t('together_total')} /><span>kg</span></div>
              <button class="btn btn-accent" disabled={!(Number(total) > 0)} onClick={apply}>{t('together_apply')}</button>
            </div>
          </div>
        ) : <div class="notice tone-accent row"><Icon name="Layers" size={20} />{t('together_hint')}</div>}

        {warn && <div class="notice tone-warn" style="margin-top:12px">{t('weigh_warn_list')} {warn.map((x) => `${kg(x.actual)} (${t('expected')} ${kg(x.expected)})`).join(', ')}</div>}
        {save.error && <div class="error">{save.error.message}</div>}
      </div>
      <div class="dock row">
        <button class="btn btn-ghost" disabled={save.busy || nDone === 0} onClick={() => submit(false)}>{t('weigh_save')}</button>
        <button class="btn btn-brand grow" disabled={save.busy || nDone < items.length} onClick={() => submit(true)}><Icon name="Check" size={20} stroke={2.6} />{t('weigh_finish', nDone, items.length)}</button>
      </div>
    </div>
  );
}
