/** All writes send X-Haven: 1 (anti-forgery, Technical spec › Sign-in). */
export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { "content-type": "application/json", "x-haven": "1", "x-haven-tz": Intl.DateTimeFormat().resolvedOptions().timeZone, ...init.headers },
  });
  if (res.status === 401) throw new SignedOut();
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json() as Promise<T>;
}
export class SignedOut extends Error {}
