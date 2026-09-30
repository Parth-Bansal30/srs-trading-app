// Deleted slips (owners only): who deleted, when and why — plus staff requests waiting for an answer.
// Address: #/slips/deleted
import { useEffect, useState } from 'preact/hooks';
import { t } from '../../lib/i18n.js';
import { can, company } from '../../lib/session.js';
import { call } from '../../lib/api.js';
import { useAction } from '../../lib/action.js';
import { money, shortDate, time } from '../../lib/format.js';
import { go } from '../../lib/router.js';
import { toast } from '../../ui/toast.js';
import { Icon, TopBar, Skeleton } from '../../ui/kit.jsx';
import { DeleteSheet } from './DeleteSheet.jsx';
import './slips.css';

export function DeletedSlips() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const [which, setWhich] = useState('month');
  const [del, setDel] = useState(null); // a request being handled
  const decline = useAction('declineDelete');
  const tz = company.value?.timezone;
  const load = () => call('deletedSlips', {}).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { if (can('delete')) load(); }, []);

  if (!can('delete')) return <><TopBar title={t('nav_deleted')} /><div class="page muted">{t('del_only_owners')}</div></>;
  const monthStart = (() => { const x = new Date(); return new Date(x.getFullYear(), x.getMonth(), 1).toISOString(); })();
  const rows = (d?.deleted || []).filter((x) => which === 'all' || x.at >= monthStart);

  return (
    <>
      <TopBar title={t('nav_deleted')} sub={t('del_only_owners')} />
      <div class="page" style="padding-bottom:calc(var(--tabbar-h) + 40px)">
        {err && <div class="error">{err}</div>}
        {d?.requests?.length > 0 && <>
          <div class="sec" style="margin-top:0"><h3>{t('del_requests')}</h3></div>
          <div class="card" style="margin-bottom:14px">
            {d.requests.map((r) => (
              <div class="li" style="flex-direction:column;align-items:stretch;gap:10px">
                <button class="row" style="gap:12px;text-align:left" onClick={() => go(`/slip/${r.order_id}`)}>
                  <div class="iconbox tone-warn" style="width:36px;height:36px"><Icon name="Trash2" size={18} /></div>
                  <div class="grow"><div class="t num">#{r.slip_no} · {r.customer}</div>
                    <div class="s">{t('del_asked', r.by || '')} · {shortDate(r.at, tz)}</div><div class="s">“{r.reason}”</div></div>
                </button>
                <div class="row" style="gap:10px">
                  <button class="btn btn-ghost grow" style="min-height:42px;font-size:14.5px" disabled={decline.busy}
                    onClick={() => decline.run({ request_id: r.id }).then(() => { toast(t('done_ok')); load(); }).catch(() => {})}>{t('del_not_needed')}</button>
                  <button class="btn btn-bad grow" style="min-height:42px;font-size:14.5px" onClick={() => setDel(r)}><Icon name="Trash2" size={17} />{t('del_delete')}</button>
                </div>
              </div>
            ))}
          </div>
        </>}

        <div class="seg"><button class={which === 'month' ? 'on' : ''} onClick={() => setWhich('month')}>{t('del_this_month')}</button>
          <button class={which === 'all' ? 'on' : ''} onClick={() => setWhich('all')}>{t('f_all')}</button></div>
        <div class="card" style="margin-top:12px">
          {!d ? <div class="pad"><Skeleton h={18} /><Skeleton h={18} w="70%" style="margin-top:12px" /></div>
            : rows.length === 0 ? <div class="li muted">{t('del_none')}</div>
              : rows.map((x) => (
                <button class="li" style="align-items:flex-start" onClick={() => go(`/slip/${x.id}`)}>
                  <div class="iconbox tone-bad" style="width:36px;height:36px"><Icon name="Trash2" size={18} /></div>
                  <div class="grow">
                    <div class="row" style="justify-content:space-between;gap:8px"><div class="t num ellip">#{x.slip_no} · {x.customer}</div>
                      {x.total != null && <b class="num faint" style="font-size:14px;text-decoration:line-through;white-space:nowrap">{money(x.total, true)}</b>}</div>
                    <div class="s">{t('del_by', x.by || '', `${shortDate(x.at, tz)}, ${time(x.at, tz)}`)}</div>
                    <div class="s">“{x.reason}”</div>
                  </div>
                </button>
              ))}
        </div>

        <div class="card pad" style="margin-top:12px;font-size:13.5px;line-height:1.5;color:var(--ink-2)">
          <div class="row" style="gap:8px;font-weight:700;color:var(--ink);font-size:14px;margin-bottom:4px"><Icon name="Info" size={17} />{t('del_kept_t')}</div>
          {t('del_kept_s')}
        </div>
        <button class="card li" style="margin-top:12px;border-style:dashed;box-shadow:none;width:100%" onClick={() => go('/slips')}>
          <div class="iconbox tone-neutral" style="width:36px;height:36px"><Icon name="ListChecks" size={18} /></div>
          <div class="grow"><div class="t" style="font-size:14.5px">{t('del_many_t')}</div><div class="s">{t('del_many_s')}</div></div>
        </button>
      </div>
      <DeleteSheet open={!!del} ids={del ? [del.order_id] : []} onClose={() => setDel(null)}
        onDone={() => { toast(t('del_done_1', del?.slip_no || '')); setDel(null); load(); }} />
    </>
  );
}
