import type { ShoppingList } from "./data";

/**
 * How the shopping list has been dealt with: every item counts. "Have it" is dealt
 * with too, so a list can be "All done" without everything in the cart.
 */
export interface Progress { total: number; inCart: number; have: number; cannot: number; left: number }

export function progressOf(list: ShoppingList): Progress {
  let inCart = 0, have = 0, cannot = 0, left = 0;
  for (const r of list.rows) {
    if (r.state.kind === "inCart") inCart++;
    else if (r.state.kind === "haveIt") have++;
    else if (r.state.kind === "unavailable") cannot++;
    else left++;                                   // todo, or bought too little ("+X more")
  }
  for (const e of list.extras) {
    if (e.checked) inCart++;
    else if (e.unavailable) cannot++;
    else left++;
  }
  return { total: list.rows.length + list.extras.length, inCart, have, cannot, left };
}

/** Section counter, worded like the header: "2 left", or "All done". Shared by Shopping and the Plan panel so both count the same way. */
export function sectionCount(left: number, cannot: number) {
  return left ? `${left} left` : cannot ? `${cannot} couldn’t get` : "All done";
}

export function progressText(p: Progress) {
  if (!p.total) return "Nothing to buy yet";
  return [p.left ? `${p.left} left` : "All done", p.inCart && `${p.inCart} bought`, p.have && `${p.have} have it`, p.cannot && `${p.cannot} couldn’t get`]
    .filter(Boolean).join(" · ");
}

/** Segmented bar: bought (green), have it (grey); the empty track is what's left. */
export function ListProgress({ p, strong }: { p: Progress; strong?: boolean }) {
  const w = (n: number) => `${p.total ? (n / p.total) * 100 : 0}%`;
  const text = progressText(p);
  return (
    <div className="list-progress">
      <span className="seg-bar" aria-hidden="true">
        <span className="seg seg--cart" style={{ width: w(p.inCart) }} />
        <span className="seg seg--have" style={{ width: w(p.have) }} />
        <span className="seg seg--cannot" style={{ width: w(p.cannot) }} />
      </span>
      <span className={`list-progress__text${!p.left && p.total ? " list-progress__text--done" : ""}`}>{strong ? <strong>{text}</strong> : text}</span>
    </div>
  );
}
