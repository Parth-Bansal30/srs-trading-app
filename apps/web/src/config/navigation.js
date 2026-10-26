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
  { id: 'stock', route: '/stock', word: 'nav_stock', icon: 'Boxes', perm: 'orders' },
  { id: 'purchases', route: '/purchases', word: 'nav_purchases', icon: 'Truck', perm: 'stock' },
  { id: 'suppliers', route: '/suppliers', word: 'nav_suppliers', icon: 'ShieldCheck', perm: 'stock' },
  { id: 'expenses', route: '/expenses', word: 'nav_expenses', icon: 'Receipt', perm: 'expenses' },
  { id: 'money', route: '/money', word: 'nav_money', icon: 'Wallet', perm: 'settings' },
  { id: 'reminders', route: '/reminders', word: 'nav_reminders', icon: 'BellRing', perm: 'khata', badge: 'reminders' },
  { id: 'rates', route: '/rates', word: 'nav_rates', icon: 'Tag', perm: 'rates' },
  { id: 'people', route: '/people', word: 'nav_people', icon: 'Users', perm: 'people' },
  { id: 'reports', route: '/reports', word: 'tile_today', icon: 'ChartColumn', perm: 'money' },
  { id: 'evening', route: '/evening', word: 'nav_evening', icon: 'Moon', perm: 'money' },
  { id: 'close', route: '/close-day', word: 'close_title', icon: 'ClipboardCheck', perm: 'today' },
  { id: 'deleted', route: '/slips/deleted', word: 'nav_deleted', icon: 'Trash2', perm: 'delete' },
  { id: 'guide', route: '/guide', word: 'nav_guide', icon: 'Sparkles' },
  { id: 'settings', route: '/settings', word: 'nav_settings', icon: 'Settings', perm: 'settings' },
];

// The big + in the middle (25 Oct 2026): "What do you want to add?" — everything that adds something, in this order.
// Only what the person may do is shown; if that is just one thing, + goes straight there. Press and hold + = new order.
// route = open that screen · pick = choose a customer first, then their account opens with that sheet.
export const ADD = [
  { id: 'order', word: 'add_order', hint: 'add_order_s', icon: 'ReceiptText', tone: 'accent', route: '/new', perm: 'new', big: true },
  { id: 'pay', word: 'add_pay', hint: 'add_pay_s', icon: 'IndianRupee', tone: 'ok', pick: 'pay', perm: ['money', 'khata'] },
  { id: 'expense', word: 'add_expense', hint: 'add_expense_s', icon: 'Receipt', tone: 'bad', route: '/expenses?add=1', perm: 'expenses' },
  { id: 'purchase', word: 'add_purchase', hint: 'add_purchase_s', icon: 'Truck', tone: 'neutral', route: '/purchases/new', perm: 'stock' },
  { id: 'move', word: 'add_move', hint: 'add_move_s', icon: 'ArrowRightLeft', tone: 'neutral', route: '/expenses?move=1', perm: 'expenses' },
  { id: 'customer', word: 'add_customer', hint: 'add_customer_s', icon: 'UserPlus', tone: 'neutral', route: '/khata?add=1', perm: 'new' },
  { id: 'giveback', word: 'add_giveback', hint: 'add_giveback_s', icon: 'Undo2', tone: 'warn', pick: 'giveback', perm: 'delete' },
  { id: 'count', word: 'add_count', hint: 'add_count_s', icon: 'ClipboardCheck', tone: 'neutral', route: '/close-day', perm: 'today' },
];

// Today → "Needs you now". Each card shows only if the person has the permission and count > 0.
export const NEEDS = [
  { id: 'weigh', count: 'toWeigh', word: 'need_weigh', one: 'need_weigh_1', icon: 'Scale', tone: 'accent', route: '/weigh', perm: 'weigh' },
  { id: 'pickup', count: 'readyForPickup', word: 'need_pickup', icon: 'PackageCheck', tone: 'ok', route: '/slips?stage=weighed', perm: 'money' },
  { id: 'remind', count: 'reminders', word: 'need_remind', icon: 'BellRing', tone: 'bad', route: '/reminders', perm: 'khata' },
  { id: 'estimates', count: 'estimates', word: 'need_estimates', icon: 'FileClock', tone: 'neutral', route: '/slips?stage=estimate', perm: 'new' },
];

// Screens that use the whole screen (their own bottom buttons), so the bottom bar hides.
export const FULL_SCREEN = ['/new', '/pickup/', '/weigh/', '/start', '/purchases/new'];
