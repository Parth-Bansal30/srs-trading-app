/** What a person can do. Same flags and role presets as the prototype. */
export const PERMS = Object.freeze(['new', 'orders', 'weigh', 'khata', 'today', 'rates', 'people', 'settings', 'money', 'kacha']);

const allOn = () => Object.fromEntries(PERMS.map((p) => [p, true]));

export const ROLE_PRESETS = Object.freeze({
  owner: allOn,
  sales: () => ({ new: 1, orders: 1, money: 1, kacha: 1 }),
  weigher: () => ({ weigh: 1, orders: 1 }),
  accounts: () => ({ orders: 1, khata: 1, today: 1, money: 1 }),
});

export const can = (perms, p) => !!(perms && perms[p]);

/** Bill sides a person may see: kacha only with the 'kacha' permission. */
export const visibleSides = (perms) => (can(perms, 'kacha') ? ['pakka', 'kacha'] : ['pakka']);
