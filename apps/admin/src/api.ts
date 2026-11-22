import { startAuthentication } from "@simplewebauthn/browser";

export class SignedOut extends Error {}
/** Admin API; transparently asks for the passkey again when a step-up is needed. */
export async function api<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const res = await fetch(`/api${path}`, { ...init, credentials: "same-origin", headers: { "content-type": "application/json", "x-haven": "1", ...init.headers } });
  if (res.status === 401) {
    const body = await res.json().catch(() => ({}));
    if (body.error === "passkey_required" && !retried) { await passkey(); return api(path, init, true); }
    throw new SignedOut();
  }
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? String(res.status));
  return res.json();
}

export async function passkey() {
  const r = await fetch("/api/passkey/options", { credentials: "same-origin" }).then((x) => x.json());
  const response = await startAuthentication({ optionsJSON: r.options });
  const v = await fetch("/api/passkey/verify", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-haven": "1" }, body: JSON.stringify({ response }) });
  if (!v.ok) throw new Error("passkey_failed");
}

export const when = (t: number) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(t);
export const day = (t: number) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(t);
