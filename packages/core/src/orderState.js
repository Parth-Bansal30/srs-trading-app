/** Order stages and which moves between them are allowed (same as the prototype, plus cancelling). */
export const STATUSES = Object.freeze(['estimate', 'accepted', 'weighed', 'done', 'cancelled']);

const NEXT = Object.freeze({
  estimate: ['accepted'],
  accepted: ['weighed', 'cancelled'],
  weighed: ['done', 'cancelled'],
  done: [],
  cancelled: [],
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

/** Weighing can be submitted only when every item has an actual weight. */
export const allWeighed = (order) => (order.items || []).every((it) => Number(it.aw) > 0);
