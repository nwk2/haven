import type { listFor } from "./data";

/**
 * How a run's list has been dealt with (decision, Nov 2026): every item counts. "Have it" and
 * "Couldn't get" are dealt with too, so a list can be "All done" without everything in the cart.
 */
export interface Progress { total: number; inCart: number; have: number; cannot: number; left: number }

export function progressOf(list: ReturnType<typeof listFor>): Progress {
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

/** Section counter, worded like the header: "2 left", "1 couldn’t get", or "All done". Shared by Shopping and the Plan panel so both count the same way. */
export function sectionCount(left: number, cannot: number) {
  return left ? `${left} left` : cannot ? `${cannot} couldn’t get` : "All done";
}

export function progressText(p: Progress) {
  if (!p.total) return "Nothing to buy yet";
  return [p.left ? `${p.left} left` : "All done", p.inCart && `${p.inCart} in cart`, p.have && `${p.have} have it`, p.cannot && `${p.cannot} couldn’t get`]
    .filter(Boolean).join(" · ");
}

/** Segmented bar: in cart (green), have it (grey), couldn't get (orange); the empty track is what's left. */
export function RunProgress({ p, strong }: { p: Progress; strong?: boolean }) {
  const w = (n: number) => `${p.total ? (n / p.total) * 100 : 0}%`;
  const text = progressText(p);
  return (
    <div className="run-progress">
      <span className="seg-bar" aria-hidden="true">
        <span className="seg seg--cart" style={{ width: w(p.inCart) }} />
        <span className="seg seg--have" style={{ width: w(p.have) }} />
        <span className="seg seg--cannot" style={{ width: w(p.cannot) }} />
      </span>
      <span className={`run-progress__text${!p.left && p.total ? " run-progress__text--done" : ""}`}>{strong ? <strong>{text}</strong> : text}</span>
    </div>
  );
}
