import { Button, Dialog, Field, Icon, Segmented, Stepper, Switch } from "@haven/ui";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api } from "../api";
import { BackHeader } from "../components/ModuleHeader";
import { useSession } from "../session";
import { InviteRow } from "../components/InviteRow";

interface Member { id: string; name: string; photo_url: string | null; role: "owner" | "member"; joined_at: number }
type DialogKind = null | "rename" | "timezone" | "week" | "units" | "servings" | "remove" | "transfer" | "leave" | "delete" | "signoutAll" | "deleteAccount" | "modules";

export function Settings() {
  const { me, refresh, signOut } = useSession();
  const nav = useNavigate();
  const [members, setMembers] = useState<Member[]>([]);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [target, setTarget] = useState<Member | null>(null);
  const [text, setText] = useState("");
  const [num, setNum] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => { api<{ members: Member[] }>("/api/members").then((r) => setMembers(r.members)).catch(() => undefined); }, [me?.household?.id]);
  if (!me?.household) return null;
  const h = me.household;
  const owner = me.user.role === "owner";
  const others = members.filter((m) => m.id !== me.user.id);
  const close = () => { setDialog(null); setError(undefined); setBusy(false); };

  async function run(fn: () => Promise<unknown>, after?: () => void) {
    setBusy(true); setError(undefined);
    try { await fn(); await refresh(); const r = await api<{ members: Member[] }>("/api/members").catch(() => null); if (r) setMembers(r.members); close(); after?.(); }
    catch (e) { setError(e instanceof Error && e.message.includes("409") ? "Transfer ownership to another member first." : "That didn’t work. Check your connection and try again."); setBusy(false); }
  }
  const patch = (body: object) => run(() => api("/api/household", { method: "PATCH", body: JSON.stringify(body) }));
  const open = (d: DialogKind, preset?: { text?: string; num?: number; member?: Member }) => { setText(preset?.text ?? ""); setNum(preset?.num ?? 2); setTarget(preset?.member ?? null); setDialog(d); };
  const row = (label: string, sub: string, onClick: () => void, opts: { danger?: boolean; ownerOnly?: boolean } = {}) =>
    (!opts.ownerOnly || owner) && (
      <button type="button" className={`h-row settings-row${opts.danger ? " danger" : ""}`} onClick={onClick}>
        <span className="h-row__main"><span className="h-row__title">{label}</span>{sub && <span className="h-row__sub">{sub}</span>}</span>
        {!opts.danger && Icon.chevron}
      </button>
    );

  return (<>
    <BackHeader title="Settings" back="/" />
    <main className="page h-stack" style={{ gap: 22, paddingBottom: 40 }}>
      <section className="h-stack" aria-labelledby="acc">
        <h2 id="acc" className="h-section-title">Account</h2>
        <div className="h-row"><span className="avatar" aria-hidden="true">{me.user.name[0]}</span>
          <span className="h-row__main"><span className="h-row__title">{me.user.name}</span><span className="h-row__sub">{me.user.email}</span></span><span className="h-badge badge--neutral">Google</span></div>
        <a className="h-row settings-row" href="/api/export" download><span className="h-row__main"><span className="h-row__title">Export my data</span><span className="h-row__sub">Your profile and {h.name}’s recipes, plans and lists</span></span></a>
        {row("Delete my account", "Removes you and your profile for good", () => open("deleteAccount"), { danger: true })}
      </section>

      <section className="h-stack" aria-labelledby="hh">
        <h2 id="hh" className="h-section-title">Household · {h.name}</h2>
        {members.map((m) => (
          <div key={m.id} className="h-row">
            <span className="avatar" aria-hidden="true">{m.name[0]}</span>
            <span className="h-row__main"><span className="h-row__title">{m.name}{m.id === me.user.id ? " (you)" : ""}</span><span className="h-row__sub">{m.role === "owner" ? "Owner" : "Member"}</span></span>
            {owner && m.id !== me.user.id && <Button variant="secondary" onClick={() => open("remove", { member: m })}>Remove</Button>}
          </div>
        ))}
        <InviteRow owner={owner} />
        {row("Rename household", h.name, () => open("rename", { text: h.name }), { ownerOnly: true })}
        {row("Time zone", `${h.timezone} · decides “today” for everyone`, () => open("timezone", { text: h.timezone }), { ownerOnly: true })}
        {row("Week starts on", { mon: "Monday", sun: "Sunday", sat: "Saturday" }[h.week_start], () => open("week", { text: h.week_start }), { ownerOnly: true })}
        {row("Measurements", h.measurement === "metric" ? "Metric (g, kg, ml, l)" : "US customary (oz, lb, cups)", () => open("units", { text: h.measurement }), { ownerOnly: true })}
      </section>

      <section className="h-stack" aria-labelledby="mod">
        <h2 id="mod" className="h-section-title">Modules</h2>
        <div className="h-row"><span className="h-row__main"><span className="h-row__title">Meals &amp; Groceries</span><span className="h-row__sub">On for everyone in {h.name}</span></span>
          {owner && <Switch label="Meals and Groceries module" checked={h.enabled_modules.includes("meals")} onChange={() => open("modules")} />}</div>
        {row("Usual servings", h.default_servings ? `New meals start at ${h.default_servings}` : "New meals use each recipe’s servings", () => open("servings", { num: h.default_servings ?? 2 }), { ownerOnly: true })}
      </section>

      <section className="h-stack" aria-labelledby="app">
        <h2 id="app" className="h-section-title">Appearance and app</h2>
        <Link className="h-row settings-row" to="/settings/appearance"><span className="h-row__main"><span className="h-row__title">Appearance</span><span className="h-row__sub">{{ market: "Market Green", tomato: "Tomato & Ink", night: "Night Utility" }[me.user.theme]} · {me.user.mode === "system" ? "follows your device" : me.user.mode}</span></span>{Icon.chevron}</Link>
        {!matchMedia("(display-mode: standalone)").matches && <Link className="h-row settings-row" to="/install"><span className="h-row__main"><span className="h-row__title">Install Haven on this device</span><span className="h-row__sub">Full screen, works offline</span></span>{Icon.chevron}</Link>}
        <Link className="h-row settings-row" to="/help"><span className="h-row__main"><span className="h-row__title">Help and feedback{me.unreadReplies > 0 && <span className="dot inline" aria-label="new reply" />}</span><span className="h-row__sub">Quick answers, or tell us what’s not working</span></span>{Icon.chevron}</Link>
      </section>

      <section className="h-stack">
        <Button variant="secondary" block onClick={() => signOut().then(() => nav("/login"))}>Sign out</Button>
        {row("Sign out of all devices", "", () => open("signoutAll"), { danger: true })}
        {owner && others.length > 0 && row("Transfer ownership", "Make another member the Owner", () => open("transfer", { member: others[0] }))}
        {row("Leave household", owner && others.length ? "Transfer ownership first" : "", () => open("leave"), { danger: true })}
        {row("Delete household", "Everyone loses access; restorable for 30 days", () => open("delete"), { danger: true, ownerOnly: true })}
        <p className="muted" style={{ fontSize: 12 }}><a href="/privacy">Privacy policy</a> · <a href="/terms">Terms</a> · Version {__APP_VERSION__}</p>
      </section>
    </main>

    {dialog === "rename" && <Dialog title="Rename household" body="Everyone sees the new name." onClose={close}>
      <Field label="Household name" value={text} onChange={(e) => setText(e.target.value)} maxLength={60} error={error} />
      <Button loading={busy} onClick={() => patch({ name: text.trim() })}>Save</Button><Button variant="text" onClick={close}>Cancel</Button></Dialog>}
    {dialog === "timezone" && <Dialog title="Household time zone" body="Decides which day is “today” for everyone, so trips and overdue states match across devices." onClose={close}>
      <Field label="Time zone" list="tz-list" value={text} onChange={(e) => setText(e.target.value)} error={error} />
      <datalist id="tz-list">{(Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone").map((z) => <option key={z} value={z} />)}</datalist>
      <Button loading={busy} onClick={() => patch({ timezone: text })}>Save</Button><Button variant="text" onClick={close}>Cancel</Button></Dialog>}
    {dialog === "week" && <Dialog title="Week starts on" body="Changes the first day of the Plan week for everyone. Shopping days don’t move." onClose={close}>
      <Segmented label="First day" value={text} onChange={setText} options={[{ value: "mon", label: "Monday" }, { value: "sun", label: "Sunday" }, { value: "sat", label: "Saturday" }]} />
      <Button loading={busy} onClick={() => patch({ week_start: text })}>Save</Button><Button variant="text" onClick={close}>Cancel</Button></Dialog>}
    {dialog === "units" && <Dialog title="Measurements" body="Recipes keep the units they were written in. Grocery lists convert to this system so amounts merge and read naturally." onClose={close}>
      <Segmented label="System" value={text} onChange={setText} options={[{ value: "metric", label: "Metric" }, { value: "us", label: "US customary" }]} />
      <Button loading={busy} onClick={() => patch({ measurement: text })}>Save</Button><Button variant="text" onClick={close}>Cancel</Button></Dialog>}
    {dialog === "servings" && <Dialog title="Usual servings" body="New meals start with this many servings. Each meal can still be changed." onClose={close}>
      <Stepper label="Servings" value={num} min={1} max={20} onChange={setNum} />
      <Button loading={busy} onClick={() => patch({ default_servings: num })}>Save</Button><Button variant="text" onClick={() => patch({ default_servings: null })}>Use each recipe’s servings</Button></Dialog>}
    {dialog === "modules" && <Dialog title={h.enabled_modules.includes("meals") ? "Turn off Meals & Groceries?" : "Turn on Meals & Groceries?"} body="This hides or shows the module for everyone. Nothing is deleted." onClose={close}>
      <Button variant={h.enabled_modules.includes("meals") ? "danger" : "primary"} loading={busy} onClick={() => patch({ enabled_modules: h.enabled_modules.includes("meals") ? [] : ["meals"] })}>{h.enabled_modules.includes("meals") ? "Turn off" : "Turn on"}</Button><Button variant="text" onClick={close}>Cancel</Button></Dialog>}
    {dialog === "remove" && target && <Dialog title={`Remove ${target.name} from ${h.name}?`} body="They lose access right away. Recipes and lists they made stay with the household." onClose={close}>
      {error && <p className="error">{error}</p>}<Button variant="danger" loading={busy} onClick={() => run(() => api(`/api/members/${target.id}/remove`, { method: "POST" }))}>Remove {target.name}</Button><Button variant="text" onClick={close}>Cancel</Button></Dialog>}
    {dialog === "transfer" && <Dialog title="Make someone else the Owner" body="The new Owner controls members, modules and deletion. You stay as a Member." onClose={close}>
      <div role="radiogroup" aria-label="New owner" className="h-stack">{others.map((m) => <button key={m.id} type="button" role="radio" aria-checked={target?.id === m.id} className="h-chip" onClick={() => setTarget(m)}>{m.name}</button>)}</div>
      {error && <p className="error">{error}</p>}<Button loading={busy} disabled={!target} onClick={() => run(() => api("/api/ownership", { method: "POST", body: JSON.stringify({ userId: target!.id }) }))}>Make {target?.name} the Owner</Button><Button variant="text" onClick={close}>Cancel</Button></Dialog>}
    {dialog === "leave" && <Dialog title={`Leave ${h.name}?`} body="You’ll lose access to its recipes, plan and lists. Rejoining needs a new invite." onClose={close}>
      {error && <p className="error">{error}</p>}<Button variant="danger" loading={busy} onClick={() => run(() => api("/api/leave", { method: "POST" }), () => nav("/welcome"))}>Leave</Button><Button variant="text" onClick={close}>Cancel</Button></Dialog>}
    {dialog === "delete" && <Dialog title={`Delete ${h.name}?`} body="Everyone loses access now. All data is deleted for good after 30 days; until then you can restore it." onClose={close}>
      <Field label={`Type “${h.name}” to confirm`} value={text} onChange={(e) => setText(e.target.value)} error={error} />
      <Button variant="danger" loading={busy} disabled={text !== h.name} onClick={() => run(() => api("/api/household/delete", { method: "POST", body: JSON.stringify({ confirm: text }) }), () => nav("/"))}>Delete household</Button><Button variant="text" onClick={close}>Cancel</Button></Dialog>}
    {dialog === "signoutAll" && <Dialog title="Sign out of all devices?" body="Every device signed in to your account is signed out, including this one. Unsynced changes on other devices are lost." onClose={close}>
      {error && <p className="error">{error}</p>}<Button variant="danger" loading={busy} onClick={() => run(() => api("/api/sessions/revoke", { method: "POST" }), () => { void signOut(); nav("/login"); })}>Sign out everywhere</Button><Button variant="text" onClick={close}>Cancel</Button></Dialog>}
    {dialog === "deleteAccount" && <Dialog title="Delete your account?" body={`You’ll be removed from ${h.name} and your profile is erased right away; this can’t be undone.${owner && others.length ? ` You’re the Owner, so ownership passes to ${others[0].name}.` : ""}${others.length ? " Recipes and lists you made stay with the household." : ` You’re the only member, so ${h.name} and everything in it will be deleted too.`}`} onClose={close}>
      <Field label="Type your email to confirm" value={text} onChange={(e) => setText(e.target.value)} placeholder={me.user.email} error={error} />
      <Button variant="danger" loading={busy} disabled={text.toLowerCase() !== me.user.email.toLowerCase()} onClick={() => run(() => api("/api/account/delete", { method: "POST", body: JSON.stringify({ confirm: text }) }), () => { void signOut(); nav("/login"); })}>Delete my account</Button><Button variant="text" onClick={close}>Cancel</Button></Dialog>}
  </>);
}
