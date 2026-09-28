// ─────────────────────────────────────────────────────────────────────────────
// WHERE THINGS ARE — bottom bar (phone), menu (laptop), the "More" list, and the
// "Needs you now" cards on Today. Reorder, rename (word key) or hide items here.
// perm = who can see it (see the People screen). icon = name from lucide icons.
// ─────────────────────────────────────────────────────────────────────────────
export const TABS = [                      // phone bottom bar: 4 tabs + the big + in the middle
  { id: 'today', route: '/', word: 'nav_today', icon: 'House' },
  { id: 'slips', route: '/slips', word: 'nav_slips', icon: 'ReceiptText', perm: 'orders' },
  { id: 'new', route: '/new', word: 'nav_new', icon: 'Plus', perm: 'new', big: true },
  { id: 'khata', route: '/khata', word: 'nav_khata', icon: 'BookOpenText', perm: 'khata' },
  { id: 'more', route: '/more', word: 'nav_more', icon: 'LayoutGrid' },
];

export const MENU = [                      // laptop left menu + the "More" screen
  { id: 'today', route: '/', word: 'nav_today', icon: 'LayoutDashboard' },
  { id: 'slips', route: '/slips', word: 'nav_slips', icon: 'ReceiptText', perm: 'orders' },
  { id: 'weigh', route: '/weigh', word: 'nav_weigh', icon: 'Scale', perm: 'weigh', badge: 'toWeigh' },
  { id: 'khata', route: '/khata', word: 'nav_khata', icon: 'BookOpenText', perm: 'khata' },
  { id: 'reminders', route: '/reminders', word: 'nav_reminders', icon: 'BellRing', perm: 'khata', badge: 'reminders' },
  { id: 'rates', route: '/rates', word: 'nav_rates', icon: 'Tag', perm: 'rates' },
  { id: 'people', route: '/people', word: 'nav_people', icon: 'Users', perm: 'people' },
  { id: 'reports', route: '/reports', word: 'tile_today', icon: 'ChartColumn', perm: 'money' },
  { id: 'evening', route: '/evening', word: 'nav_evening', icon: 'Moon', perm: 'money' },
  { id: 'guide', route: '/guide', word: 'nav_guide', icon: 'Sparkles' },
  { id: 'settings', route: '/settings', word: 'nav_settings', icon: 'Settings', perm: 'settings' },
];

// Today → "Needs you now". Each card shows only if the person has the permission and count > 0.
export const NEEDS = [
  { id: 'weigh', count: 'toWeigh', word: 'need_weigh', one: 'need_weigh_1', icon: 'Scale', tone: 'accent', route: '/weigh', perm: 'weigh' },
  { id: 'pickup', count: 'readyForPickup', word: 'need_pickup', icon: 'PackageCheck', tone: 'ok', route: '/slips?stage=weighed', perm: 'money' },
  { id: 'remind', count: 'reminders', word: 'need_remind', icon: 'BellRing', tone: 'bad', route: '/reminders', perm: 'khata' },
  { id: 'estimates', count: 'estimates', word: 'need_estimates', icon: 'FileClock', tone: 'neutral', route: '/slips?stage=estimate', perm: 'new' },
];

// Screens that use the whole screen (their own bottom buttons), so the bottom bar hides.
export const FULL_SCREEN = ['/new', '/pickup/', '/weigh/', '/start'];
