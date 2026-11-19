// Kitchen module client chunk — Batch 1: module contract only.
// Recipes, Plan, Today, Shop and Pantry land in Batches 3–4. The widget
// returns null until then: no Kitchen data, so no widget (spec §4 — an
// empty widget renders nothing).
export const description = "Plan the week’s meals and the shopping that follows.";

export async function widget() {
  return null;
}

export function mount(el) {
  el.innerHTML = `<div class="empty-state"><h2>Kitchen</h2>`
    + `<p>Recipes, Plan, Today, Shop and Pantry arrive in Batch 3.</p></div>`;
}
