/**
 * Order stages and which moves between them are allowed (same as the prototype, plus cancelling,
 * plus deleting — 30 Sept 2026: an owner can delete a slip at any stage; it is kept, counted nowhere).
 */
export const STATUSES = Object.freeze(['estimate', 'accepted', 'weighed', 'done', 'cancelled', 'deleted']);

const NEXT = Object.freeze({
  estimate: ['accepted', 'deleted'],
  accepted: ['weighed', 'cancelled', 'deleted'],
  weighed: ['done', 'cancelled', 'deleted'],
  done: ['deleted'],
  cancelled: ['deleted'],
  deleted: [],
});

export const canTransition = (from, to) => (NEXT[from] || []).includes(to);

/** Items and customer can only be edited while it's still an estimate. */
export const isEditable = (status) => status === 'estimate';

/** An advance can be added once accepted and until finished. */
export const canAddAdvance = (status) => status === 'accepted' || status === 'weighed';

/**
 * An accepted or weighed order can be cancelled (an estimate is simply deleted).
 * Any advance on it must first be returned, moved to another order, or kept as credit.
 */
export const canCancel = (status) => status === 'accepted' || status === 'weighed';

/** Any slip that is not already deleted can be deleted (by someone with the 'delete' permission). */
export const canDelete = (status) => STATUSES.includes(status) && status !== 'deleted';

/** Weighing can be submitted only when every item has an actual weight. */
export const allWeighed = (order) => (order.items || []).every((it) => Number(it.aw) > 0);
