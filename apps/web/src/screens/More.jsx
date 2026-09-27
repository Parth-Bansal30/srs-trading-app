// More — every other screen, plus language, appearance and log out.
import { t, lang, setLang } from '../lib/i18n.js';
import { me, company, can, lock, logOut } from '../lib/session.js';
import { theme, applyTheme } from '../lib/theme.js';
import { go } from '../lib/router.js';
import { MENU } from '../config/navigation.js';
import { APP } from '../config/app.js';
import { Icon, TopBar } from '../ui/kit.jsx';

export function More() {
  const items = MENU.filter((m) => m.id !== 'today' && (!m.perm || can(m.perm)));
  return (
    <>
      <TopBar title={t('nav_more')} sub={`${me.value?.name} · ${company.value?.name}`} onBack={null} />
      <div class="page">
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
          <button class="li" onClick={logOut}><div class="iconbox tone-bad"><Icon name="LogOut" /></div><div class="grow t">{t('switch_person')}</div></button>
        </div>
        <div class="faint" style="text-align:center;font-size:12px;margin-top:18px">{APP.name} · v{APP.version}</div>
      </div>
    </>
  );
}
