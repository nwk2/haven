// Throwaway module for the Batch 1 acceptance test (spec §13): it proves a
// module can register — tile + widget — with zero shell-code changes.
// Removed after verification; it never ships.
export const description = "Throwaway contract test — tile and widget, no shell changes.";

export async function widget() {
  return {
    title: "Test widget",
    body: "The throwaway test module registered and rendered its widget.",
    href: "/test/",
  };
}

export function mount(el) {
  el.innerHTML = `<div class="empty-state"><h2>Test module</h2>`
    + `<p>Throwaway Batch 1 acceptance-test module. Removed after verification.</p></div>`;
}
