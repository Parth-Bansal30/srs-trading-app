// What the CUSTOMER sees when they open the link from WhatsApp: just that one slip or statement,
// with Download PDF, Pay by UPI and Call the shop. No login; the secret link is the key.
import { useEffect, useState } from 'preact/hooks';
import { db } from '../../lib/backend.js';
import { tIn } from '../../lib/i18n.js';
import { money } from '../../lib/format.js';
import { upiLink, isSampleUpi, docFileName } from '../../lib/docs.js';
import { drawOffscreen, paperToPdf, saveFile } from '../../lib/paper.js';
import { Icon } from '../../ui/kit.jsx';
import { SlipPaper, StatementPaper } from '../../ui/docs/Paper.jsx';
import { Preview } from '../../ui/docs/Preview.jsx';

export function PublicDoc({ token }) {
  const [d, setD] = useState(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    db.rpc('shared_doc', { p_token: token }).then(({ data, error }) => setD(error ? null : data || null)).catch(() => setD(null));
  }, [token]);
  useEffect(() => {
    if (!d || d.cancelled) return;
    const doc = d.doc;
    document.title = doc.kind === 'slip' ? `#${doc.slip.no} · ${doc.shop.name}` : `${doc.customer.name} · ${doc.shop.name}`;
  }, [d]);

  if (d === undefined) return <div class="pub"><div class="pp-preview" style="width:100%;max-width:560px;height:420px" /></div>;
  if (d === null) {
    return (
      <div class="pub" style="justify-content:center">
        <div class="card pad" style="max-width:420px;text-align:center">
          <Icon name="Info" size={28} />
          <div style="font-weight:700;margin-top:10px">{tIn('en', 'pub_gone')}</div>
          <div class="muted" style="margin-top:6px">{tIn('hi', 'pub_gone')}</div>
        </div>
      </div>
    );
  }

  if (d.cancelled) {
    const l = d.lang || 'en';
    return (
      <div class="pub" style="justify-content:center">
        <div class="card pad" style="max-width:420px;text-align:center">
          <Icon name="Info" size={28} />
          <div style="font-weight:800;font-size:17px;margin-top:10px">{tIn(l, 'pub_cancelled')}</div>
          <div class="muted" style="margin-top:6px">{tIn(l, 'pub_cancelled_s', d.slip_no || '')}</div>
          {d.shop?.name && <div style="font-weight:700;margin-top:14px">{d.shop.name}</div>}
          {d.shop?.phone && <a class="btn btn-ghost btn-block" style="margin-top:12px" href={`tel:${d.shop.phone.replace(/[^\d+]/g, '')}`}><Icon name="Phone" size={19} />{tIn(l, 'pub_call')}</a>}
        </div>
      </div>
    );
  }
  const doc = d.doc; const l = doc.lang;
  const paper = doc.kind === 'slip' ? <SlipPaper doc={doc} /> : <StatementPaper doc={doc} madeAt={d.made_at} />;
  const upi = doc.upi && !isSampleUpi(doc.upi.id) && doc.upi.amount > 0 ? doc.upi : null;
  const download = async () => {
    setBusy(true);
    const { node, cleanup } = drawOffscreen(paper);
    try { saveFile(await paperToPdf(node, { name: docFileName(doc), size: doc.kind === 'slip' ? 'page' : 'a4' })); } finally { cleanup(); setBusy(false); }
  };
  return (
    <div class="pub">
      <div style="width:100%;max-width:640px"><Preview>{paper}</Preview></div>
      <div class="pub-bar">
        {upi && <a class="btn btn-accent btn-block" href={upiLink(upi)}><Icon name="IndianRupee" size={20} stroke={2.4} />{tIn(l, 'pub_pay', money(upi.amount, true))}</a>}
        <div class="row" style="gap:10px">
          <button class="btn btn-brand grow" disabled={busy} onClick={download}><Icon name="Download" size={19} stroke={2.3} />{busy ? '…' : tIn(l, 'pub_download')}</button>
          {doc.shop.phone && <a class="btn btn-ghost" href={`tel:${doc.shop.phone.replace(/[^\d+]/g, '')}`} aria-label={tIn(l, 'pub_call')}><Icon name="Phone" size={19} /></a>}
        </div>
        {upi && <div class="faint" style="font-size:12px;font-weight:600;text-align:center">{tIn(l, 'pub_pay_note')}</div>}
      </div>
    </div>
  );
}
