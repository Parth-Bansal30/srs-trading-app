// The app frame: login gate → screens, with the bottom bar (phone) or left menu (laptop).
import { useEffect } from 'preact/hooks';
import { auth, boot, can } from './lib/session.js';
import { route, go } from './lib/router.js';
import { t } from './lib/i18n.js';
import { TABS, MENU } from './config/navigation.js';
import { APP } from './config/app.js';
import { Icon } from './ui/kit.jsx';
import { PhoneStep, CodeStep, SetPinStep, UnlockStep, NotStaffStep } from './screens/login/Login.jsx';
import { Today } from './screens/Today.jsx';
import { More } from './screens/More.jsx';
import { Soon } from './screens/Soon.jsx';

// Which screen for which address. Add a screen: one line here (+ a menu entry in config/navigation.js).
const SCREENS = {
  '/': () => <Today />,
  '/more': () => <More />,
};
const soonFor = (path) => {
  const m = [...MENU, ...TABS].find((x) => x.route.split('?')[0] === path);
  return <Soon word={m?.word || 'soon'} />;
};

function TabBar({ path }) {
  return (
    <nav class="tabbar">
      {TABS.filter((x) => !x.perm || can(x.perm)).map((x) => x.big
        ? <div style="width:68px;display:flex;justify-content:center"><button class="fab" onClick={() => go(x.route)} aria-label={t(x.word)}><Icon name={x.icon} size={30} stroke={2.4} /></button></div>
        : <button class={`tab ${path === x.route ? 'on' : ''}`} onClick={() => go(x.route)}><Icon name={x.icon} size={24} stroke={path === x.route ? 2.2 : 1.8} /><span>{t(x.word)}</span></button>)}
    </nav>
  );
}

function Sidebar({ path }) {
  return (
    <aside class="sidebar">
      <div class="row" style="padding:0 8px 22px"><div class="brandmark" style="width:34px;height:34px;border-radius:10px;background:var(--accent);color:var(--accent-ink);display:flex;align-items:center;justify-content:center;font-weight:800">{APP.name.slice(0, 1)}</div><div style="font-weight:800">{APP.name}</div></div>
      {can('new') && <button class="btn btn-accent" style="min-height:44px;font-size:15px;margin-bottom:10px" onClick={() => go('/new')}><Icon name="Plus" size={18} stroke={2.6} />{t('nav_new')}</button>}
      {MENU.filter((m) => !m.perm || can(m.perm)).map((m) => (
        <button class={`side-item ${path === m.route ? 'on' : ''}`} onClick={() => go(m.route)}><Icon name={m.icon} size={18} stroke={2} />{t(m.word)}</button>
      ))}
      <button class={`side-item ${path === '/more' ? 'on' : ''}`} style="margin-top:auto" onClick={() => go('/more')}><Icon name="Settings" size={18} stroke={2} />{t('nav_more')}</button>
    </aside>
  );
}

export function App() {
  useEffect(() => { boot(); }, []);
  const step = auth.value.step;
  if (step === 'loading') return <div class="login" />;
  if (step === 'phone') return <PhoneStep />;
  if (step === 'code') return <CodeStep />;
  if (step === 'set_pin') return <SetPinStep />;
  if (step === 'unlock') return <UnlockStep />;
  if (step === 'not_staff') return <NotStaffStep />;
  if (step === 'error') return <div class="login"><div class="login-body"><div class="error">{t('err_generic')}</div><button class="btn btn-ghost" onClick={boot}>{t('retry')}</button></div></div>;

  const path = route.value.path;
  const screen = SCREENS[path] ? SCREENS[path]() : soonFor(path);
  return (
    <div class="app">
      <Sidebar path={path} />
      <main class="main">{screen}</main>
      <TabBar path={path} />
    </div>
  );
}
