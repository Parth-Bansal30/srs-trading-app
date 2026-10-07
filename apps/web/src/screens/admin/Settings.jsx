// Settings: shop details, money rules, slip numbering, reminders, security. Only changed values are sent.
import { useEffect, useState } from 'preact/hooks';
import { formatSlipNo } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { can, company, refresh } from '../../lib/session.js';
import { db } from '../../lib/backend.js';
import { forgetCatalog } from '../../lib/catalog.js';
import { useAction } from '../../lib/action.js';
import { toast } from '../../ui/toast.js';
import { go } from '../../lib/router.js';
import { TopBar, Skeleton, Icon } from '../../ui/kit.jsx';

export function Settings() {
  const [s, setS] = useState(null);       // saved
  const [v, setV] = useState(null);       // editing
  const [co, setCo] = useState(null);
  const [hasOrders, setHasOrders] = useState(true);
  const a = useAction('changeSettings');
  const load = async () => {
    const [{ data: st }, { data: c }, { count }] = await Promise.all([
      db.from('company_settings').select('*').maybeSingle(),
      db.from('companies').select('name,legal_name,gstin,phone,address,city,timezone').maybeSingle(),
      db.from('orders').select('id', { count: 'exact', head: true }),
    ]);
    const flat = { ...st, company_name: c?.name, gstin: c?.gstin || '', company_phone: c?.phone || '', address: c?.address || '', city: c?.city || '', upi_id: st?.upi_id || '' };
    setS(flat); setV(flat); setCo(c); setHasOrders((count ?? 1) > 0);
  };
  useEffect(() => { load(); }, []);
  if (!v) return <><TopBar title={t('nav_settings')} /><div class="page"><Skeleton h={200} /></div></>;

  const edit = can('settings');
  const set = (k) => (e) => setV({ ...v, [k]: e.currentTarget.type === 'checkbox' ? e.currentTarget.checked : e.currentTarget.value });
  const NUM = ['gst_pct', 'kacha_pct', 'min_inch', 'weight_warn_pct', 'first_slip_no', 'reminder_after_days', 'reminder_repeat_days', 'unlock_hours', 'ai_daily_limit'];
  const changes = {};
  for (const k of [...NUM, 'default_unit', 'show_weight_on_slip', 'slip_numbering']) if (String(v[k]) !== String(s[k])) changes[k] = NUM.includes(k) ? Number(v[k]) : v[k];
  const comp = {};
  if (v.company_name !== s.company_name) comp.name = v.company_name;
  if (v.gstin !== s.gstin) comp.gstin = v.gstin;
  if (v.company_phone !== s.company_phone) comp.phone = v.company_phone;
  if (v.address !== s.address) comp.address = v.address;
  if (v.city !== s.city) comp.city = v.city;
  if ((v.upi_id || '').trim() !== (s.upi_id || '')) changes.upi_id = (v.upi_id || '').trim() || null;
  if (Object.keys(comp).length) changes.company = comp;
  const dirty = Object.keys(changes).length > 0;
  const save = () => a.run({ changes }).then(async () => { toast(t('saved')); forgetCatalog(); await load(); refresh(); }).catch(() => {});

  const row = ({ k, w, suffix, type = 'number', note, disabled }) => (
    <div class="li" style="flex-wrap:wrap">
      <div class="grow"><div class="t">{t(w)}</div>{note && <div class="s">{note}</div>}</div>
      <div class="field num" style="width:130px;min-height:46px"><input type={type} inputmode={type === 'number' ? 'decimal' : 'text'} disabled={!edit || disabled} value={v[k] ?? ''} onInput={set(k)} />{suffix && <span class="faint unit">{suffix}</span>}</div>
    </div>
  );

  return (
    <>
      <TopBar title={t('nav_settings')} />
      <div class="page" style="padding-bottom:160px">
        {edit && (
          <button class="card li" style="margin-bottom:4px" onClick={() => go('/settings/accounts')}>
            <div class="iconbox tone-ok"><Icon name="Wallet" size={20} /></div>
            <div class="grow"><div class="t">{t('acc_set_row')}</div><div class="s">{t('acc_set_row_s')}</div></div>
            <Icon name="ChevronRight" size={18} />
          </button>
        )}
        <div class="sec" style="margin-top:4px"><h3>{t('company_title')}</h3></div>
        <div class="card pad">
          <div class="lbl">{t('shop_name')}</div><div class="field"><input disabled={!edit} value={v.company_name} onInput={set('company_name')} /></div>
          <div class="row" style="gap:10px;margin-top:12px">
            <div class="grow"><div class="lbl">{t('phone')}</div><div class="field"><input disabled={!edit} value={v.company_phone} onInput={set('company_phone')} /></div></div>
            <div class="grow"><div class="lbl">{t('gstin')}</div><div class="field"><input disabled={!edit} value={v.gstin} onInput={(e) => setV({ ...v, gstin: e.currentTarget.value.toUpperCase() })} /></div></div>
          </div>
          <div class="lbl" style="margin-top:12px">{t('address')}</div><input class="textarea" disabled={!edit} value={v.address} onInput={set('address')} />
          <div class="lbl" style="margin-top:12px">{t('reg_city')}</div><div class="field"><input disabled={!edit} value={v.city} onInput={set('city')} /></div>
          <div class="lbl" style="margin-top:12px">{t('upi_id')}</div>
          <div class="field"><Icon name="IndianRupee" size={18} /><input disabled={!edit} value={v.upi_id} autocapitalize="off" autocorrect="off" spellcheck={false} placeholder="shopname@okaxis" onInput={set('upi_id')} /></div>
          {/sample/i.test(v.upi_id || '') && <div class="notice tone-warn" style="margin-top:8px;border-radius:12px;padding:10px 12px;font-size:13px">{t('upi_sample_note')}</div>}
        </div>

        <div class="sec"><h3>{t('money_rules')}</h3></div>
        <div class="card">
          {row({ k: "gst_pct", w: "gst_pct", suffix: "%" })}
          {row({ k: "kacha_pct", w: "kacha_pct", suffix: "%" })}
          {row({ k: "min_inch", w: "min_inch", suffix: "in" })}
          {row({ k: "weight_warn_pct", w: "warn_pct", suffix: "%" })}
          <div class="li"><div class="grow t">{t('unit_default')}</div>
            <div class="seg" style="width:140px"><button class={v.default_unit === 'mm' ? 'on' : ''} disabled={!edit} onClick={() => setV({ ...v, default_unit: 'mm' })}>{t('u_mm')}</button><button class={v.default_unit === 'in' ? 'on' : ''} disabled={!edit} onClick={() => setV({ ...v, default_unit: 'in' })}>{t('u_in')}</button></div></div>
        </div>

        <div class="sec"><h3>{t('slip_settings')}</h3></div>
        <div class="card">
          <label class="li"><div class="grow"><div class="t">{t('show_weight')}</div></div><input type="checkbox" class="switch" disabled={!edit} checked={!!v.show_weight_on_slip} onChange={set('show_weight_on_slip')} /></label>
          <div class="li" style="flex-direction:column;align-items:stretch">
            <div class="t">{t('num_reset')}</div>
            <div class="pick" style="margin-top:8px">{[['never', 'num_never'], ['daily', 'num_daily'], ['monthly', 'num_monthly'], ['yearly', 'num_yearly']].map(([id, w]) =>
              <button class={v.slip_numbering === id ? 'on' : ''} disabled={!edit} onClick={() => setV({ ...v, slip_numbering: id })}>{t(w)}</button>)}</div>
            <div class="s" style="margin-top:8px">{t('num_reset_preview')}: <b class="num">#{formatSlipNo(v.slip_numbering, new Date().toISOString(), 1, co?.timezone)}</b></div>
          </div>
          {row({ k: "first_slip_no", w: "first_slip", note: t('first_slip_s'), disabled: hasOrders })}
        </div>

        <div class="sec"><h3>{t('reminders_rules')}</h3></div>
        <div class="card">
          {row({ k: "reminder_after_days", w: "rem_after" })}
          {row({ k: "reminder_repeat_days", w: "rem_repeat" })}
        </div>

        <div class="sec"><h3>{t('security')}</h3></div>
        <div class="card">
          {row({ k: "unlock_hours", w: "unlock_hours" })}
          {row({ k: "ai_daily_limit", w: "ai_limit" })}
        </div>
        {a.error && <div class="error">{a.error.message}</div>}
      </div>
      {edit && dirty && <div class="actionbar"><button class="btn btn-accent btn-block" disabled={a.busy} onClick={save}>{t('save')}</button></div>}
    </>
  );
}
