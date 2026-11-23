import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { Button, Field } from "@haven/ui";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

/** Admin sign-in: Google, then passkey; first time also asks for the setup code (PRD › Admin › Getting in). */
export function SignIn() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [mode, setMode] = useState<"google" | "authenticate" | "setup" | "code">("google");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (params.get("step") !== "passkey") return;
    fetch("/api/passkey/options", { credentials: "same-origin" }).then((r) => (r.ok ? r.json() : null)).then((r) => r && setMode(r.mode === "setup" ? "setup" : "authenticate"));
  }, [params]);

  async function go() {
    setBusy(true); setError(undefined);
    try {
      const r = await fetch("/api/passkey/options", { credentials: "same-origin" }).then((x) => x.json());
      if (mode === "setup") {
        const response = await startRegistration({ optionsJSON: r.options });
        const v = await fetch("/api/passkey/register", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-haven": "1" }, body: JSON.stringify({ setupCode: code.trim(), response, name: deviceName() }) });
        if (!v.ok) throw new Error((await v.json()).error);
      } else {
        const response = await startAuthentication({ optionsJSON: r.options });
        const v = await fetch("/api/passkey/verify", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json", "x-haven": "1" }, body: JSON.stringify({ response }) });
        if (!v.ok) throw new Error("not_verified");
      }
      nav("/feedback", { replace: true }); location.reload();
    } catch (e) {
      setError(e instanceof Error && e.message === "bad_setup_code" ? "That setup code isn’t right, or it has already been used." : "The passkey didn’t work. Try again.");
      setBusy(false);
    }
  }

  async function signInWithCode() {
    setBusy(true); setError(undefined);
    try {
      const v = await fetch("/auth/code", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: code.trim() }) });
      if (!v.ok) throw new Error((await v.json()).error);
      nav("/sign-in?step=passkey", { replace: true });
    } catch (e) {
      setError(e instanceof Error && e.message === "too_many" ? "Too many attempts. Wait an hour." : "That code isn’t right, or it has expired or already been used.");
      setBusy(false);
    }
  }

  return (
    <main className="signin">
      <div className="h-card h-stack" style={{ padding: 28, gap: 16, maxWidth: 420, width: "100%" }}>
        <div className="spread" style={{ justifyContent: "flex-start", gap: 10 }}><img src="/icon-192-maskable.png" alt="" width={40} height={40} style={{ borderRadius: 10 }} /><span><strong>Haven</strong><br /><span className="admin-badge">Admin</span></span></div>
        {params.get("error") && <p className="error" role="alert">{params.get("error") === "too_many" ? "Too many sign-in attempts. Wait an hour." : "Sign-in didn’t finish. Try again."}</p>}
        {mode === "google" && (<><h1>Sign in to admin</h1><p className="muted">Use the Google account set as the Haven admin. You’ll confirm with your passkey next.</p>
          <a className="h-btn h-btn--secondary" href="/auth/google">Continue with Google</a>
          <Button variant="text" onClick={() => setMode("code")}>Use a sign-in code instead</Button></>)}
        {mode === "code" && (<><h1>Sign in with a code</h1><p className="muted">Enter the one-time code from Account › Sign in on another device. It works once and expires in 10 minutes — you’ll still confirm with your passkey next.</p>
          <Field label="Sign-in code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" placeholder="XXXX-XXXX" error={error} />
          <Button loading={busy} disabled={!code.trim()} onClick={signInWithCode}>Sign in with code</Button>
          <Button variant="text" onClick={() => setMode("google")}>Back to Google sign-in</Button></>)}
        {mode === "authenticate" && (<><h1>Confirm it’s you</h1><p className="muted">Use your passkey (Face ID, fingerprint or security key) to open admin.</p>
          <Button loading={busy} onClick={go}>Use passkey</Button>{error && <p className="error">{error}</p>}
          <span className="muted" style={{ fontSize: 12 }}>Lost your passkey? Set a new ADMIN_SETUP_CODE secret to register a new one.</span></>)}
        {mode === "setup" && (<><h1>Set up admin</h1><p className="muted">First sign-in. Enter the setup code you stored as a Worker secret, then create a passkey on this device. The code stops working once it’s used.</p>
          <Field label="Setup code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" error={error} />
          <Button loading={busy} disabled={!code.trim()} onClick={go}>Create passkey</Button>
          <span className="muted" style={{ fontSize: 12 }}>Tip: add a second passkey later (More › Account) so losing one device doesn’t lock you out.</span></>)}
      </div>
    </main>
  );
}

export function Denied() {
  const email = new URLSearchParams(location.search).get("email");
  return (
    <main className="signin"><div className="h-card h-stack" style={{ padding: 28, maxWidth: 440 }}>
      <h1>This account isn’t the Haven admin</h1>
      <p className="muted">You signed in with Google as {email ?? "another account"}. Only the Haven admin account can use this site, so nothing was opened or changed.</p>
      <a className="h-btn h-btn--secondary" href="/sign-in">Use a different account</a>
    </div></main>
  );
}

export const deviceName = () => (/iPhone/.test(navigator.userAgent) ? "iPhone" : /Android/.test(navigator.userAgent) ? "Android" : /Mac/.test(navigator.userAgent) ? "Mac" : /Windows/.test(navigator.userAgent) ? "Windows PC" : "Passkey");
