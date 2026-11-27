import { Icon } from "@haven/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { lazy, Suspense, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api";
import { todayIn } from "../date";
import { useSession } from "../session";
import { Announcements } from "../components/Announcements";
import { InstallCard } from "../components/InstallCard";

// Each module renders its own console section (today's meal, what's due) inside its own ctx;
// lazy, so the console doesn't pull whole modules into the first load.
const ConsoleMeals = lazy(() => import("@haven/module-meals").then((m) => ({ default: m.ConsoleMeals })));
const ConsoleTasks = lazy(() => import("@haven/module-todos").then((m) => ({ default: m.ConsoleTasks })));

type Member = { id: string; name: string };

export function Console() {
  const { me, db, sync } = useSession();
  const h = me?.household;
  const today = h ? todayIn(h.timezone) : "";
  const [members, setMembers] = useState<Member[]>([]);
  useEffect(() => { api<{ members: Member[] }>("/api/members").then((r) => setMembers(r.members)).catch(() => setMembers([])); }, [h?.id]);
  const data = useLiveQuery(async () => {
    if (!db) return null;
    const [recipes, planned, activity] = await Promise.all([
      db.meals_recipes.filter((r) => !r.deleted).count(),
      db.meals_planned.filter((m) => !m.deleted && m.status === "planned").count(),
      db.activity.orderBy("at").reverse().limit(5).toArray(),
    ]);
    return { recipes, planned, activity };
  }, [db]);

  if (!h || !me || !data || !db || !sync) return null;
  const firstRun = data.recipes === 0 && data.planned === 0;
  const user = { id: me.user.id, name: me.user.name, role: me.user.role };
  const meals = !!me.flags.module_meals_enabled && h.enabled_modules.includes("meals");
  const tasks = !!me.flags.module_todos_enabled && h.enabled_modules.includes("todos");

  return (
    <main className="page h-stack c-page">
      <header className="c-head">
        <div>
          <div className="c-head__date">{new Intl.DateTimeFormat(undefined, { weekday: "long", day: "numeric", month: "long", timeZone: h.timezone }).format(Date.now())}</div>
          <h1>{h.name}</h1>
        </div>
        <Link to="/settings" className="h-icon-btn" aria-label={me.unreadReplies ? "Settings, new reply" : "Settings"} style={{ position: "relative" }}>
          {Icon.settings}{me.unreadReplies > 0 && <span className="dot" aria-hidden="true" />}
        </Link>
      </header>

      <Announcements />
      {me.unreadReplies > 0 && (
        <Link to="/help" className="note note--info" role="status"><strong>The Haven team replied</strong> to your message.</Link>
      )}

      <InstallCard />

      {firstRun && (
        <section className="h-card h-stack c-start" aria-labelledby="gs">
          <h2 id="gs">Get started</h2>
          <Link className="h-row" to="/m/meals/recipes/new"><span className="h-row__main"><span className="h-row__title">Add your first recipe</span><span className="h-row__sub">Start here · about 2 minutes</span></span>{Icon.chevron}</Link>
          <Link className="h-row" to="/m/meals/plan"><span className="h-row__main"><span className="h-row__title">Plan a meal</span><span className="h-row__sub">Your shopping list builds itself from what’s planned</span></span>{Icon.chevron}</Link>
          <Link className="h-row" to="/settings"><span className="h-row__main"><span className="h-row__title">Invite someone</span><span className="h-row__sub">Share the link; they sign in with Google</span></span>{Icon.chevron}</Link>
        </section>
      )}

      <Suspense fallback={null}>
        {meals && <ConsoleMeals ctx={{ db, sync, user, household: h, today, features: me.features ?? { photos: false } }} />}
        {!me.flags.module_meals_enabled && <p className="muted">Meals &amp; Groceries is paused for maintenance. Your data is safe.</p>}
        {tasks && <ConsoleTasks ctx={{ db, sync, user, household: h, today, members }} />}
      </Suspense>

      {data.activity.length > 0 && (
        <section aria-labelledby="act">
          <div className="c-label"><h2 id="act">Activity</h2></div>
          <ul className="plain">{data.activity.map((a) => {
            const who = members.find((m) => m.id === a.member_id);
            return (
              <li key={a.id} className="c-act">
                {who ? <span className={`td-who td-who--${hueOf(who.id)}`} aria-hidden="true">{who.name[0]}</span> : <span />}
                <span>{String(a.text)}</span>
                <time dateTime={new Date(Number(a.at)).toISOString()}>{ago(Number(a.at))}</time>
              </li>
            );
          })}</ul>
        </section>
      )}
    </main>
  );
}

/** Same colour per person as the Tasks assignee avatar. */
const hueOf = (id: string) => [...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 4, 0) + 1;

function ago(at: number) {
  const m = Math.round((Date.now() - at) / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  if (m < 24 * 60) return `${Math.round(m / 60)}h`;
  if (m < 48 * 60) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" }).format(at);
}
