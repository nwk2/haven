import { Icon } from "@haven/ui";
import { useLiveQuery } from "dexie-react-hooks";
import { Link } from "react-router-dom";
import { fmtDay, todayIn } from "../date";
import { useSession } from "../session";

export function Console() {
  const { me, db } = useSession();
  const h = me?.household;
  const today = h ? todayIn(h.timezone) : "";
  const data = useLiveQuery(async () => {
    if (!db) return null;
    const [recipes, planned, trips, activity] = await Promise.all([
      db.meals_recipes.filter((r) => !r.deleted).count(),
      db.meals_planned.filter((m) => !m.deleted && m.status === "planned").toArray(),
      db.meals_trips.filter((t) => !t.deleted && t.status !== "finished" && String(t.date) >= today).sortBy("date"),
      db.activity.orderBy("at").reverse().limit(5).toArray(),
    ]);
    const tonight = planned.find((m) => m.date === today && m.slot === "dinner");
    const tonightTitle = tonight ? (await db.meals_recipes.get(String(tonight.recipe_id)))?.title : undefined;
    return { recipes, planned: planned.length, nextTrip: trips[0], activity, tonightTitle: tonightTitle as string | undefined };
  }, [db, today]);

  if (!h || !data) return null;
  const firstRun = data.recipes === 0 && data.planned === 0;

  return (
    <main className="page h-stack" style={{ gap: 22, paddingTop: 24, paddingBottom: 32 }}>
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
        <div>
          <div className="muted" style={{ fontSize: 13 }}>{greeting()}, {me!.user.name.split(" ")[0]}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <h1 style={{ margin: 0, fontSize: 28 }}>{h.name}</h1>
          </div>
        </div>
        <Link to="/settings" className="h-icon-btn" aria-label={me!.unreadReplies ? "Settings, new reply" : "Settings"} style={{ position: "relative" }}>
          {Icon.settings}{me!.unreadReplies > 0 && <span className="dot" aria-hidden="true" />}
        </Link>
      </header>

      {me!.announcement && <p className="note note--info" role="status">{me!.announcement.text}</p>}
      {me!.unreadReplies > 0 && (
        <Link to="/help" className="note note--info" role="status"><strong>The Haven team replied</strong> to your message.</Link>
      )}

      {firstRun && (
        <section className="h-card h-stack" style={{ padding: 16 }} aria-labelledby="gs">
          <h2 id="gs" style={{ margin: 0, fontSize: 18 }}>Get started</h2>
          <Link className="h-row" to="/m/meals/recipes/new"><span className="h-row__main"><span className="h-row__title">Add your first recipe</span><span className="h-row__sub">Start here · about 2 minutes</span></span>{Icon.chevron}</Link>
          <Link className="h-row" to="/m/meals/plan"><span className="h-row__main"><span className="h-row__title">Plan a meal and a grocery run</span><span className="h-row__sub">Your first grocery list builds itself</span></span>{Icon.chevron}</Link>
          <Link className="h-row" to="/settings"><span className="h-row__main"><span className="h-row__title">Invite someone</span><span className="h-row__sub">Share the link; they sign in with Google</span></span>{Icon.chevron}</Link>
        </section>
      )}

      <section className="h-stack" aria-labelledby="mods">
        <h2 id="mods" className="h-section-title">Modules</h2>
        {me!.flags.module_meals_enabled && h.enabled_modules.includes("meals") && <Link to="/m/meals/plan" className="h-card tile">
          <span className="tile__icon" aria-hidden="true">{Icon.cart}</span>
          <span className="h-row__main"><span className="h-row__title" style={{ fontSize: 17 }}>Meals &amp; Groceries</span>
            <span className="h-row__sub">{data.tonightTitle ? `Tonight: ${data.tonightTitle}` : data.planned ? `${data.planned} meals planned` : "No meals planned yet"}
              {data.nextTrip ? ` · Next grocery run ${fmtDay(String(data.nextTrip.date))}` : ""}</span></span>
          {Icon.chevron}
        </Link>}
        {!me!.flags.module_meals_enabled && <p className="muted">Meals &amp; Groceries is paused for maintenance. Your data is safe.</p>}
        {me!.flags.show_planned_modules && <div className="planned">{["Chores", "Bills", "Calendar"].map((n) => <div key={n} className="planned__tile" aria-disabled="true"><strong>{n}</strong><span>Planned</span></div>)}</div>}
      </section>

      {data.activity.length > 0 && (
        <section aria-labelledby="act">
          <h2 id="act" className="h-section-title">Activity</h2>
          <ul className="plain">{data.activity.map((a) => <li key={a.id} className="activity">{String(a.text)}</li>)}</ul>
        </section>
      )}
    </main>
  );
}

function greeting() { const h = new Date().getHours(); return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening"; }
