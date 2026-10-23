// ─────────────────────────────────────────────────────────────────────────────
// CHOICES SHOWN IN THE APP — payment methods, bill types, order stages, shapes.
// Change the word key, icon or colour (tone) here; the maths lives in @srs/core.
// ─────────────────────────────────────────────────────────────────────────────
export const PAY_METHODS = [
  { id: 'Cash', word: 'pm_cash', icon: 'Banknote' },
  { id: 'UPI', word: 'pm_upi', icon: 'Smartphone' },
  { id: 'Bank', word: 'pm_bank', icon: 'Landmark' },
  { id: 'Cheque', word: 'pm_cheque', icon: 'FileText' },
];

// Money accounts (Settings → Payment accounts). The cash drawer is always there; the rest the shop adds.
export const ACCOUNT_KINDS = [
  { id: 'bank', word: 'acc_k_bank', icon: 'Landmark', tone: '#2F5FD0' },
  { id: 'upi', word: 'acc_k_upi', icon: 'Smartphone', tone: '#6B4FD8' },
  { id: 'paytm', word: 'acc_k_paytm', icon: 'Smartphone', tone: '#0BA5E9' },
  { id: 'wallet', word: 'acc_k_wallet', icon: 'Wallet', tone: '#C2410C' },
  { id: 'safe', word: 'acc_k_safe', icon: 'Vault', tone: '#7A5A1F' },
  { id: 'other', word: 'acc_k_other', icon: 'CircleDashed', tone: '#5B6472' },
];
export const ACCOUNT_DRAWER = { id: 'cash', word: 'acc_k_cash', icon: 'Banknote', tone: '#1F8A5B' };
// Shop expenses (kharcha), 23 Oct 2026. The id is saved with each expense — never change an id, only its word,
// icon or colour; add new ones at the end of the list. Anything not in the list shows as "Other".
export const EXPENSE_CATEGORIES = [
  { id: 'tea', word: 'ec_tea', icon: 'Coffee', tone: '#9A5B0E' },
  { id: 'labour', word: 'ec_labour', icon: 'HardHat', tone: '#C2410C' },
  { id: 'freight', word: 'ec_freight', icon: 'Truck', tone: '#2F5FD0' },
  { id: 'blade', word: 'ec_blade', icon: 'Cog', tone: '#5B6472' },
  { id: 'fuel', word: 'ec_fuel', icon: 'Fuel', tone: '#B0413E' },
  { id: 'salary', word: 'ec_salary', icon: 'Users', tone: '#1C8456' },
  { id: 'repair', word: 'ec_repair', icon: 'Wrench', tone: '#6B4FA0' },
  { id: 'electricity', word: 'ec_electricity', icon: 'Zap', tone: '#B7791F' },
  { id: 'rent', word: 'ec_rent', icon: 'Building', tone: '#2F7F86' },
  { id: 'phone', word: 'ec_phone', icon: 'Smartphone', tone: '#6B4FD8' },
  { id: 'office', word: 'ec_office', icon: 'Printer', tone: '#475569' },
  { id: 'bank', word: 'ec_bank', icon: 'Landmark', tone: '#1E40AF' },
  { id: 'tax', word: 'ec_tax', icon: 'FileText', tone: '#7C2D12' },
  { id: 'puja', word: 'ec_puja', icon: 'Flame', tone: '#D97706' },
  { id: 'other', word: 'ec_other', icon: 'CircleEllipsis', tone: '#5B6472' },
];
export const EXPENSE_SPECIAL = {           // the two kinds that are not shop running costs
  supplier: { word: 'ec_supplier', icon: 'PackagePlus', tone: '#0F766E' },
  home: { word: 'ec_home', icon: 'House', tone: '#9D174D' },
};
/** How money reached a bank account ("Bank" for RTGS / IMPS / NEFT). */
export const BANK_METHODS = ['UPI', 'IMPS', 'NEFT', 'RTGS', 'Cheque'];

export const BILLS = {
  pakka: { word: 'bill_gst_short', tone: 'pakka' },
  kacha: { word: 'bill_none_short', tone: 'kacha' },
};

export const STAGES = {                    // order status → label + chip colour
  estimate: { word: 'st_estimate', tone: 'neutral' },
  accepted: { word: 'st_accepted', tone: 'warn' },
  weighed: { word: 'st_weighed', tone: 'ok' },
  done: { word: 'st_done', tone: 'neutral' },
  cancelled: { word: 'st_cancelled', tone: 'bad' },
  deleted: { word: 'st_deleted', tone: 'bad' },
};

export const SHAPE_LOOK = {                // picture + word for each shape (sizes/maths come from @srs/core)
  round: { word: 'sh_round', icon: 'Circle' },
  square: { word: 'sh_square', icon: 'Square' },
  flat: { word: 'sh_flat', icon: 'RectangleHorizontal' },
  block: { word: 'sh_block', icon: 'Box' },
  hex: { word: 'sh_hex', icon: 'Hexagon' },
  plate: { word: 'sh_plate', icon: 'Layers' },
};

// ─────────────────────────────────────────────────────────────────────────────
// FRONT DOOR (registering a new business)
// ─────────────────────────────────────────────────────────────────────────────
// What a business can sell. `ready: true` = can be set up today (starting grades come from the server).
export const TRADES = [
  { id: 'steel', icon: 'Cylinder', word: 'trade_steel', sub: 'trade_steel_s', ready: true },
  { id: 'pipes', icon: 'Donut', word: 'trade_pipes' },
  { id: 'nonferrous', icon: 'Layers', word: 'trade_nonferrous' },
  { id: 'hardware', icon: 'Hammer', word: 'trade_hardware' },
  { id: 'plywood', icon: 'Trees', word: 'trade_plywood' },
  { id: 'tiles', icon: 'Grid2x2', word: 'trade_tiles' },
  { id: 'cables', icon: 'Cable', word: 'trade_cables' },
  { id: 'other', icon: 'Package', word: 'trade_other' },
];

// Plans shown at the free-trial step. Prices are EXAMPLES until the owner decides them;
// no payment is taken in this version.
export const PLANS = [
  { id: 'starter', word: 'plan_starter', sub: 'plan_starter_s', year: 3999, month: 399 },
  { id: 'business', word: 'plan_business', sub: 'plan_business_s', year: 7999, month: 799, best: true },
  { id: 'multi', word: 'plan_multi', sub: 'plan_multi_s', year: 14999, month: 1499 },
];
export const TRIAL_DAYS = 30;

// Roles offered when adding a team member (permissions come from the server's presets).
export const TEAM_ROLES = [
  { id: 'sales', word: 'role_sales', sub: 'role_s_sales', icon: 'ReceiptText' },
  { id: 'weigher', word: 'role_weigher', sub: 'role_s_weigher', icon: 'Scale' },
  { id: 'accounts', word: 'role_accounts', sub: 'role_s_accounts', icon: 'IndianRupee' },
  { id: 'owner', word: 'role_owner', sub: 'role_s_owner', icon: 'Crown' },
];

// Colour of the round name badge on "Who is using?" (picked from the name, always the same for a person).
export const AVATAR_COLOURS = ['#8A5A2B', '#1B2130', '#2C5CC5', '#1C8456', '#9A5B0E', '#6B4FA0', '#B0413E', '#2F7F86'];
