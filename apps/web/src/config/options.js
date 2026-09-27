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
};

export const SHAPE_LOOK = {                // picture + word for each shape (sizes/maths come from @srs/core)
  round: { word: 'sh_round', icon: 'Circle' },
  square: { word: 'sh_square', icon: 'Square' },
  flat: { word: 'sh_flat', icon: 'RectangleHorizontal' },
  block: { word: 'sh_block', icon: 'Box' },
  hex: { word: 'sh_hex', icon: 'Hexagon' },
  plate: { word: 'sh_plate', icon: 'Layers' },
};
