// "Your shop is ready!" — shown right after a business registers, and from the Today card
// until the first three steps are done: check rates, invite the team, make the first slip.
import { useEffect, useState } from 'preact/hooks';
import { whatsappLink } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { me, company } from '../../lib/session.js';
import { db } from '../../lib/backend.js';
import { store } from '../../lib/store.js';
import { longDay } from '../../lib/format.js';
import { go } from '../../lib/router.js';
import { Icon, Skeleton } from '../../ui/kit.jsx';
import { Avatar } from '../login/Login.jsx';
import './start.css';

const CONFETTI = [[40, 50, '#E08A2B', 10, 20], [300, 40, '#2C5CC5', 8, 8], [70, 170, '#1C8456', 12, 6], [290, 160, '#E08A2B', 6, 16], [170, 20, '#C2412F', 7, 7], [240, 100, '#1B2130', 5, 14], [110, 100, '#F0A04B', 9, 9]];

export const startDone = () => store.get('start_done') === '1';

export function Start() {
  const [d, setD] = useState(null);
  const [invited, setInvited] = useState(() => store.json('invited') || {});
  const [ratesSeen, setRatesSeen] = useState(store.get('start_rates') === '1');
  useEffect(() => {
    Promise.all([
      db.from('materials').select('id', { count: 'exact', head: true }),
      db.from('people').select('id,display_name,phone,role,auth_user_id').eq('active', true),
      db.from('orders').select('id', { count: 'exact', head: true }),
    ]).then(([m, p, o]) => setD({ grades: m.count || 0, people: p.data || [], orders: o.count || 0 }));
  }, []);
  const c = company.value;
  const waiting = (d?.people || []).filter((p) => !p.auth_user_id);
  const teamDone = d && d.people.length > 1 && waiting.every((p) => invited[p.phone]);
  const done = [ratesSeen, teamDone, (d?.orders || 0) > 0].filter(Boolean).length;
  useEffect(() => { if (done === 3) store.set('start_done', '1'); }, [done]);

  const link = `${location.origin}${location.pathname}#/join`;
  const invite = (p) => {
    const text = t('invite_msg', p.display_name.split(' ')[0], (me.value?.name || '').split(' ')[0], c?.name, t(`role_${p.role}`), link, p.phone?.slice(3));
    const next = { ...invited, [p.phone]: true };
    setInvited(next); store.setJson('invited', next);
    window.open(whatsappLink(p.phone, text), '_blank');
  };
  const step = (n, ok, title, sub, onClick) => (
    <button class="li" onClick={onClick}>
      <span class={`start-n ${ok ? 'ok' : ''}`}>{ok ? <Icon name="Check" size={16} stroke={3} /> : n}</span>
      <div class="grow"><div class="t">{title}</div><div class="s">{sub}</div></div>
      <Icon name="ChevronRight" size={18} style="color:var(--ink-3)" />
    </button>
  );

  return (
    <div class="page start">
      <div class="start-top">
        {CONFETTI.map(([x, y, col, w, h], i) => <i style={`left:${x}px;top:${y}px;width:${w}px;height:${h}px;background:${col};transform:rotate(${i * 37}deg)`} />)}
        <div class="start-icon"><Icon name="PartyPopper" size={52} stroke={1.9} /></div>
      </div>
      <h1 class="start-title">{t('ready_t', c?.name || '')}</h1>
      {c?.trial_ends_at && <p class="muted" style="text-align:center;margin-top:8px">{t('ready_s', longDay(c.trial_ends_at, c.timezone))}</p>}

      <div class="sec"><h3>{t('ready_steps')}</h3><span class="faint num" style="font-size:13px;font-weight:700">{t('ready_of', done, 3)}</span></div>
      {!d ? <div class="card pad"><Skeleton h={18} /><Skeleton h={18} style="margin-top:12px" /></div> : (
        <div class="card">
          {step(1, ratesSeen, t('ready_rates'), t('ready_rates_s', d.grades), () => { store.set('start_rates', '1'); setRatesSeen(true); go('/rates'); })}
          {step(2, teamDone, t('ready_team'), t('ready_team_s'), () => go('/people'))}
          {waiting.map((p) => (
            <div class="li start-person">
              <Avatar name={p.display_name} size={36} />
              <div class="grow"><div class="t">{p.display_name}</div><div class="s">{t(`role_${p.role}`)} · <span class="num">{p.phone?.slice(3)}</span></div></div>
              {invited[p.phone]
                ? <button class="chip tone-ok" style="height:32px" onClick={() => invite(p)}><Icon name="Check" size={13} stroke={3} />{t('invite_sent')}</button>
                : <button class="btn btn-wa" style="min-height:36px;font-size:14px;padding:0 12px;border-radius:12px" onClick={() => invite(p)}><Icon name="MessageCircle" size={15} stroke={2.4} />{t('invite_send')}</button>}
            </div>
          ))}
          {step(3, d.orders > 0, t('ready_slip'), t('ready_slip_s'), () => go('/new'))}
        </div>
      )}
      <button class="btn btn-accent btn-block" style="margin-top:22px" onClick={() => go('/')}>{t('ready_go')}<Icon name="ArrowRight" size={20} stroke={2.3} /></button>
    </div>
  );
}
