// Weighing — for the weigher: sizes and expected weight, big weight boxes, weigh-together. No money.
// 26 Oct 2026 (walkthrough): a weight far from the size is shown in red with the likely right number, and finishing
// asks once more ("180 typed for 18.0" went through and billed ten times). Below the list: what was weighed today,
// with "Weigh again" while the slip is not finished.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { splitBatchWeight, canWeighTogether, calcItem, weightCheck } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { company } from '../../lib/session.js';
import { call } from '../../lib/api.js';
import { useAction } from '../../lib/action.js';
import { kg, shortDate, time } from '../../lib/format.js';
import { dimText, lengthsText, shapeName, totalPcs } from '../../lib/orders.js';
import { go } from '../../lib/router.js';
import { online } from '../../lib/net.js';
import { outbox, outboxVersion } from '../../lib/offline/outbox.js';
import { weighingOverlay } from '../../lib/offline/overlay.js';
import { usesOf } from '../../lib/offline/local.js';
import { toast } from '../../ui/toast.js';
import { SHAPE_LOOK } from '../../config/options.js';
import { Icon, TopBar, LangPill, Skeleton, Chip } from '../../ui/kit.jsx';
import { Sheet } from '../../ui/Sheet.jsx';
import './weigh.css';

/** Expected kg of an item from its sizes (for slips made on this phone). */
const expectedOf = (i, o) => {
  const c = calcItem({ shape: i.shape, unit: i.unit, d: i.dims, rows: (i.order_item_lengths || []).map((l) => ({ len: l.len ?? '', pcs: l.pcs, cuts: l.cuts ?? '' })),
    rate: 0, cutRate: 0, density: Number(i.density) }, 'est', { minInch: o?.pricing_rules?.min_inch ?? 1 });
  return c ? c.est : null;
};
/** The weighing list with what waits on this phone (new slips made offline, weights not sent yet). */
const withWaiting = (list) => weighingOverlay(list || [], outbox.value, expectedOf);
const itemName = (i) => `${i.grade_code} · ${shapeName(i.shape)} ${dimText(i)}`;

export function WeighList() {
  const [list, setList] = useState(null);
  const [done, setDone] = useState(null);
  const [again, setAgain] = useState(null); // slip to weigh again
  const tz = company.value?.timezone;
  const loadDone = () => call('weighedList', {}).then(setDone).catch(() => setDone([]));
  useEffect(() => { call('weighingList', {}).then((l) => setList(withWaiting(l))).catch(() => setList(withWaiting([]))); }, [outboxVersion.value]);
  useEffect(() => { if (online.value) loadDone(); }, [outboxVersion.value]);
  return (
    <>
      <TopBar title={t('nav_weigh')} sub={list ? t('n_waiting', list.length) : ''} onBack={null} right={<LangPill />} />
      <div class="page" style="padding-bottom:calc(var(--tabbar-h) + 30px)">
        {!list ? <Skeleton h={90} /> : list.length === 0 ? <div class="card li"><div class="iconbox tone-ok"><Icon name="CircleCheck" /></div><div class="t">{t('weigh_none')}</div></div> :
          list.map((o) => (
            <button class="card li" style="margin-bottom:10px" onClick={() => go(`/weigh/${o.id}`)}>
              <div class="iconbox tone-accent"><Icon name="Scale" /></div>
              <div class="grow"><div class="t num">#{o.slip_no} · {o.customer}</div><div class="s">{o.pending && <><Icon name="CloudUpload" size={12} /> {t('off_waiting')} · </>}{t('n_items', o.items.length)} · {shortDate(o.created_at, tz)} {time(o.created_at, tz)}</div></div>
              <Icon name="ChevronRight" size={18} />
            </button>
          ))}
        {done?.length > 0 && <>
          <div class="sec"><h3>{t('weighed_today')}</h3></div>
          <div class="card">{done.map((o) => (
            <div class="li weighed-row">
              <div class={`iconbox tone-${o.status === 'done' ? 'ok' : 'neutral'}`}><Icon name={o.status === 'done' ? 'CircleCheck' : 'Scale'} size={18} /></div>
              <div class="grow" style="min-width:0">
                <div class="t num ellip">#{o.slip_no} · {o.customer}</div>
                <div class="s num">{kg(o.weight)} · {o.weighed_at ? `${shortDate(o.weighed_at, tz)} ${time(o.weighed_at, tz)}` : ''}</div>
                <div class="s">{(o.items || []).map((i) => `${i.grade_code} ${dimText(i)} ${kg(i.actual_weight)}`).join(' · ')}</div>
              </div>
              {o.status === 'weighed' ? <button class="pill" onClick={() => setAgain(o)}><Icon name="RotateCcw" size={15} />{t('weigh_again')}</button>
                : <Chip tone="ok">{t('st_done')}</Chip>}
            </div>
          ))}</div>
        </>}
      </div>
      <WeighAgainSheet o={again} onClose={() => setAgain(null)} onDone={(id) => { setAgain(null); go(`/weigh/${id}`); }} />
    </>
  );
}

/** "Weigh #… again?" — used on the weighing list, the slip page and at pickup. */
export function WeighAgainSheet({ o, onClose, onDone }) {
  const a = useAction('reopenWeighing');
  useEffect(() => { if (o) a.setError(null); }, [o?.id]);
  return (
    <Sheet open={!!o} onClose={onClose} title={o ? t('weigh_again_t', o.slip_no) : ''}
      footer={<button class="btn btn-accent btn-block" disabled={a.busy || !online.value}
        onClick={() => a.run({ order_id: o.id }).then(() => { toast(t('weigh_again_done', o.slip_no)); onDone?.(o.id); }).catch(() => {})}>
        <Icon name="RotateCcw" size={19} stroke={2.4} />{t('weigh_again')}</button>}>
      <div class="muted" style="font-size:14.5px;line-height:1.45">{t('weigh_again_s')}</div>
      {!online.value && <div class="notice tone-warn" style="margin-top:10px">{t('off_needs_net')}</div>}
      {a.error && <div class="error">{a.error.message}</div>}
    </Sheet>
  );
}

export function Weigh({ id }) {
  const [o, setO] = useState(undefined);
  const [w, setW] = useState({});            // item id → typed weight
  const [picked, setPicked] = useState([]);  // ticked for weigh-together
  const [batches, setBatches] = useState([]); // [{ item_ids, total }]
  const [total, setTotal] = useState('');
  const [warn, setWarn] = useState(null);
  const [sure, setSure] = useState(null);    // items to check before finishing
  const save = useAction('recordWeights');

  useEffect(() => {
    const pick = (list) => withWaiting(list).find((x) => x.id === id) || null;
    const show = (x) => {
      setO(x || null);
      if (x) setW(Object.fromEntries(x.items.filter((i) => i.actual_weight != null).map((i) => [i.id, String(Number(i.actual_weight))])));
    };
    // without internet: the kept weighing list, or a slip made on this phone
    call('weighingList', { order_id: id }).then((l) => show(pick(l)))
      .catch(() => call('weighingList', {}).then((l) => show(pick(l))).catch(() => show(pick([]))));
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
  const valOf = (i) => (inBatch(i.id) ? preview[i.id] : w[i.id] || '');
  const checkOf = (i) => weightCheck(i.expected_weight, valOf(i));
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
      const weights = items.filter((i) => !inBatch(i.id) && Number(w[i.id]) > 0).map((i) => ({ item_id: i.id, weight: Number(w[i.id]) }));
      const all = { ...Object.fromEntries(weights.map((x) => [x.item_id, x.weight])), ...preview };
      const r = await save.run({ order_id: o.id, weights, batches: batches.map((b) => ({ total_weight: b.total, item_ids: b.item_ids })), submit: finish },
        { local: { meta: { uses: usesOf(o.id), slipNo: o.slip_no, customer: o.customer, patch: { weights: all, submit: finish } } } });
      if (r.warnings?.length) setWarn(r.warnings);
      if (r.pending) toast(t('off_saved_phone'));
      else if (finish) toast(t('weigh_done_msg', o.slip_no)); else toast(t('weights_kept'));
      if (finish) go('/weigh');
    } catch { /* message shown below */ }
  };
  // finishing with a weight very different from its size: ask once more
  const finish = () => {
    const far = items.filter((i) => checkOf(i)?.level === 'far');
    if (far.length) return setSure(far);
    submit(true);
  };

  return (
    <div class="weigh">
      <TopBar title={`#${o.slip_no} · ${o.customer}`} sub={t('n_items', items.length)} right={<LangPill />} />
      <div class="page" style="padding-bottom:150px">
        {items.map((i) => {
          const b = inBatch(i.id);
          const val = valOf(i);
          const c = checkOf(i);
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
                <div class={`wbox ${c?.level === 'ok' ? 'ok' : c?.level || ''} ${b ? 'batch' : ''}`}>
                  <input class="num" id={`w-${i.id}`} inputmode="decimal" disabled={!!b} value={val} placeholder={t('type_weight')}
                    onInput={(e) => setW({ ...w, [i.id]: e.currentTarget.value.replace(/[^\d.]/g, '') })} />
                  <span>{c?.level === 'ok' ? <Icon name="CircleCheck" size={22} stroke={2.4} /> : c?.level === 'far' ? <Icon name="TriangleAlert" size={22} stroke={2.4} /> : 'kg'}</span>
                </div>
              </div>
              {c && c.level !== 'ok' && (
                <div class={`wcheck ${c.level}`}>
                  <span class="grow">{t(c.level === 'far' ? 'wc_far' : 'wc_near', kg(i.expected_weight, 1))}</span>
                  {c.suggest && !b && <button class="pill" onClick={() => setW({ ...w, [i.id]: String(c.suggest) })}>{t('wc_use', kg(c.suggest))}</button>}
                </div>
              )}
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
        <button class="btn btn-brand grow" disabled={save.busy || nDone < items.length} onClick={finish}><Icon name="Check" size={20} stroke={2.6} />{t('weigh_finish', nDone, items.length)}</button>
      </div>
      <Sheet open={!!sure} onClose={() => setSure(null)} title={t('wc_sure_t')}
        footer={<>
          <button class="btn btn-accent btn-block" onClick={() => { const first = sure[0]; setSure(null); setTimeout(() => document.getElementById(`w-${first.id}`)?.focus(), 250); }}>
            <Icon name="Pencil" size={18} stroke={2.4} />{t('wc_fix')}</button>
          <button class="btn btn-ghost btn-block" style="margin-top:8px" disabled={save.busy} onClick={() => { setSure(null); submit(true); }}>{t('wc_scale')}</button>
        </>}>
        <div class="muted" style="font-size:14px;margin-bottom:10px;line-height:1.45">{t('wc_sure_s')}</div>
        <div class="card wsure">{(sure || []).map((i) => { const c = checkOf(i); return (
          <div class="li"><span style="color:var(--bad);flex:none;margin-top:2px"><Icon name="TriangleAlert" size={18} stroke={2.4} /></span>
            <div class="grow"><div class="t" style="font-size:15px">{itemName(i)}</div>
              <div class="s num">{t('wc_line', kg(valOf(i)), kg(i.expected_weight, 1))} · <b style="color:var(--bad)">{c.times > 1 ? t('wc_times', c.times) : t('wc_less')}</b></div></div></div>); })}</div>
      </Sheet>
    </div>
  );
}
