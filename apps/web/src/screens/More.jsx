// More — every other screen, plus language, appearance and log out.
import { t, lang, setLang } from '../lib/i18n.js';
import { me, company, can, lock, logOut, switchPerson } from '../lib/session.js';
import { theme, applyTheme } from '../lib/theme.js';
import { go } from '../lib/router.js';
import { MENU } from '../config/navigation.js';
import { APP } from '../config/app.js';
import { longDay } from '../lib/format.js';
import { Icon, TopBar } from '../ui/kit.jsx';

export function More() {
  const c = company.value;
  const trialLeft = c?.plan === 'trial' && c?.trial_ends_at ? Math.max(0, Math.ceil((new Date(c.trial_ends_at) - Date.now()) / 86400000)) : null;
  const items = MENU.filter((m) => m.id !== 'today' && (!m.perm || can(m.perm)));
  return (
    <>
      <TopBar title={t('nav_more')} sub={`${me.value?.name} · ${company.value?.name}`} onBack={null} />
      <div class="page">
        {trialLeft != null && (
          <button class="card li" style="margin-bottom:12px" onClick={() => can('people') && go('/start')}>
            <div class="iconbox tone-accent"><Icon name="Gift" /></div>
            <div class="grow"><div class="t">{t('trial_left', trialLeft)}</div><div class="s">{t('trial_ends', longDay(company.value.trial_ends_at, company.value.timezone))}</div></div>
          </button>
        )}
        <div class="card">
          {items.map((m) => (
            <button class="li" onClick={() => go(m.route)}>
              <div class="iconbox tone-neutral"><Icon name={m.icon} /></div>
              <div class="grow t">{t(m.word)}</div>
              <Icon name="ChevronRight" size={18} style="color:var(--ink-3)" />
            </button>
          ))}
        </div>

        <div class="sec"><h3>{t('language')}</h3></div>
        <div class="seg">{APP.languages.map((l) => <button class={lang.value === l.id ? 'on' : ''} onClick={() => setLang(l.id)}>{l.label}</button>)}</div>

        <div class="sec"><h3>{t('theme')}</h3></div>
        <div class="seg">
          {[['auto', 'theme_auto'], ['light', 'theme_light'], ['dark', 'theme_dark']].map(([id, w]) =>
            <button class={theme.value === id ? 'on' : ''} onClick={() => applyTheme(id)}>{t(w)}</button>)}
        </div>

        <div class="card" style="margin-top:22px">
          <button class="li" onClick={lock}><div class="iconbox tone-neutral"><Icon name="Lock" /></div><div class="grow t">{t('lock')}</div></button>
          <button class="li" onClick={switchPerson}><div class="iconbox tone-neutral"><Icon name="Users" /></div><div class="grow t">{t('switch_person')}</div></button>
          <button class="li" onClick={logOut}><div class="iconbox tone-bad"><Icon name="LogOut" /></div><div class="grow t">{t('log_out_phone')}</div></button>
        </div>
        <div class="faint" style="text-align:center;font-size:12px;margin-top:18px">{APP.name} · v{APP.version}</div>
      </div>
    </>
  );
}
