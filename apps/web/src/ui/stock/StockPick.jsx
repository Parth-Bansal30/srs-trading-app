// "Take from which stock?" — shows only stock of the item's grade (and shape), best first:
// oldest that has enough for this item. Used on a new order and on an open slip.
import { stockChoices } from '@srs/core';
import { t } from '../../lib/i18n.js';
import { company, can } from '../../lib/session.js';
import { money } from '../../lib/format.js';
import { stockName, stockLine, forChoices, kgTxt } from '../../lib/stock.js';
import { Icon, Chip } from '../kit.jsx';
import { Sheet } from '../Sheet.jsx';

/** The choices for one item: { list, pick, short } (see core stockChoices). */
export function choicesFor(stock, { materialId, shape, kg }) {
  if (!stock || !materialId) return { list: [], pick: null, short: false };
  return stockChoices(forChoices(stock.items), { materialId, shape, kg });
}

/** One line under an order item: "From stock: EN19 · Round · ₹75 · 1,820 kg free  [Change]". */
export function StockLine({ stock, value, need, sellRate, onOpen, readOnly }) {
  if (!stock || !need.materialId) return null;
  const ch = choicesFor(stock, need);
  const it = value ? stock.items.find((s) => s.id === value) : null;
  const tz = company.value?.timezone;
  if (!ch.list.length && !it) {
    return <div class="stockline tone-neutral"><Icon name="Boxes" size={16} /><span class="grow">{t('pick_no_stock', stock.materials.find((m) => m.id === need.materialId)?.code || '')}</span></div>;
  }
  const c = it && ch.list.find((x) => x.id === it.id);
  const short = c && need.kg > 0 && c.free < need.kg;
  const margin = it && it.cost != null && sellRate != null ? Math.round((Number(sellRate) - Number(it.cost)) * 100) / 100 : null;
  return (
    <button class={`stockline ${!it ? 'tone-warn' : short ? 'tone-warn' : 'tone-ok'}`} onClick={readOnly ? undefined : onOpen} disabled={readOnly}>
      <Icon name="Boxes" size={16} />
      <span class="grow">
        {it ? <><b>{t('pick_from')}: {stockName(it)}</b>{it.rate != null ? ` · ${money(it.rate)}` : ''} · {t('st_free', kgTxt(c ? c.free : it.on_hand))}
          {short && <><br />{t('pick_short', kgTxt(c.free))}</>}
          {margin != null && can('stock') && <><br /><span style={margin < 0 ? 'color:var(--bad);font-weight:700' : ''}>{margin >= 0 ? t('pick_over', money(margin)) : t('pick_under', money(-margin))}</span></>}
        </> : <b>{t('pick_none')}</b>}
      </span>
      {!readOnly && <span class="link" style="min-height:0">{t('pick_change')}</span>}
    </button>
  );
}

/** The sheet with every matching stock. onPick(id | null). */
export function StockPick({ open, stock, need, value, onClose, onPick }) {
  const tz = company.value?.timezone;
  const ch = choicesFor(stock, need);
  return (
    <Sheet open={open} onClose={onClose} title={t('pick_title')}>
      <div class="card">
        {ch.list.map((s) => (
          <button class={`li ${value === s.id ? 'picked' : ''}`} onClick={() => onPick(s.id)}>
            <div class={`radio ${value === s.id ? 'on' : ''}`} />
            <div class="grow">
              <div class="row" style="gap:6px;flex-wrap:wrap"><span class="t">{s.rate != null ? t('st_bought_at', money(s.rate)) : stockName(s)}</span>
                {s.id === ch.pick && <Chip tone="accent">{ch.short ? t('pick_best') : t('pick_oldest')}</Chip>}</div>
              <div class="s">{stockLine(s, tz, { rate: false })}</div>
              {s.booked > 0 && <div class="s">{t('st_booked', kgTxt(s.booked))}</div>}
            </div>
            <div style="text-align:right"><b class={`num ${s.free <= 0 ? 'bad' : ''}`}>{kgTxt(s.free)}</b><div class="s">{t('st_free', '')}</div></div>
          </button>
        ))}
        <button class={`li ${value === null ? 'picked' : ''}`} onClick={() => onPick(null)}>
          <div class={`radio ${value === null ? 'on' : ''}`} />
          <div class="grow"><div class="t">{t('pick_none')}</div><div class="s">{t('pick_none_s')}</div></div>
        </button>
      </div>
      <div class="faint" style="font-size:13px;font-weight:600;margin-top:10px">{t('pick_weighed_note')}</div>
    </Sheet>
  );
}
