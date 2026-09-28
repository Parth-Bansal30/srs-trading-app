// New order (and editing an estimate): customer → items → live quote → Save estimate / Accept (+ advance).
// All maths comes from @srs/core (same as the approved prototype); the backend checks it again on save.
import { useEffect, useMemo, useState } from 'preact/hooks';
import { calcItem, orderTotals, SHAPES, DEFAULT_FAMILY_DENSITY, convLen, r2 } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { can, company } from '../../lib/session.js';
import { loadCatalog, customerRates } from '../../lib/catalog.js';
import { db } from '../../lib/backend.js';
import { useAction } from '../../lib/action.js';
import { call } from '../../lib/api.js';
import { store } from '../../lib/store.js';
import { money, kg } from '../../lib/format.js';
import { go, route } from '../../lib/router.js';
import { toast } from '../../ui/toast.js';
import { Icon, Chip, TopBar, Skeleton } from '../../ui/kit.jsx';
import { Sheet } from '../../ui/Sheet.jsx';
import { PAY_METHODS } from '../../config/options.js';
import { ItemCard } from './ItemCard.jsx';
import { CustomerPicker } from './CustomerPicker.jsx';
import './order.css';

const DRAFT = 'draft:new-order';
const blankItem = (unit = 'mm') => ({ key: Math.random().toString(36).slice(2), material_id: null, shape: 'round', unit, d: [''], rows: [{ len: '', pcs: '', cuts: '' }], rate: null, cut_rate: null });

export function NewOrder() {
  const editId = route.value.query.edit || null;
  const [cat, setCat] = useState(null);
  const [customer, setCustomer] = useState(null);
  const [special, setSpecial] = useState(new Map());
  const [items, setItems] = useState(null);
  const [editing, setEditing] = useState(null); // order being edited (estimate)
  const [pickCust, setPickCust] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);
  const [problem, setProblem] = useState(null);
  const create = useAction('createOrder');
  const update = useAction('updateOrder');

  // load grades/rates/settings, then either the estimate being edited or the saved draft
  useEffect(() => {
    loadCatalog().then(async (c) => {
      setCat(c);
      if (editId) {
        const { data: o } = await db.from('orders').select('id,slip_no,status,customer_id,customers(id,name,phone),order_items(position,material_id,shape,unit,dims,sell_rate,cut_rate,special_rate,order_item_lengths(position,len,pcs,cuts))').eq('id', editId).single();
        setEditing(o);
        setCustomer(o.customers);
        setItems(o.order_items.sort((a, b) => a.position - b.position).map((i) => ({
          key: Math.random().toString(36).slice(2), material_id: i.material_id, shape: i.shape, unit: i.unit, d: i.dims,
          rows: i.order_item_lengths.sort((a, b) => a.position - b.position).map((l) => ({ len: l.len ?? '', pcs: String(l.pcs), cuts: l.cuts == null ? '' : String(l.cuts) })),
          rate: i.special_rate ? null : Number(i.sell_rate), cut_rate: Number(i.cut_rate),
        })));
      } else {
        const d = store.json(DRAFT);
        if (d?.items?.length) { setItems(d.items); setCustomer(d.customer); } else setItems([blankItem(c.settings?.default_unit)]);
        // "New order" from a customer's page: that customer is already chosen
        const pre = route.value.query.customer && c.customers.find((x) => x.id === route.value.query.customer);
        if (pre) setCustomer({ id: pre.id, name: pre.name, phone: pre.phone });
      }
    });
  }, [editId]);

  useEffect(() => { customerRates(customer?.id).then(setSpecial); }, [customer?.id]);
  useEffect(() => { if (!editId && items) store.setJson(DRAFT, { customer, items }); }, [customer, items]); // survive a closed app

  const settings = cat?.settings || {};
  const minInch = settings.min_inch ?? 1;
  const fam = { ...DEFAULT_FAMILY_DENSITY, ...(settings.family_density || {}) };
  const matOf = (id) => cat?.materials.find((m) => m.id === id);

  /** What the item looks like to the maths: resolved rate, density, and its calculation. */
  const resolve = (it) => {
    const m = matOf(it.material_id);
    if (!m) return { m: null, calc: null };
    const sp = special.get(m.id);
    const auto = sp != null ? sp : m.sell_rate != null ? Number(m.sell_rate) : 0;
    const rate = it.rate != null && it.rate !== '' ? Number(it.rate) : auto;
    const cutRate = it.cut_rate != null && it.cut_rate !== '' ? Number(it.cut_rate) : Number(m.cut_rate ?? 0);
    const density = m.density_override != null ? Number(m.density_override) : Number(fam[m.family]);
    const core = { matId: m.id, shape: it.shape, unit: it.unit, d: it.d, rows: it.rows, rate, cutRate, density, aw: null };
    return { m, rate, cutRate, isSpecial: sp != null && rate === sp, core, calc: calcItem(core, 'est', { minInch }) };
  };
  const resolved = useMemo(() => (items || []).map(resolve), [items, cat, special]);
  const totals = useMemo(() => {
    const coreItems = resolved.filter((r) => r.calc).map((r) => r.core);
    const opt = { minInch, gstPct: Number(settings.gst_pct ?? 18), kachaPct: Number(settings.kacha_pct ?? 10) };
    return {
      plain: orderTotals({ items: coreItems }, 'est', { ...opt, bill: null }),
      gst: orderTotals({ items: coreItems }, 'est', { ...opt, bill: 'pakka' }),
      none: orderTotals({ items: coreItems }, 'est', { ...opt, bill: 'kacha' }),
    };
  }, [resolved]);

  const setItem = (i, patch) => setItems(items.map((x, k) => (k === i ? { ...x, ...patch } : x)));
  const changeUnit = (i, to) => {
    const it = items[i];
    if (it.unit === to) return;
    setItem(i, { unit: to, d: it.d.map((v) => convLen(v, it.unit, to)), rows: it.rows.map((r) => ({ ...r, len: convLen(r.len, it.unit, to) })) });
  };

  const payload = () => ({
    customer_id: customer?.id,
    items: items.map((it) => ({
      material_id: it.material_id, shape: it.shape, unit: it.unit, d: it.d.slice(0, SHAPES[it.shape].dims.length),
      rows: it.rows.filter((r) => r.len !== '' || r.pcs !== '').map((r) => ({ len: r.len, pcs: Number(r.pcs), cuts: r.cuts === '' ? '' : Number(r.cuts) })),
      ...(can('price') && it.rate != null && it.rate !== '' ? { rate: Number(it.rate) } : {}),
      ...(can('price') && it.cut_rate != null && it.cut_rate !== '' ? { cut_rate: Number(it.cut_rate) } : {}),
    })),
  });
  const check = () => {
    if (!customer) return t('need_cust');
    const bad = resolved.findIndex((r) => !r.calc);
    return bad >= 0 ? t('need_item', bad + 1) : null;
  };

  const save = async (accept, advance) => {
    const p = check();
    setProblem(p);
    if (p) return;
    try {
      if (editing) {
        await update.run({ order_id: editing.id, ...payload() });
        if (accept) {
          await call('acceptOrder', { order_id: editing.id, advance });
        }
        toast(accept ? t('accepted_msg', editing.slip_no) : t('saved_msg', editing.slip_no));
        go(`/slip/${editing.id}`);
      } else {
        const r = await create.run({ ...payload(), accept, advance });
        store.set(DRAFT, null);
        toast(accept ? t('accepted_msg', r.slip_no) : t('saved_msg', r.slip_no));
        go(`/slip/${r.order_id}`);
      }
    } catch (e) { setProblem(e.message); }
  };
  const busy = create.busy || update.busy;

  if (!cat || !items) return <><TopBar title={t('nav_new')} /><div class="page"><Skeleton h={80} /><Skeleton h={320} style="margin-top:12px" /></div></>;

  return (
    <div class="order-screen">
      <TopBar title={editing ? t('edit_order') : t('nav_new')} sub={editing ? `#${editing.slip_no} · ${t('st_estimate')}` : t('st_estimate')}
        right={!editing && <button class="pill" onClick={() => { store.set(DRAFT, null); setCustomer(null); setItems([blankItem(settings.default_unit)]); }}><Icon name="RefreshCw" size={15} /></button>} />
      <div class="page order-page">
        <button class="card li cust" onClick={() => setPickCust(true)}>
          {customer ? (
            <>
              <div class="avatar-sm tone-pakka">{customer.name.split(' ').map((w) => w[0]).slice(0, 2).join('')}</div>
              <div class="grow"><div class="t">{customer.name}</div><div class="s">{customer.phone || t('no_phone')}</div></div>
              {special.size > 0 && can('money') && <Chip tone="accent"><Icon name="Tag" size={12} stroke={2.2} />{t('special')}</Chip>}
            </>
          ) : (
            <>
              <div class="iconbox tone-accent"><Icon name="Users" /></div>
              <div class="grow t">{t('choose_customer')}</div><Icon name="ChevronRight" size={18} />
            </>
          )}
        </button>

        {items.map((it, i) => (
          <ItemCard key={it.key} index={i} item={it} r={resolved[i]} cat={cat} customer={customer} editingId={editing?.id}
            onChange={(patch) => setItem(i, patch)} onUnit={(u) => changeUnit(i, u)}
            onRemove={items.length > 1 ? () => setItems(items.filter((_, k) => k !== i)) : null} />
        ))}
        <button class="add-item" onClick={() => setItems([...items, blankItem(settings.default_unit)])}><Icon name="Plus" size={18} stroke={2.4} />{t('add_item')}</button>
        {problem && <div class="error" style="text-align:center">{problem}</div>}
      </div>

      <div class="quotebar">
        {can('money') && (
          <div class="quote-row">
            <div><div class="faint cap">{t('est_total')}</div><div class="num big">{money(totals.plain.total, true)}</div></div>
            <div><div class="cap" style="color:var(--pakka)">{t('quote_gst')}</div><div class="num">{money(totals.gst.total, true)}</div></div>
            {can('kacha') && <div><div class="cap" style="color:var(--kacha)">{t('quote_none')}</div><div class="num">{money(totals.none.total, true)}</div></div>}
          </div>
        )}
        <div class="row">
          <button class="btn btn-ghost" style="width:128px" disabled={busy} onClick={() => save(false)}>{t('save_est').split(' ')[0]}</button>
          <button class="btn btn-accent grow" disabled={busy} onClick={() => { const p = check(); setProblem(p); if (!p) setAdvOpen(true); }}><Icon name="Check" size={20} stroke={2.6} />{t('accept')}</button>
        </div>
      </div>

      <CustomerPicker open={pickCust} customers={cat.customers} onClose={() => setPickCust(false)}
        onPick={(c) => { setCustomer(c); setPickCust(false); }} />
      <AdvanceSheet open={advOpen} busy={busy} onClose={() => setAdvOpen(false)} total={totals.plain.total}
        onAccept={(adv) => { setAdvOpen(false); save(true, adv); }} />
    </div>
  );
}

function AdvanceSheet({ open, onClose, onAccept, busy }) {
  const [amt, setAmt] = useState('');
  const [mode, setMode] = useState('Cash');
  const [note, setNote] = useState('');
  const money_ = can('money');
  return (
    <Sheet open={open} onClose={onClose} title={t('accept')}
      footer={<button class="btn btn-accent btn-block" disabled={busy} onClick={() => onAccept(money_ && Number(amt) > 0 ? { amount: r2(Number(amt)), mode, note } : null)}>
        <Icon name="Check" size={20} stroke={2.6} />{Number(amt) > 0 ? `${t('accept')} · ${money(amt)}` : t('accept')}</button>}>
      {money_ ? (
        <>
          <div class="muted" style="margin-bottom:14px">{t('adv_note')}</div>
          <div class="lbl">{t('adv_amt')}</div>
          <div class="field"><span class="faint">₹</span><input inputmode="decimal" value={amt} onInput={(e) => setAmt(e.currentTarget.value.replace(/[^\d.]/g, ''))} placeholder="0" /></div>
          {Number(amt) > 0 && (
            <>
              <div class="lbl" style="margin-top:14px">{t('how_paid')}</div>
              <div class="pick">{PAY_METHODS.map((p) => <button class={mode === p.id ? 'on' : ''} onClick={() => setMode(p.id)}><Icon name={p.icon} size={18} />{t(p.word)}</button>)}</div>
              <div class="lbl" style="margin-top:14px">{t('pay_note')}</div>
              <input class="textarea" value={note} onInput={(e) => setNote(e.currentTarget.value)} placeholder={t('pay_note_ph')} />
            </>
          )}
        </>
      ) : <div class="muted">{t('accepted_msg', '…').replace('#… ', '')}</div>}
    </Sheet>
  );
}
