// Purchase bills (newest first): supplier, date, kg, total, paid or to pay. Address: #/purchases
import { useEffect, useState } from 'preact/hooks';
import { t } from '../../lib/i18n.js';
import { company } from '../../lib/session.js';
import { call } from '../../lib/api.js';
import { money } from '../../lib/format.js';
import { go } from '../../lib/router.js';
import { kgTxt } from '../../lib/stock.js';
import { fmtDay } from '../../lib/docs.js';
import { Icon, Chip, TopBar, Skeleton } from '../../ui/kit.jsx';
import { shopToday } from '../../lib/expenses.js';
import './stock.css';

export function Purchases() {
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [f, setF] = useState('all');
  useEffect(() => { call('purchases', { limit: 300 }).then(setRows).catch((e) => setErr(e.message)); }, []);
  const list = (rows || []).filter((p) => f === 'all' || (f === 'to_pay' ? p.status === 'saved' && p.pay_status === 'to_pay' : true));
  // what is still owed on the bills (part payments counted; 5 Nov 2026). Advances are on each supplier's page.
  const toPay = (rows || []).filter((p) => p.status === 'saved' && p.pay_status === 'to_pay' && p.kind === 'bill').reduce((a, p) => a + Number(p.left ?? p.total), 0);
  const chip = (p) => (p.settled === 'outside' ? <Chip tone="neutral">{t('pu_paid_outside')}</Chip>
    : p.pay_status === 'paid' ? <Chip tone="ok">{t('pu_paid')}</Chip>
      : Number(p.left) < Number(p.total) - 0.5 ? <Chip tone="accent">{t('sk_left_short', money(Number(p.left), false))}</Chip>
        : <Chip tone={p.due_date && p.due_date < shopToday() ? 'bad' : 'warn'}>{p.due_date && p.due_date < shopToday() ? t('sk_st_overdue') : t('pu_to_pay')}</Chip>);
  return (
    <>
      <TopBar title={t('nav_purchases')} sub={rows ? t('pu_list_sub', rows.length, `${t('pu_to_pay')} ${money(toPay, false)}`) : ''}
        right={<button class="round" onClick={() => go('/stock')} aria-label={t('nav_stock')}><Icon name="Boxes" size={19} /></button>} />
      <div class="page" style="padding-bottom:calc(var(--tabbar-h) + 40px)">
        <button class="btn btn-accent btn-block" onClick={() => go('/purchases/new')}><Icon name="FileUp" size={19} stroke={2.3} />{t('st_add_bill')}</button>
        <div class="seg" style="margin-top:12px"><button class={f === 'all' ? 'on' : ''} onClick={() => setF('all')}>{t('f_all')}</button>
          <button class={f === 'to_pay' ? 'on' : ''} onClick={() => setF('to_pay')}>{t('pu_to_pay')}</button></div>
        {err && <div class="error">{err}</div>}
        <div class="card" style="margin-top:12px">
          {!rows ? <div class="pad"><Skeleton h={18} /><Skeleton h={18} w="70%" style="margin-top:12px" /></div>
            : list.length === 0 ? <div class="li muted">{t('pu_none')}</div>
              : list.map((p) => (
                <button class="li" onClick={() => go(`/purchase/${p.id}`)} style={p.status === 'cancelled' ? 'opacity:.55' : ''}>
                  <div class="iconbox tone-neutral" style="width:38px;height:38px"><Icon name={p.kind === 'opening' ? 'PackagePlus' : 'Truck'} size={18} /></div>
                  <div class="grow">
                    <div class="t ellip">{p.kind === 'opening' ? t('pu_opening') : p.supplier}</div>
                    <div class="s">{fmtDay(p.bill_date, false)}{p.bill_no ? ` · ${t('pu_bill_no')} ${p.bill_no}` : ''} · {kgTxt(p.kg)}{p.bill_type === 'kacha' && p.kind === 'bill' ? ` · ${t('bill_none_short')}` : ''}</div>
                  </div>
                  <div style="text-align:right">
                    <b class="num" style="font-size:14.5px">{money(p.total, false)}</b>
                    <div>{p.status === 'cancelled' ? <Chip tone="neutral">{t('pu_cancelled')}</Chip>
                      : p.kind === 'opening' ? null : chip(p)}</div>
                  </div>
                </button>
              ))}
        </div>
      </div>
    </>
  );
}
