// Haven shell shared components (spec §2): sheet + confirm prompt.
// Modules import these; the shell never re-implements them. Batch 1.
// The sheet is a bottom sheet over a scrim; Esc or a scrim tap dismisses.

let activeSheet = null;

export function openSheet({ title, body, actions = [], onClose = null }) {
  closeSheet();
  const root = document.getElementById("sheet-root");
  const scrim = document.createElement("div");
  scrim.className = "sheet-scrim";
  const sheet = document.createElement("div");
  sheet.className = "sheet";
  sheet.setAttribute("role", "dialog");
  if (title) {
    const h = document.createElement("h2");
    h.textContent = title;
    sheet.appendChild(h);
  }
  if (body) {
    const bodyEl = document.createElement("div");
    if (typeof body === "string") bodyEl.innerHTML = body;
    else bodyEl.appendChild(body);
    sheet.appendChild(bodyEl);
  }
  const row = document.createElement("div");
  row.className = "sheet-actions";
  const close = () => closeSheet();
  for (const action of actions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn " + (action.kind === "primary" ? "btn-primary" : "btn-ghost");
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      // The action runs before the sheet closes: close() fires onClose,
      // and for confirmPrompt onClose settles false — if it ran first it
      // would swallow the action's own settle (the confirm button would
      // always resolve false and Leave would never happen).
      if (typeof action.onClick === "function") action.onClick();
      close();
    });
    row.appendChild(btn);
    if (action.kind === "primary") btn.focus();
  }
  sheet.appendChild(row);
  scrim.appendChild(sheet);
  root.appendChild(scrim);
  activeSheet = scrim;
  activeSheet._onKey = (event) => {
    if (event.key === "Escape") close();
  };
  activeSheet._onClose = onClose;
  scrim.addEventListener("click", (event) => {
    if (event.target === scrim) close();
  });
  document.addEventListener("keydown", activeSheet._onKey);
  return close;
}

export function closeSheet() {
  if (!activeSheet) return;
  const onClose = activeSheet._onClose;
  if (activeSheet._onKey) document.removeEventListener("keydown", activeSheet._onKey);
  activeSheet.remove();
  activeSheet = null;
  if (typeof onClose === "function") onClose();
}

// Confirm prompt built on the sheet: resolves true on confirm, false on
// cancel / Esc / scrim tap. Every swap and destructive action goes through
// this (e.g. Cook something else, spec §6).
export function confirmPrompt({ title, message, confirmLabel = "Confirm", cancelLabel = "Cancel" }) {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    openSheet({
      title,
      body: message ? `<p>${message}</p>` : "",
      actions: [
        { label: cancelLabel, kind: "ghost", onClick: () => settle(false) },
        { label: confirmLabel, kind: "primary", onClick: () => settle(true) },
      ],
      // Dismiss without a button (Esc / scrim) counts as cancel.
      onClose: () => settle(false),
    });
  });
}
