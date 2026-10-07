// The slip and the statement as the CUSTOMER sees them — on screen, in the PDF and on paper.
// Everything comes from the saved copy (doc) the backend made; words are in the doc's own language.
// Never shows rates per kg, the shop's notes, or the word "kacha".
import qrcode from 'qrcode-generator';
import { SHAPES } from '@srs/core';
import { tIn } from '../../lib/i18n.js';
import { money, shortDate, time } from '../../lib/format.js';
import { upiLink, isSampleUpi, fmtDay } from '../../lib/docs.js';
import { SHAPE_LOOK, PAY_METHODS } from '../../config/options.js';
import './docs.css';

const n2 = (v) => money(v, true).replace('₹', '');      // 3,719.01 (tables)
const initials = (name) => (name || '?').split(/\s+/).filter(Boolean).slice(0, 3).map((w) => w[0]).join('').toUpperCase();
const unit = (u) => (u === 'in' ? '"' : ' mm');
const sizeText = (it) => {
  const d = (it.dims || []).slice(0, SHAPES[it.shape]?.dims.length || 1);
  return `${it.shape === 'round' ? 'Ø ' : ''}${d.join(' × ')}${unit(it.unit)}`;
};
const lengthRows = (it, l) => (SHAPES[it.shape]?.len
  ? it.lengths.map((r) => `${r.len}${unit(it.unit)} × ${r.pcs}`)
  : [`${it.pcs} ${tIn(l, 'pcs')}`]);
// a payment split across accounts shows its modes, e.g. "Cash + Bank" (never an account name)
const modeWord = (l, mode) => String(mode || '').split('+').map((x) => PAY_METHODS.find((m) => m.id === x)).filter(Boolean).map((m) => tIn(l, m.word)).join(' + ') || null;
const payLabel = (l, p, tz) => {
  const what = p.amount < 0 ? tIn(l, 'doc_returned') : p.kind === 'advance' ? tIn(l, 'doc_pay_adv') : tIn(l, 'doc_pay');
  return [what, shortDate(p.at, tz), modeWord(l, p.mode)].filter(Boolean).join(' · ');
};

/** Shop badge: the shop's initials (a logo can replace this later). */
export const ShopBadge = ({ name, size = 46 }) => (
  <div class="pp-badge" style={`width:${size}px;height:${size}px;border-radius:${Math.round(size * 0.3)}px;font-size:${Math.round(size * 0.3)}px`}>{initials(name)}</div>
);

/** UPI QR for exactly this amount. A sample ID gets a red "do not pay" band over it. */
export function UpiQr({ upi, lang = 'en', cell = 3 }) {
  const link = upiLink(upi);
  if (!link) return null;
  const q = qrcode(0, 'M'); q.addData(link); q.make();
  const n = q.getModuleCount(); const W = n * cell;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c * cell} ${r * cell}h${cell}v${cell}h-${cell}z`;
  const sample = isSampleUpi(upi.id);
  return (
    <div class="pp-qr" style={`width:${W}px;height:${W}px`}>
      <svg width={W} height={W} viewBox={`0 0 ${W} ${W}`} shape-rendering="crispEdges" style={sample ? 'opacity:.35' : ''}><path d={d} fill="#14161B" /></svg>
      {sample && <div class="pp-sample">{tIn(lang, 'doc_sample')}</div>}
    </div>
  );
}

function PayBox({ upi, lang, sub }) {
  if (!upi) return null;
  const sample = isSampleUpi(upi.id);
  return (
    <div class="pp-pay">
      <UpiQr upi={upi} lang={lang} />
      <div>
        <b>{tIn(lang, 'doc_scan_pay', money(upi.amount, true))}</b>
        <div class="pp-mute">UPI · {upi.id}</div>
        {sample ? <div class="pp-bad">{tIn(lang, 'doc_sample')}</div> : <div class="pp-faint">{sub || tIn(lang, 'doc_upi_apps')}</div>}
      </div>
    </div>
  );
}

function ShopHead({ shop, gst, right }) {
  return (
    <div class="pp-head">
      <div class="pp-shop">
        <ShopBadge name={shop.name} />
        <div>
          <div class="pp-shopname">{shop.name}</div>
          <div class="pp-mute pp-small">{shop.address}{shop.address && <br />}{[shop.phone && `☎ ${shop.phone}`, gst && shop.gstin && `GSTIN ${shop.gstin}`].filter(Boolean).join(' · ')}</div>
        </div>
      </div>
      <div class="pp-right">{right}</div>
    </div>
  );
}

function CustomerBox({ c, l, gst }) {
  return (
    <div class="pp-cust">
      <div>
        <div class="pp-cap">{tIn(l, 'customer')}</div>
        <div class="pp-custname">{c.name}</div>
        <div class="pp-mute pp-small">{[c.address, c.phone].filter(Boolean).join(' · ')}</div>
      </div>
      {gst && c.gstin && <div style="text-align:right"><div class="pp-cap">{tIn(l, 'doc_cust_gstin')}</div><div class="pp-num" style="font-weight:700;margin-top:2px">{c.gstin}</div></div>}
    </div>
  );
}

/** The slip. size: 'page' (A5 / phone PDF / HP printer) or 'roll' (80 mm receipt printer). */
export function SlipPaper({ doc, size = 'page', showQr = true }) {
  const l = doc.lang; const s = doc.slip; const tz = doc.timezone;
  const when = `${shortDate(s.at, tz)} ${new Date(s.at).toLocaleString('en-IN', { timeZone: tz, year: 'numeric' })} · ${time(s.at, tz)}`;
  const upi = showQr ? doc.upi : null;
  const lines = [[tIn(l, 'material'), s.material], [tIn(l, 'cutting'), s.cutting], ...(s.gst ? [[tIn(l, 'gst_line', s.gst_pct), s.gst_amount]] : [])];
  const paidUp = s.balance <= 0 && s.total > 0;

  if (size === 'roll') {
    return (
      <div class="pp pp-roll">
        <div class="pp-c pp-rollshop">{doc.shop.name}</div>
        <div class="pp-c">{doc.shop.address}{doc.shop.phone && <><br />Ph {doc.shop.phone}</>}{s.gst && doc.shop.gstin && <><br />GSTIN {doc.shop.gstin}</>}</div>
        <div class="pp-dash" />
        <b>{tIn(l, 'order_slip')} #{s.no}</b><div>{when}</div><div>{doc.customer.name}{s.gst && doc.customer.gstin ? ` · ${doc.customer.gstin}` : ''}</div>
        <div class="pp-dash" />
        {s.items.map((it) => (
          <div>
            <div>{it.grade} {tIn(l, SHAPE_LOOK[it.shape]?.word || it.shape)} {sizeText(it)}{it.hsn ? ` · HSN ${it.hsn}` : ''}</div>
            <div class="pp-lr"><span> {lengthRows(it, l).join(', ')}</span><span>{it.weight != null ? `${it.weight.toFixed(2)}kg` : ''}</span></div>
          </div>
        ))}
        {s.total_weight != null && <div class="pp-lr"><span>{tIn(l, 'weight_total')}</span><span>{Number(s.total_weight).toFixed(2)}kg</span></div>}
        <div class="pp-dash" />
        {lines.map(([a, b]) => <div class="pp-lr"><span>{a}</span><span>{n2(b)}</span></div>)}
        <div class="pp-lr pp-big"><span>{tIn(l, 'total').toUpperCase()}</span><span>{n2(s.total)}</span></div>
        {s.payments.map((p) => <div class="pp-lr"><span>{payLabel(l, p, tz)}</span><span>{p.amount < 0 ? '+' : '-'}{n2(Math.abs(p.amount))}</span></div>)}
        <div class="pp-lr" style="font-weight:800"><span>{tIn(l, 'doc_balance').toUpperCase()}</span><span>{n2(s.balance)}</span></div>
        {paidUp && <div class="pp-c" style="font-weight:800;margin-top:4px">*** {tIn(l, 'doc_paid_stamp')} ***</div>}
        {upi && <div class="pp-c" style="margin-top:10px"><div style="display:inline-block"><UpiQr upi={upi} lang={l} cell={4} /></div><div>{tIn(l, 'doc_scan_pay', money(upi.amount, true))}</div></div>}
        <div class="pp-dash" />
        <div class="pp-c pp-small">{s.gst ? tIn(l, 'slip_gst') : tIn(l, 'doc_thanks_biz')}</div>
      </div>
    );
  }

  return (
    <div class="pp pp-page">
      <ShopHead shop={doc.shop} gst={s.gst} right={<>
        <div class="pp-cap pp-kind">{tIn(l, 'order_slip')}</div>
        <div class="pp-no pp-num">#{s.no}</div>
        <div class="pp-mute pp-small">{when}</div>
      </>} />
      <CustomerBox c={doc.customer} l={l} gst={s.gst} />
      <table class="pp-table">
        <thead><tr><th style="width:22px">#</th><th>{tIn(l, 'doc_item')}</th><th>{tIn(l, 'doc_size')}</th><th>{tIn(l, 'doc_len_pcs')}</th>{s.show_weight && <th class="r">{tIn(l, 'doc_weight')}</th>}</tr></thead>
        <tbody>
          {s.items.map((it, i) => (
            <tr>
              <td>{i + 1}</td>
              <td><b>{it.grade}</b><div class="pp-mute pp-small">{tIn(l, SHAPE_LOOK[it.shape]?.word || it.shape)}{it.hsn ? ` · HSN ${it.hsn}` : ''}</div></td>
              <td class="pp-num">{sizeText(it)}</td>
              <td class="pp-num">{lengthRows(it, l).map((x) => <div>{x}</div>)}</td>
              {s.show_weight && <td class="pp-num r" style="font-weight:700">{it.weight != null ? `${it.weight.toFixed(2)} kg` : ''}</td>}
            </tr>
          ))}
          {s.show_weight && s.total_weight != null && <tr class="pp-noline"><td /><td colSpan={3} class="pp-mute">{tIn(l, 'doc_weighed')}</td><td class="pp-num r" style="font-weight:800">{Number(s.total_weight).toFixed(2)} kg</td></tr>}
        </tbody>
      </table>
      <div class="pp-foot">
        <div class="pp-grow">{s.balance > 0 && <PayBox upi={upi} lang={l} />}</div>
        <div class="pp-sums">
          {lines.map(([a, b]) => <div class="pp-lr"><span class="pp-mute">{a}</span><span class="pp-num">{money(b, true)}</span></div>)}
          <div class="pp-lr pp-total"><span>{tIn(l, 'total')}</span><span class="pp-num">{money(s.total, true)}</span></div>
          {s.payments.map((p) => <div class="pp-lr pp-paid"><span>{payLabel(l, p, tz)}</span><span class="pp-num">{p.amount < 0 ? '+ ' : '− '}{money(Math.abs(p.amount), true)}</span></div>)}
          <div class={`pp-lr pp-bal ${s.balance > 0 ? 'due' : 'ok'}`}><span>{s.balance > 0 ? tIn(l, 'bal_to_pay') : tIn(l, 'doc_balance')}</span><span class="pp-num">{money(s.balance, true)}</span></div>
        </div>
      </div>
      {paidUp && <div class="pp-stamp">{tIn(l, 'doc_paid_stamp')}</div>}
      <div class="pp-grow" />
      <div class="pp-bottom"><span>{s.gst ? tIn(l, 'slip_gst') : tIn(l, 'doc_thanks_biz')}</span></div>
    </div>
  );
}

/** The account statement: opening balance, every slip and payment with running balance, closing + UPI QR. */
export function StatementPaper({ doc, madeAt = new Date().toISOString(), showQr = true }) {
  const l = doc.lang; const tz = doc.timezone;
  const closingBox = doc.closing > 0 ? tIn(l, 'bal_to_pay') : doc.closing < 0 ? tIn(l, 'stmt_credit') : tIn(l, 'doc_balance');
  const detail = (r) => {
    if (r.type === 'slip') return `${tIn(l, 'stmt_slip', r.slip)}${r.gst && !doc.gst_only ? ` · ${tIn(l, 'bill_gst_short')}` : ''}`;
    if (r.type === 'old') return r.slip ? tIn(l, 'old_slip', r.slip) : tIn(l, 'old_balance');
    const what = r.amount < 0 ? tIn(l, 'doc_returned') : r.kind === 'settled' ? tIn(l, 'stmt_paid_for', r.slip) : r.pending ? tIn(l, 'stmt_pending') : r.kind === 'advance' && r.slip ? tIn(l, 'stmt_adv_for', r.slip) : tIn(l, 'stmt_pay_in');
    return [what, r.mode && r.mode !== 'Adjust' ? modeWord(l, r.mode) : null].filter(Boolean).join(' · ');
  };
  return (
    <div class="pp pp-page pp-a4">
      <ShopHead shop={doc.shop} gst right={<>
        <div class="pp-cap pp-kind">{tIn(l, 'stmt_title')}</div>
        <div style="font-weight:800;font-size:16px;margin-top:2px">{fmtDay(doc.period.from, false)} – {fmtDay(doc.period.to)}</div>
        <div class="pp-mute pp-small">{tIn(l, 'stmt_made', `${shortDate(madeAt, tz)}, ${time(madeAt, tz)}`)}</div>
      </>} />
      <CustomerBox c={doc.customer} l={l} gst />
      <div class="pp-boxes">
        {[[tIn(l, 'stmt_opening'), doc.opening], [tIn(l, 'stmt_bought'), doc.bought], [tIn(l, 'stmt_total_due'), Math.round((doc.opening + doc.bought) * 100) / 100], [tIn(l, 'stmt_paid'), doc.paid], [closingBox, Math.abs(doc.closing)]].map(([a, b], i) => (
          <div class={`pp-box ${i === 2 ? 'sum' : ''} ${i === 4 ? (doc.closing > 0 ? 'due' : 'ok') : ''}`}><div class="pp-cap">{a}</div><div class="pp-num">{money(b, true)}</div></div>
        ))}
      </div>
      <table class="pp-table pp-stmt">
        <thead><tr><th>{tIn(l, 'stmt_h_date')}</th><th>{tIn(l, 'stmt_h_details')}</th><th class="r">{tIn(l, 'stmt_bought')}</th><th class="r">{tIn(l, 'stmt_paid')}</th><th class="r">{tIn(l, 'stmt_h_bal')}</th></tr></thead>
        <tbody>
          {doc.opening !== 0 && <tr><td class="pp-num">{fmtDay(doc.period.from, false)}</td><td>{tIn(l, 'stmt_bf')}</td><td /><td /><td class="pp-num r" style="font-weight:700">{n2(doc.opening)}</td></tr>}
          {doc.rows.map((r) => (
            <tr>
              <td class="pp-num">{fmtDay(r.day, false)}</td>
              <td>{detail(r)}</td>
              <td class="pp-num r">{r.type !== 'pay' ? n2(r.amount) : ''}</td>
              <td class="pp-num r" style="color:#1C8456">{r.type === 'pay' ? (r.amount < 0 ? `− ${n2(-r.amount)}` : n2(r.amount)) : ''}</td>
              <td class="pp-num r" style="font-weight:700">{n2(r.bal)}</td>
            </tr>
          ))}
          {doc.rows.length === 0 && <tr><td colSpan={5} class="pp-mute">{tIn(l, 'stmt_none')}</td></tr>}
        </tbody>
      </table>
      {showQr && doc.upi && <div style="margin-top:18px"><PayBox upi={doc.upi} lang={l} sub={tIn(l, 'stmt_pay_any')} /></div>}
      <div class="pp-grow" />
      <div class="pp-bottom"><span>{doc.shop.phone ? tIn(l, 'stmt_questions', doc.shop.phone) : ''}</span></div>
    </div>
  );
}
