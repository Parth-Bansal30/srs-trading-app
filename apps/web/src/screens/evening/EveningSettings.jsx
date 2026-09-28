// Evening summary settings: on/off, time, days, who gets it, and notifications on THIS phone (+ a test).
import { useEffect, useState } from 'preact/hooks';
import { t, lang } from '../../lib/i18n.js';
import { can, me } from '../../lib/session.js';
import { call } from '../../lib/api.js';
import { useAction } from '../../lib/action.js';
import { pushSupport, pushIsOn, pushOn, pushOff } from '../../lib/push.js';
import { avatarColour } from '../../lib/customers.js';
import { toast } from '../../ui/toast.js';
import { Icon, TopBar, Skeleton } from '../../ui/kit.jsx';
import './evening.css';

const ROLE_WORD = { owner: 'role_owner', sales: 'role_sales', weigher: 'role_weigher', accounts: 'role_accounts', custom: 'role_custom' };

export function EveningSettings() {
  const [s, setS] = useState(null);
  const [phone, setPhone] = useState(null); // true | false while checking null
  const [busy, setBusy] = useState(false);
  const save = useAction('eveningSet');
  const test = useAction('pushTest');
  const edit = can('settings');
  const support = pushSupport();
  const load = () => call('eveningGet', {}).then(setS).catch(() => setS({ error: true }));
  useEffect(() => { load(); pushIsOn().then(setPhone); }, []);
  if (!s) return <><TopBar title={t('eset_title')} /><div class="page"><Skeleton h={200} /></div></>;
  if (s.error) return <><TopBar title={t('eset_title')} /><div class="page muted">{t('err_generic')}</div></>;

  const change = (changes) => save.run({ changes }).then((r) => setS(r)).catch(() => {});
  const mine = s.people.find((p) => p.id === me.value?.id);
  const togglePhone = async () => {
    setBusy(true);
    try {
      if (phone) { await pushOff(); setPhone(false); } else { await pushOn(s.push_key); setPhone(true); }
      load();
    } catch (e) {
      toast(t(e.code === 'blocked' ? 'eset_blocked' : e.code === 'not_ready' ? 'eset_not_ready' : 'err_generic'));
    } finally { setBusy(false); }
  };

  return (
    <>
      <TopBar title={t('eset_title')} />
      <div class="page" style="padding-bottom:40px">
        <div class="lbl">{t('eset_this_phone')}</div>
        <div class="card">
          <label class="li">
            <div class="iconbox tone-accent"><Icon name="Bell" size={18} /></div>
            <div class="grow"><div class="t">{t('eset_this_phone')}</div><div class="s">{t('eset_this_phone_s')}</div></div>
            <input type="checkbox" class="switch" disabled={busy || support !== 'ok' || phone === null} checked={!!phone} onChange={togglePhone} />
          </label>
        </div>
        {support !== 'ok' && <div class="notice tone-warn" style="margin-top:8px;border-radius:12px;padding:10px 12px;font-size:13.5px">{t(support === 'needs_install' ? 'eset_install' : support === 'blocked' ? 'eset_blocked' : 'eset_no_support')}</div>}
        {!s.push_key && <div class="notice tone-warn" style="margin-top:8px;border-radius:12px;padding:10px 12px;font-size:13.5px">{t('eset_not_ready')}</div>}
        {phone && mine && !mine.on && <div class="notice tone-warn" style="margin-top:8px;border-radius:12px;padding:10px 12px;font-size:13.5px">{t('eset_not_on')}</div>}
        {phone && <button class="btn btn-ghost btn-block" style="margin-top:10px" disabled={test.busy} onClick={() => test.run({ lang: lang.value }).then((r) => toast(t('eset_test_ok', r.sent))).catch((e) => toast(e.message))}>
          <Icon name="Send" size={18} />{t('eset_test')}</button>}

        <div class="card" style="margin-top:16px">
          <label class="li"><div class="grow"><div class="t">{t('eset_on')}</div></div>
            <input type="checkbox" class="switch" disabled={!edit || save.busy} checked={s.on} onChange={(e) => change({ on: e.currentTarget.checked })} /></label>
          <div class="li"><div class="grow"><div class="t">{t('eset_time')}</div></div>
            <div class="field num" style="width:130px;min-height:44px"><input type="time" disabled={!edit} value={s.time} onChange={(e) => e.currentTarget.value && change({ time: e.currentTarget.value })} /></div></div>
          <div class="li" style="flex-direction:column;align-items:stretch;gap:8px"><div class="t">{t('eset_days')}</div>
            <div class="eset-days">{[1, 2, 3, 4, 5, 6, 7].map((n) => {
              const on = s.days.includes(n);
              return <button class={on ? 'on' : ''} disabled={!edit} onClick={() => change({ days: on ? s.days.filter((x) => x !== n) : [...s.days, n] })}>{t(`day_${n}`)}</button>;
            })}</div></div>
        </div>

        <div class="lbl" style="margin-top:16px">{t('eset_who')}</div>
        <div class="card">
          {s.people.map((p) => (
            <label class="li">
              <div class="eset-av" style={`background:${avatarColour(p.id)}`}>{p.name.charAt(0).toUpperCase()}</div>
              <div class="grow"><div class="t">{p.name}</div>
                <div class="s">{t(ROLE_WORD[p.role] || 'role_custom')} · {p.phones ? t('eset_phones', p.phones) : t('eset_no_phone')}</div></div>
              <input type="checkbox" style="width:24px;height:24px" disabled={!edit} checked={p.on} onChange={(e) => change({ people: { [p.id]: e.currentTarget.checked } })} />
            </label>
          ))}
        </div>
        <div class="faint" style="font-size:12.5px;font-weight:600;margin-top:8px">{t('eset_who_s')}</div>

        <div class="lbl" style="margin-top:16px">{t('eset_how')}</div>
        <div class="card pad" style="font-size:14px;line-height:1.45">
          <div class="row" style="gap:8px;font-weight:700"><Icon name="Bell" size={16} />{t('eset_notif')} ✓</div>
          <div class="faint" style="margin-top:6px;font-size:13px;font-weight:600">{t('eset_wa_later')}</div>
        </div>
        {save.error && <div class="error">{save.error.message}</div>}
      </div>
    </>
  );
}
