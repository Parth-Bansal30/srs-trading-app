// The app frame: login gate → screens, with the bottom bar (phone) or left menu (laptop).
import { useEffect } from 'preact/hooks';
import { auth, boot, can, covered } from './lib/session.js';
import { route, go } from './lib/router.js';
import { t } from './lib/i18n.js';
import { TABS, MENU } from './config/navigation.js';
import { APP } from './config/app.js';
import { Icon } from './ui/kit.jsx';
import { PhoneStep, CodeStep, SetPinStep, UnlockStep, NotStaffStep, WhoStep, JoiningStep } from './screens/login/Login.jsx';
import { Welcome, Tour } from './screens/login/Welcome.jsx';
import { Register } from './screens/login/Register.jsx';
import { Start } from './screens/start/Start.jsx';
import { Today } from './screens/Today.jsx';
import { More } from './screens/More.jsx';
import { Soon } from './screens/Soon.jsx';
import { NewOrder } from './screens/order/NewOrder.jsx';
import { Slips } from './screens/slips/Slips.jsx';
import { DeletedSlips } from './screens/slips/DeletedSlips.jsx';
import { Stock } from './screens/stock/Stock.jsx';
import { StockItem } from './screens/stock/StockItem.jsx';
import { Purchases } from './screens/stock/Purchases.jsx';
import { Purchase } from './screens/stock/Purchase.jsx';
import { PurchaseNew } from './screens/stock/PurchaseNew.jsx';
import { updateReady, updateNow } from './lib/update.js';
import { Slip } from './screens/slips/Slip.jsx';
import { WeighList, Weigh } from './screens/weigh/Weigh.jsx';
import { Pickup } from './screens/pickup/Pickup.jsx';
import { Khata } from './screens/khata/Khata.jsx';
import { Customer } from './screens/khata/Customer.jsx';
import { Reminders } from './screens/khata/Reminders.jsx';
import { Rates } from './screens/admin/Rates.jsx';
import { People } from './screens/admin/People.jsx';
import { Settings } from './screens/admin/Settings.jsx';
import { Accounts } from './screens/admin/Accounts.jsx';
import { CloseDay } from './screens/CloseDay.jsx';
import { Praise } from './ui/easy/Praise.jsx';
import { Summary } from './screens/admin/Summary.jsx';
import { Guide } from './screens/Guide.jsx';
import { PublicDoc } from './screens/docs/PublicDoc.jsx';
import { Compare } from './screens/grades/Compare.jsx';
import { Evening } from './screens/evening/Evening.jsx';
import { EveningSettings } from './screens/evening/EveningSettings.jsx';
import { Expenses } from './screens/money/Expenses.jsx';
import { Balances, AccountBook } from './screens/money/Balances.jsx';
import { Suppliers } from './screens/stock/Suppliers.jsx';
import { Waiting } from './screens/Waiting.jsx';
import { OfflineBar } from './ui/OfflineBar.jsx';
import { FingerOffer } from './ui/FingerOffer.jsx';
import { toastMsg } from './ui/toast.js';
import { FULL_SCREEN } from './config/navigation.js';

// Which screen for which address. Add a screen: one line here (+ a menu entry in config/navigation.js).
// ":id" parts of the address are passed to the screen.
const SCREENS = {
  '/': () => <Today />,
  '/more': () => <More />,
  '/new': () => <NewOrder />,
  '/slips': () => <Slips />,
  '/slips/deleted': () => <DeletedSlips />,
  '/stock': () => <Stock />,
  '/stock/:id': ({ id }) => <StockItem id={id} key={id} />,
  '/purchases': () => <Purchases />,
  '/purchases/new': () => <PurchaseNew />,
  '/purchase/:id': ({ id }) => <Purchase id={id} key={id} />,
  '/slip/:id': ({ id }) => <Slip id={id} key={id} />,
  '/weigh': () => <WeighList />,
  '/weigh/:id': ({ id }) => <Weigh id={id} key={id} />,
  '/pickup/:id': ({ id }) => <Pickup id={id} key={id} />,
  '/khata': () => <Khata />,
  '/customer/:id': ({ id }) => <Customer id={id} key={id} />,
  '/reminders': () => <Reminders />,
  '/rates': () => <Rates />,
  '/people': () => <People />,
  '/settings': () => <Settings />,
  '/settings/accounts': () => <Accounts />,
  '/close-day': () => <CloseDay />,
  '/reports': () => <Summary />,
  '/guide': () => <Guide />,
  '/start': () => <Start />,
  '/compare': () => <Compare />,
  '/evening': () => <Evening />,
  '/evening/settings': () => <EveningSettings />,
  '/expenses': () => <Expenses />,
  '/money': () => <Balances />,
  '/money/:id': ({ id }) => <AccountBook id={id} key={id} />,
  '/suppliers': () => <Suppliers />,
  '/waiting': () => <Waiting />,
};
function match(path) {
  for (const [pattern, render] of Object.entries(SCREENS)) {
    const a = pattern.split('/'); const b = path.split('/');
    if (a.length !== b.length) continue;
    const params = {};
    if (a.every((seg, i) => (seg.startsWith(':') ? (params[seg.slice(1)] = decodeURIComponent(b[i]), true) : seg === b[i]))) return render(params);
  }
  return null;
}
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

// A customer's link (#/d/<token>) shows only that document — no login, and the app itself never starts.
let booted = false;
const isPublic = (path) => path.startsWith('/d/');

/** "New version ready · Update" — shown on every screen once the website has a newer version. */
function UpdateBar() {
  if (!updateReady.value) return null;
  return (
    <button class="update-bar" onClick={updateNow}>
      <Icon name="RefreshCw" size={18} stroke={2.4} /><span class="grow">{t('update_ready')}</span><b>{t('update_now')}</b>
    </button>
  );
}

export function App() {
  return <><UpdateBar /><Screens /></>;
}

function Screens() {
  const publicPath = isPublic(route.value.path);
  useEffect(() => { if (!publicPath && !booted) { booted = true; boot(); } }, [publicPath]);
  const step = auth.value.step;
  // A business that has just registered lands on "Your shop is ready!".
  useEffect(() => { if (step === 'ready' && auth.value.justRegistered) { auth.value = { ...auth.value, justRegistered: false }; go('/start'); } }, [step]);
  if (publicPath) return <PublicDoc token={decodeURIComponent(route.value.path.slice(3))} key={route.value.path} />;
  if (step === 'loading') return <div class="login" />;
  if (step === 'welcome') return <Welcome />;
  if (step === 'tour') return <Tour />;
  if (step === 'who') return <WhoStep />;
  if (step === 'register') return <Register />;
  if (step === 'joining') return <JoiningStep />;
  if (step === 'phone') return <PhoneStep />;
  if (step === 'code') return <CodeStep />;
  if (step === 'set_pin') return <SetPinStep />;
  const locked = step === 'unlock' && auth.value.autoLocked;   // locked because the person was away: their screen stays underneath
  if (step === 'unlock' && !locked) return <UnlockStep />;
  if (step === 'not_staff') return <NotStaffStep />;
  if (step === 'error') return <div class="login"><div class="login-body"><div class="error">{t('err_generic')}</div><button class="btn btn-ghost" onClick={boot}>{t('retry')}</button></div></div>;

  const path = route.value.path;
  const screen = match(path) || soonFor(path);
  const full = FULL_SCREEN.some((p) => path === p || path.startsWith(p));
  return (
    <>
      <div class="app" style={locked ? 'display:none' : undefined} aria-hidden={locked ? 'true' : undefined}>
        <Sidebar path={path} />
        <main class="main"><OfflineBar path={path} />{screen}</main>
        {!full && <TabBar path={path} />}
        {toastMsg.value && !locked && <div class="toast">{toastMsg.value}</div>}
        <Praise />
        {!locked && <FingerOffer />}
      </div>
      {locked && <UnlockStep />}
      {covered.value && <div class="lock-cover"><Icon name="Lock" size={34} stroke={2} /></div>}
    </>
  );
}
