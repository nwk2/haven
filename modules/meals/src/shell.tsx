import { Icon } from "@haven/ui";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useCtx } from "./ctx";

export function ModuleShell({ title, tab, header, children }: { title: string; tab: "plan" | "recipes" | "shopping"; header?: ReactNode; children: ReactNode }) {
  const { household } = useCtx();
  return (<>
    <header className="mod-header">
      <div className="h-modhead">
        <Link to="/" className="h-icon-btn" aria-label={`Back to ${household.name}`} style={{ marginLeft: -10 }}>{Icon.back}</Link>
        <div><div className="h-modhead__eyebrow">Meals &amp; Groceries</div><h1>{title}</h1></div>
      </div>
      {header && <div style={{ padding: "0 16px 8px" }}>{header}</div>}
    </header>
    <main className="page h-stack mod-main">{children}</main>
    <nav className="h-tabbar" aria-label="Meals and Groceries">
      <Link to="/m/meals/plan" aria-current={tab === "plan" ? "page" : undefined}>{Icon.calendar}Plan</Link>
      <Link to="/m/meals/recipes" aria-current={tab === "recipes" ? "page" : undefined}>{Icon.book}Recipes</Link>
      <Link to="/m/meals/lists" aria-current={tab === "shopping" ? "page" : undefined}>{Icon.list}Shopping</Link>
    </nav>
  </>);
}

export function DetailHeader({ title, back, right }: { title: string; back: string; right?: ReactNode }) {
  return (
    <header className="h-header">
      <Link to={back} className="h-icon-btn" aria-label="Back">{Icon.back}</Link>
      <h1 className="h-header__title">{title}</h1>
      {right}
    </header>
  );
}
