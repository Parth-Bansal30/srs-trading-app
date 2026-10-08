// Add a purchase bill: upload the PDF / take a photo (read by the app when the AI is switched on) or
// type it in → check every line → give each line its grade (+ shape) → Save. Nothing is saved until Save.
// Each line goes into the stock item with the same grade + shape + HSN + rate (or a new one).
// Address: #/purchases/new  (?kind=opening = stock already in the godown, no bill)
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { billLine, billTotals, landedCosts, matchStockItem, guessGrade, guessShape, descKey, cleanHsn, businessDate, r2, purchaseChecks } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { can, company } from '../../lib/session.js';
import { call } from '../../lib/api.js';
import { useAction } from '../../lib/action.js';
import { loadCatalog } from '../../lib/catalog.js';
import { store } from '../../lib/store.js';
import { money } from '../../lib/format.js';
import { go, route } from '../../lib/router.js';
import { forgetStock, kgTxt } from '../../lib/stock.js';
import { SHAPE_LOOK } from '../../config/options.js';
import { Icon, Chip, TopBar, Skeleton } from '../../ui/kit.jsx';
import { GradePicker } from '../order/GradePicker.jsx';
import { Sheet } from '../../ui/Sheet.jsx';
import { CheckNote, checkWords } from '../../ui/stock/BillCheck.jsx';
import '../order/order.css';
import './stock.css';

const DRAFT = 'draft:purchase';
// HSN codes the person said are correct for a grade are remembered on this phone (so the warning never nags again)
const OK_HSN = 'pu:okHsn';
const okHsn = () => { try { return JSON.parse(localStorage.getItem(OK_HSN) || '[]'); } catch { return []; } };
const rememberOk = (k) => { try { localStorage.setItem(OK_HSN, JSON.stringify([...new Set([...okHsn(), k])].slice(-200))); } catch { /* private window */ } };
const UNITS = [['kg', 'kg'], ['mt', 'MT'], ['qtl', 'Qtl']];
const key = () => Math.random().toString(36).slice(2);
const blankLine = () => ({ key: key(), description: '', hsn: '', qty: '', qtyUnit: 'kg', rate: '', rateUnit: 'kg', amount: '', material_id: null, shape: null, label: '', unsure: [], how: null });
const today = () => businessDate(new Date().toISOString(), company.value?.timezone || 'Asia/Kolkata');
const blankForm = (kind = 'bill') => ({ kind, supplier: { id: null, name: '', gstin: '', city: '' }, bill_no: '', bill_date: today(), bill_type: 'pakka',
  lines: [blankLine()], freight: '', other: '', gst: '', round_off: '', total: '', pay_status: 'to_pay', note: '', unsure: [], file_key: null, read_by_ai: false });

/** A photo is made smaller before it is sent (max 2000 px, JPEG) — quicker on a weak network. */
async function fileToData(file) {
  if (file.type.startsWith('image/')) {
    const img = await createImageBitmap(file);
    const k = Math.min(1, 2000 / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const url = c.toDataURL('image/jpeg', 0.85);
    return { mime: 'image/jpeg', data: url.split(',')[1] };
  }
  const url = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = no; r.readAsDataURL(file); });
  return { mime: file.type || 'application/pdf', data: String(url).split(',')[1] };
}

export function PurchaseNew() {
  const opening = route.value.query.kind === 'opening';
  const [ctx, setCtx] = useState(null);
  const [cat, setCat] = useState(null);
  const [step, setStep] = useState(opening ? 'form' : 'start');
  const [form, setForm] = useState(null);
  const [draft, setDraft] = useState(null);
  const [file, setFile] = useState(null);       // { url (on this phone), mime, name }
  const [readMsg, setReadMsg] = useState(null); // what happened when reading
  const [err, setErr] = useState(null);
  const [pick, setPick] = useState(null);       // line index choosing a grade
  const [diff, setDiff] = useState(null);       // totals_differ from the server
  const [result, setResult] = useState(null);
  const [review, setReview] = useState(false); // the "before saving" list
  const save = useAction('savePurchase');
  const pdfIn = useRef(); const photoIn = useRef();

  useEffect(() => {
    Promise.all([call('purchaseContext', {}), loadCatalog()]).then(([c, k]) => { setCtx(c); setCat(k); }).catch((e) => setErr(e.message));
    const d = store.json(DRAFT);
    if (d && d.form && !opening) setDraft(d); else setForm(blankForm(opening ? 'opening' : 'bill'));
  }, []);
  useEffect(() => { if (form && step === 'form') store.setJson(DRAFT, { form, at: Date.now() }); }, [form, step]);

  const items = useMemo(() => (ctx?.items || []).map((s) => ({ id: s.id, materialId: s.material_id, shape: s.shape, hsn: s.hsn, rate: Number(s.rate), onHand: Number(s.on_hand) })), [ctx]);
  const matOf = (id) => cat?.materials.find((m) => m.id === id);

  // ---------- suggestions: what this bill line was saved as before, else read from the words ----------
  const suggest = (line, supplierId) => {
    if (!ctx || line.material_id) return line;
    const dk = descKey(line.description);
    if (!dk) return line;
    const named = ctx.names.find((n) => n.desc_key === dk && n.supplier_key === (supplierId || '')) || ctx.names.find((n) => n.desc_key === dk);
    if (named && matOf(named.material_id)) return { ...line, material_id: named.material_id, shape: named.shape ?? line.shape, how: 'remembered' };
    const g = guessGrade(line.description, cat?.materials || []);
    return { ...line, material_id: g ? g.id : null, shape: line.shape ?? guessShape(line.description), how: g ? 'guessed' : null };
  };

  const fromReading = (b, fileKey) => {
    const f = blankForm('bill');
    const sup = b.supplier || {};
    const known = ctx.suppliers.find((s) => (sup.gstin && s.gstin === sup.gstin) || (sup.name && s.name.toLowerCase() === sup.name.toLowerCase()));
    f.supplier = known ? { id: known.id, name: known.name, gstin: known.gstin || '', city: known.city || '' } : { id: null, name: sup.name || '', gstin: sup.gstin || '', city: sup.city || '' };
    Object.assign(f, { bill_no: b.bill_no || '', bill_date: b.bill_date || today(), bill_type: b.bill_type || 'pakka',
      freight: b.freight ? String(b.freight) : '', other: b.other ? String(b.other) : '', gst: b.gst ? String(b.gst) : '',
      round_off: b.round_off ? String(b.round_off) : '', total: b.total != null ? String(b.total) : '', unsure: b.unsure || [], file_key: fileKey, read_by_ai: true });
    f.lines = (b.lines?.length ? b.lines : [{}]).map((l) => suggest({ ...blankLine(), description: l.description || '', hsn: l.hsn || '',
      qty: l.qty_kg != null ? String(l.qty_kg) : '', rate: l.rate != null ? String(l.rate) : '', amount: l.amount != null ? String(l.amount) : '', unsure: l.unsure || [] }, f.supplier.id));
    return f;
  };

  const onFile = async (fl) => {
    if (!fl) return;
    if (fl.size > 15 * 1024 * 1024) { setErr(t('err_generic')); return; }
    setErr(null); setStep('reading'); setFile({ url: URL.createObjectURL(fl), mime: fl.type, name: fl.name });
    try {
      const { mime, data } = await fileToData(fl);
      const r = await call('readPurchaseBill', { mime, data });
      if (r.ai && r.bill) { setForm(fromReading(r.bill, r.file_key)); setReadMsg({ ok: true }); }
      else { setForm({ ...blankForm('bill'), file_key: r.file_key }); setReadMsg({ ok: false, why: r.reason || (ctx?.can_read ? 'unreadable' : 'off') }); }
      setStep('form');
    } catch (e) { setErr(e.message); setStep('start'); }
  };

  // ---------- the maths (all from @srs/core) ----------
  const calc = useMemo(() => {
    if (!form) return null;
    const lines = form.lines.map((l) => {
      const b = billLine({ qty: l.qty, qtyUnit: l.qtyUnit, rate: l.rate, rateUnit: l.rateUnit, amount: l.amount === '' ? null : l.amount });
      const match = l.material_id && b.rateKg != null ? matchStockItem({ materialId: l.material_id, shape: l.shape, hsn: l.hsn, rateKg: b.rateKg }, items) : null;
      return { ...b, match };
    });
    const isBill = form.kind === 'bill';
    const tot = billTotals({ lines, freight: isBill ? form.freight : 0, other: isBill ? form.other : 0, gst: isBill && form.bill_type === 'pakka' ? form.gst : 0,
      roundOff: isBill ? form.round_off : 0, total: isBill && form.total !== '' ? form.total : null });
    const lc = landedCosts(lines.map((l) => ({ kg: l.kg || 0, rateKg: l.rateKg || 0 })), tot.extra);
    return { lines, tot, lc, kg: r2(lines.reduce((a, l) => a + (l.kg || 0), 0)) };
  }, [form, items]);

  if (err && !form && !draft) return <><TopBar title={t('pu_new_title')} /><div class="page"><div class="error">{err}</div></div></>;
  if (!ctx || !cat || (!form && !draft)) return <><TopBar title={t('pu_new_title')} /><div class="page"><Skeleton h={160} /><Skeleton h={220} style="margin-top:12px" /></div></>;

  // an unsaved bill from before
  if (draft && !form) {
    return (
      <><TopBar title={t('pu_new_title')} /><div class="page">
        <div class="card pad">
          <div style="font-weight:800;font-size:16px">{t('pu_draft')}</div>
          <div class="muted" style="margin-top:4px;font-size:14px">{draft.form.supplier?.name || t('pu_opening')} · {t('pu_lines_n', draft.form.lines.length, '')}</div>
          <div class="row" style="gap:10px;margin-top:12px">
            <button class="btn btn-ghost grow" onClick={() => { store.set(DRAFT, null); setDraft(null); setForm(blankForm()); }}>{t('pu_draft_discard')}</button>
            <button class="btn btn-accent grow" onClick={() => { setForm(draft.form); setDraft(null); setStep('form'); }}>{t('pu_draft_continue')}</button>
          </div>
        </div>
      </div></>
    );
  }

  // ---------- 1. how the bill comes in ----------
  if (step === 'start' || step === 'reading') {
    return (
      <><TopBar title={t('pu_new_title')} /><div class="page">
        <div class="pu-hero">
          <div style="font-size:19px;font-weight:800">{t('pu_new_title')}</div>
          <div style="font-size:14px;opacity:.78;margin-top:4px;line-height:1.4">{ctx.can_read ? t('pu_new_s') : t('pu_new_s_off')}</div>
          <div class="pu-ways">
            <button class="on" disabled={step === 'reading'} onClick={() => pdfIn.current.click()}><Icon name="FileUp" size={26} stroke={2.2} /><span>{t('pu_upload')}</span></button>
            <button disabled={step === 'reading'} onClick={() => photoIn.current.click()}><Icon name="Camera" size={26} stroke={2.2} /><span>{t('pu_photo')}</span></button>
            <button disabled={step === 'reading'} onClick={() => setStep('form')}><Icon name="Keyboard" size={26} stroke={2.2} /><span>{t('pu_type')}</span></button>
          </div>
          <input ref={pdfIn} type="file" accept="application/pdf,image/*" hidden onChange={(e) => onFile(e.currentTarget.files[0])} />
          <input ref={photoIn} type="file" accept="image/*" capture="environment" hidden onChange={(e) => onFile(e.currentTarget.files[0])} />
        </div>
        {step === 'reading' && (
          <div class="card pad row" style="gap:12px;margin-top:12px">
            <Icon name="Sparkles" size={22} />
            <div class="grow"><div style="font-weight:700">{file?.name}</div><div class="muted" style="font-size:13.5px">{t('pu_reading')}</div><div class="pu-progress"><div /></div></div>
          </div>
        )}
        {err && <div class="error" style="margin-top:12px">{err}</div>}
        {!ctx.can_read && <div class="faint" style="font-size:12.5px;font-weight:600;margin-top:12px;line-height:1.45">{t('ai_key_note')}</div>}
        <button class="link" style="margin-top:10px" onClick={() => { setForm(blankForm('opening')); setStep('form'); }}><Icon name="PackagePlus" size={16} />{t('st_opening')}</button>
      </div></>
    );
  }

  // ---------- 3. saved ----------
  if (step === 'done') {
    const nNew = (result?.lines || []).filter((l) => l.new).length;
    return (
      <><TopBar title={t('pu_done_t')} /><div class="page">
        <div class="card pad" style="text-align:center">
          <div class="pu-done"><Icon name="Check" size={30} stroke={3} /></div>
          <div style="font-weight:800;font-size:19px;margin-top:10px">{t('pu_done_t')}</div>
          <div class="muted" style="margin-top:4px">{t('pu_done_s', kgTxt(result?.kg || 0), nNew)}</div>
        </div>
        <div class="row" style="gap:10px;margin-top:12px">
          <button class="btn btn-ghost grow" onClick={() => go('/stock')}><Icon name="Boxes" size={18} />{t('pu_view_stock')}</button>
          <button class="btn btn-accent grow" onClick={() => { setForm(blankForm()); setFile(null); setReadMsg(null); setResult(null); setStep('start'); }}>{t('pu_another')}</button>
        </div>
      </div></>
    );
  }

  // ---------- 2. check the bill ----------
  const f = form;
  const isBill = f.kind === 'bill';
  const set = (patch) => setForm({ ...f, ...patch });
  const setLine = (i, patch) => setForm({ ...f, lines: f.lines.map((l, k) => (k === i ? { ...l, ...patch } : l)) });
  const sup = f.supplier;
  const supMatches = !sup.id && sup.name.trim().length >= 2 ? ctx.suppliers.filter((s) => s.name.toLowerCase().includes(sup.name.trim().toLowerCase())).slice(0, 4) : [];
  const unsure = (name) => (f.unsure.includes(name) ? 'unsure' : '');
  const gstPct = Number(ctx.gst_pct ?? 18);
  const tz = company.value?.timezone;
  // ---------- smart checks (warn only) ----------
  const hist = {
    rates: (ctx.history?.rates || []).map((h) => ({ materialId: h.material_id, rate: Number(h.rate), date: h.date, supplier: h.supplier })),
    bills: (ctx.history?.bills || []).map((b) => ({ supplierId: b.supplier_id, billNo: b.bill_no, date: b.date, kg: Number(b.kg), total: Number(b.total) })),
  };
  const checks = isBill || f.lines.length ? purchaseChecks({
    billNo: isBill ? f.bill_no : '', supplierId: sup.id, supplierGstin: sup.gstin, isNewSupplier: isBill && !sup.id,
    totalKg: calc.kg, total: calc.tot.total,
    lines: f.lines.map((l, i) => { const m = matOf(l.material_id); return { hsn: l.hsn, rateKg: calc.lines[i].rateKg, family: m?.family, materialId: l.material_id, code: m?.code, shape: l.shape }; }),
  }, hist, [...(f.okChecks || []), ...okHsn()]) : [];
  const sayOk = (c) => { if (c.type.startsWith('hsn')) rememberOk(c.key); set({ okChecks: [...(f.okChecks || []), c.key] }); };
  const lineChecks = (i) => checks.filter((c) => c.line === i);
  const hsnActions = (c, i) => c.suggest.map((x, k) => [`${t('chk_use', x.hsn)} · ${x.words}`, () => setLine(i, { hsn: x.hsn }), k === 0]);
  const problems = () => {
    if (isBill && !sup.id && !sup.name.trim()) return t('pu_need_from');
    for (let i = 0; i < f.lines.length; i++) {
      const c = calc.lines[i];
      if (!f.lines[i].material_id) return t('pu_need_line', i + 1, t('pu_need_grade'));
      if (!(c.kg > 0)) return t('pu_need_line', i + 1, t('pu_need_kg'));
      if (c.rateKg == null) return t('pu_need_line', i + 1, t('pu_need_rate'));
    }
    return null;
  };
  const submit = async (acceptDiff = false) => {
    const p = problems();
    setErr(p); setDiff(null);
    if (p) return;
    const bill = {
      kind: f.kind, bill_type: isBill ? f.bill_type : 'kacha', bill_no: isBill ? f.bill_no.trim() || null : null, bill_date: f.bill_date,
      supplier: isBill ? (sup.id ? { id: sup.id } : { name: sup.name.trim(), gstin: sup.gstin.trim() || null, city: sup.city.trim() || null }) : null,
      freight: isBill ? Number(f.freight || 0) : 0, other: isBill ? Number(f.other || 0) : 0, gst: isBill && f.bill_type === 'pakka' ? Number(f.gst || 0) : 0,
      round_off: isBill ? Number(f.round_off || 0) : 0, total: calc.tot.total, pay_status: f.pay_status, note: f.note || null,
      file_key: f.file_key, read_by_ai: f.read_by_ai,
      lines: f.lines.map((l, i) => ({ description: l.description.trim() || `${matOf(l.material_id)?.code || ''} ${l.shape || ''}`.trim(),
        hsn: cleanHsn(l.hsn), qty_kg: calc.lines[i].kg, rate: calc.lines[i].rateKg, amount: calc.lines[i].amount, material_id: l.material_id, shape: l.shape, label: l.label || null })),
    };
    try {
      const r = await save.run({ bill, accept_diff: acceptDiff || undefined });
      store.set(DRAFT, null); forgetStock(); setResult(r); setStep('done');
    } catch (e) { if (e.code === 'totals_differ') setDiff(calc.tot); else setErr(e.message); }
  };

  return (
    <div class="order-screen">
      <TopBar title={isBill ? t('pu_new_title') : t('st_opening')} sub={file?.name || ''}
        right={file && <a class="round" href={file.url} target="_blank" rel="noopener" aria-label={t('pu_open_file')}><Icon name="FileText" size={19} /></a>} />
      <div class="page" style="padding-bottom:150px">
        {readMsg && <div class={`notice ${readMsg.ok ? 'tone-ok' : 'tone-warn'}`} style="margin-bottom:10px">
          {readMsg.ok ? t('pu_read_ok') : t(readMsg.why === 'daily_limit' ? 'pu_read_limit' : readMsg.why === 'off' ? 'pu_read_off' : 'pu_read_fail')}</div>}
        {readMsg?.ok && <div class="notice tone-warn" style="margin-bottom:10px;font-weight:600">{t('pu_unsure')}</div>}
        {file && file.mime?.startsWith('image/') && <a href={file.url} target="_blank" rel="noopener"><img src={file.url} class="pu-thumb" alt="" /></a>}

        {isBill && (
          <div class="card pad">
            <div class="lbl">{t('pu_from')}</div>
            <div class={`field ${unsure('supplier')}`} style="background:var(--surface)"><Icon name="Truck" size={18} />
              <input value={sup.name} placeholder={t('pu_from_ph')} onInput={(e) => set({ supplier: { ...sup, id: null, name: e.currentTarget.value } })} />
              {sup.id && <Chip tone="ok">✓</Chip>}</div>
            {supMatches.length > 0 && <div class="pu-sugg">{supMatches.map((s) => (
              <button onClick={() => set({ supplier: { id: s.id, name: s.name, gstin: s.gstin || '', city: s.city || '' }, lines: f.lines.map((l) => suggest({ ...l, material_id: l.how ? null : l.material_id }, s.id)) })}>
                <b>{s.name}</b>{s.city ? ` · ${s.city}` : ''}</button>))}</div>}
            {!sup.id && sup.name.trim() && <div class="row" style="gap:8px;margin-top:8px">
              <div class="field grow"><input value={sup.gstin} placeholder={t('pu_gstin')} onInput={(e) => set({ supplier: { ...sup, gstin: e.currentTarget.value.toUpperCase() } })} /></div>
              <div class="field" style="width:120px"><input value={sup.city} placeholder={t('pu_city')} onInput={(e) => set({ supplier: { ...sup, city: e.currentTarget.value } })} /></div></div>}
            <div class="row" style="gap:8px;margin-top:12px">
              <div class="grow"><div class="lbl">{t('pu_bill_no')}</div><div class={`field ${unsure('bill_no')}`}><input value={f.bill_no} onInput={(e) => set({ bill_no: e.currentTarget.value })} /></div></div>
              <div class="grow"><div class="lbl">{t('pu_date')}</div><div class={`field ${unsure('bill_date')}`}><input type="date" value={f.bill_date} onInput={(e) => set({ bill_date: e.currentTarget.value })} /></div></div>
            </div>
            {checks.filter((c) => c.type === 'billno_gstin').map((c) => (
              <CheckNote c={c} tz={tz} onOk={() => sayOk(c)} okWord={t('chk_not_billno')} actions={[sup.id
                ? [t('chk_clear_billno'), () => set({ bill_no: '' }), true]
                : [t('chk_move'), () => set({ bill_no: '', supplier: { ...sup, gstin: c.gstin } }), true]]} />))}
            {checks.filter((c) => c.type === 'gstin_typo').map((c) => <CheckNote c={c} tz={tz} onOk={() => sayOk(c)} />)}
            {can('kacha') && <><div class="lbl" style="margin-top:12px">{t('pu_type_q')}</div>
              <div class="seg"><button class={f.bill_type === 'pakka' ? 'on' : ''} onClick={() => set({ bill_type: 'pakka' })}>{t('bill_gst_short')}</button>
                <button class={f.bill_type === 'kacha' ? 'on' : ''} onClick={() => set({ bill_type: 'kacha', gst: '' })}>{t('bill_none_short')}</button></div></>}
          </div>
        )}
        {!isBill && <div class="card pad"><div class="lbl">{t('pu_date')}</div><div class="field"><input type="date" value={f.bill_date} onInput={(e) => set({ bill_date: e.currentTarget.value })} /></div></div>}

        <div class="sec"><h3>{t('pu_lines')}</h3><span class="faint num" style="font-size:13px;font-weight:600">{kgTxt(calc.kg)}</span></div>
        {f.lines.map((l, i) => {
          const c = calc.lines[i];
          const m = matOf(l.material_id);
          const u = (n) => (l.unsure.includes(n) ? 'unsure' : '');
          return (
            <div class="card pad pu-line">
              <div class="row" style="justify-content:space-between"><span class="faint cap">{t('pu_line', i + 1)}</span>
                {f.lines.length > 1 && <button class="round sm" onClick={() => set({ lines: f.lines.filter((_, k) => k !== i) })} aria-label={t('remove')}><Icon name="X" size={15} /></button>}</div>
              <div class={`field ${u('description')}`} style="margin-top:6px"><input value={l.description} placeholder={t('pu_desc')}
                onInput={(e) => setLine(i, { description: e.currentTarget.value })}
                onBlur={() => setLine(i, suggest({ ...l, material_id: l.how ? null : l.material_id }, sup.id))} /></div>
              <div class="row" style="gap:8px;margin-top:8px">
                <div style="width:110px"><div class="lbl">HSN</div><div class={`field num ${u('hsn')}`}><input inputmode="numeric" value={l.hsn} onInput={(e) => setLine(i, { hsn: e.currentTarget.value.replace(/[^\d ]/g, '') })} /></div></div>
                <div class="grow"><div class="lbl">{t('pu_qty')}</div><div class={`field num ${u('qty')}`}><input inputmode="decimal" value={l.qty} onInput={(e) => setLine(i, { qty: e.currentTarget.value.replace(/[^\d.]/g, '') })} />
                  <select class="unitsel" value={l.qtyUnit} onChange={(e) => setLine(i, { qtyUnit: e.currentTarget.value })}>{UNITS.map(([v, w]) => <option value={v}>{w}</option>)}</select></div></div>
              </div>
              <div class="row" style="gap:8px;margin-top:8px">
                <div class="grow"><div class="lbl">{t('pu_rate')}</div><div class={`field num ${u('rate')}`}><span class="faint">₹</span><input id={`pu-rate-${i}`} inputmode="decimal" value={l.rate} onInput={(e) => setLine(i, { rate: e.currentTarget.value.replace(/[^\d.]/g, '') })} />
                  <select class="unitsel" value={l.rateUnit} onChange={(e) => setLine(i, { rateUnit: e.currentTarget.value })}>{UNITS.map(([v, w]) => <option value={v}>/{w}</option>)}</select></div></div>
                <div class="grow"><div class="lbl">{t('pu_amount')}</div><div class={`field num ${u('amount')} ${l.amount !== '' && !c.ok ? 'unsure' : ''}`}><span class="faint">₹</span>
                  <input inputmode="decimal" value={l.amount} placeholder={c.expected != null ? String(c.expected) : ''} onInput={(e) => setLine(i, { amount: e.currentTarget.value.replace(/[^\d.]/g, '') })} /></div></div>
              </div>
              {l.amount !== '' && c.expected != null && !c.ok && <div class="pu-warn">{t('pu_amount_off', money(Number(l.amount), true), money(c.expected, true))}</div>}
              {lineChecks(i).map((k) => <CheckNote c={k} tz={tz} onOk={() => sayOk(k)}
                actions={k.type === 'rate_far' ? [[t('chk_fix_rate'), () => document.getElementById(`pu-rate-${i}`)?.focus(), true]] : hsnActions(k, i)} />)}
              {c.kg > 0 && c.rateKg != null && <div class="faint num" style="font-size:12.5px;font-weight:600;margin-top:6px">{kgTxt(c.kg)} × {money(c.rateKg)}/kg{calc.lc[i].share > 0 ? ` · ${t('st_cost')} ${money(calc.lc[i].cost)}/kg` : ''}</div>}

              <div class="pu-saveas">
                <div class="lbl" style="margin:0 0 6px">{t('pu_save_as')}</div>
                <div class="row" style="gap:8px;flex-wrap:wrap">
                  <button class={`grade ${m ? '' : 'empty'}`} onClick={() => setPick(i)}>{m ? m.code : t('choose_grade')}<Icon name="ChevronRight" size={16} /></button>
                  {l.how && m && <Chip tone="accent">{t(l.how === 'remembered' ? 'pu_suggested' : 'pu_guessed')}</Chip>}
                  {m && (c.match ? <Chip tone="ok">{t('pu_adds_to', kgTxt(c.match.onHand))}</Chip> : <Chip tone="neutral">{t('pu_new_item')}</Chip>)}
                </div>
                <div class="shapes sm">
                  {[...Object.keys(SHAPE_LOOK), null].map((id) => (
                    <button class={l.shape === id ? 'on' : ''} onClick={() => setLine(i, { shape: id })}>
                      {id ? <Icon name={SHAPE_LOOK[id].icon} size={17} /> : <Icon name="Boxes" size={17} />}<span>{id ? t(SHAPE_LOOK[id].word) : t('st_any_shape')}</span></button>
                  ))}
                </div>
                <div class="field" style="margin-top:8px"><input value={l.label} maxLength={60} placeholder={t('pu_own_name')} onInput={(e) => setLine(i, { label: e.currentTarget.value })} /></div>
                <div class="faint" style="font-size:12px;font-weight:600;margin-top:6px"><Icon name="Lock" size={12} /> {t('pu_locked')}</div>
              </div>
            </div>
          );
        })}
        <button class="add-item" onClick={() => set({ lines: [...f.lines, blankLine()] })}><Icon name="Plus" size={18} stroke={2.4} />{t('pu_add_line')}</button>

        {isBill && (
          <>
            <div class="sec"><h3>{t('pu_charges')}</h3></div>
            <div class="card pad">
              <div class="row" style="gap:8px">
                <div class="grow"><div class="lbl">{t('pu_freight')}</div><div class={`field num ${unsure('freight')}`}><span class="faint">₹</span><input inputmode="decimal" value={f.freight} onInput={(e) => set({ freight: e.currentTarget.value.replace(/[^\d.]/g, '') })} /></div></div>
                <div class="grow"><div class="lbl">{t('pu_other')}</div><div class={`field num ${unsure('other_charges')}`}><span class="faint">₹</span><input inputmode="decimal" value={f.other} onInput={(e) => set({ other: e.currentTarget.value.replace(/[^\d.]/g, '') })} /></div></div>
              </div>
              {f.bill_type === 'pakka' && <div style="margin-top:10px"><div class="lbl">{t('pu_gst')}</div>
                <div class="row" style="gap:8px"><div class={`field num grow ${unsure('cgst') || unsure('sgst') || unsure('igst')}`}><span class="faint">₹</span><input inputmode="decimal" value={f.gst} onInput={(e) => set({ gst: e.currentTarget.value.replace(/[^\d.]/g, '') })} /></div>
                  <button class="pill" onClick={() => set({ gst: String(r2(calc.tot.beforeTax * gstPct / 100)) })}>{t('pu_gst_auto', gstPct, money(r2(calc.tot.beforeTax * gstPct / 100), false))}</button></div></div>}
              <div class="row" style="gap:8px;margin-top:10px">
                <div style="width:120px"><div class="lbl">{t('pu_round')}</div><div class="field num"><input inputmode="decimal" value={f.round_off} onInput={(e) => set({ round_off: e.currentTarget.value.replace(/[^\d.-]/g, '') })} /></div></div>
                <div class="grow"><div class="lbl">{t('pu_total')}</div><div class={`field num ${unsure('total')}`}><span class="faint">₹</span><input inputmode="decimal" value={f.total} placeholder={String(calc.tot.computed)} onInput={(e) => set({ total: e.currentTarget.value.replace(/[^\d.]/g, '') })} /></div></div>
              </div>
              <div class={`notice ${calc.tot.ok ? 'tone-ok' : 'tone-warn'}`} style="margin-top:12px">
                {calc.tot.ok ? t('pu_adds_up') : t('pu_differs', money(calc.tot.computed, true), money(calc.tot.total, true), money(calc.tot.diff, true))}</div>
              {checks.filter((c) => c.type === 'duplicate').map((c) => <CheckNote c={c} tz={tz} onOk={() => sayOk(c)} />)}
              <div class="lbl" style="margin-top:12px">{t('pu_paid_q')}</div>
              <div class="seg"><button class={f.pay_status === 'paid' ? 'on' : ''} onClick={() => set({ pay_status: 'paid' })}>{t('pu_paid')}</button>
                <button class={f.pay_status === 'to_pay' ? 'on' : ''} onClick={() => set({ pay_status: 'to_pay' })}>{t('pu_to_pay')} {money(calc.tot.total, false)}</button></div>
            </div>
          </>
        )}
        <div class="lbl" style="margin-top:14px">{t('pu_note')}</div>
        <input class="textarea" value={f.note} onInput={(e) => set({ note: e.currentTarget.value })} />
        {err && <div class="error" style="margin-top:12px">{err}</div>}
        {diff && <div class="card pad" style="margin-top:12px;border-color:var(--warn)">
          <div style="font-weight:700">{t('pu_differs', money(diff.computed, true), money(diff.total, true), money(diff.diff, true))}</div>
          <button class="btn btn-ghost btn-block" style="margin-top:10px" disabled={save.busy} onClick={() => submit(true)}>{t('pu_save_anyway', money(diff.total, true))}</button>
        </div>}
      </div>
      <div class="quotebar">
        <button class="btn btn-accent btn-block" disabled={save.busy} onClick={() => (checks.length && !problems() ? setReview(true) : submit(false))}><Icon name="Boxes" size={19} stroke={2.3} />{save.busy ? '…' : t('pu_save', kgTxt(calc.kg))}</button>
      </div>
      <Sheet open={review} onClose={() => setReview(false)} title={checks.length === 1 ? t('chk_sheet_t1') : t('chk_sheet_t', checks.length)}
        footer={<><button class="btn btn-ghost btn-block" onClick={() => setReview(false)}>{t('chk_back')}</button>
          <button class="btn btn-accent btn-block" style="margin-top:8px" disabled={save.busy} onClick={() => {
            checks.filter((c) => c.type.startsWith('hsn')).forEach((c) => rememberOk(c.key));
            setForm({ ...f, okChecks: [...(f.okChecks || []), ...checks.map((c) => c.key)] }); setReview(false); submit(false);
          }}>{t('chk_save_all')}</button></>}>
        <div class="muted" style="font-size:14px;margin-bottom:10px">{t('chk_sheet_s')}</div>
        <div class="card chk-list">{checks.map((c) => { const [a, b] = checkWords(c, tz); return (
          <div class="li"><span style={`color:var(--${c.level});flex:none;margin-top:2px`}><Icon name={c.level === 'bad' ? 'CircleAlert' : 'TriangleAlert'} size={18} stroke={2.4} /></span>
            <div class="grow"><div class="t" style="font-size:14px">{c.line != null ? `${t('chk_line', c.line + 1)} · ` : ''}{a}</div><div class="s">{b}</div></div></div>); })}</div>
      </Sheet>
      <GradePicker open={pick != null} materials={cat.materials} onClose={() => setPick(null)}
        onPick={(mat) => { setLine(pick, { material_id: mat.id, how: null }); setPick(null); }} />
    </div>
  );
}
