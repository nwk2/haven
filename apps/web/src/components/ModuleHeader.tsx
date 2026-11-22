import { Icon } from "@haven/ui";
import { Link } from "react-router-dom";

export function ModuleHeader({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <header>
      <div className="h-modhead">
        <Link to="/" className="h-icon-btn" aria-label="Back to household" style={{ marginLeft: -10 }}>{Icon.back}</Link>
        <div><div className="h-modhead__eyebrow">Meals &amp; Groceries</div><h1>{title}</h1></div>
      </div>
      {children}
    </header>
  );
}

export function BackHeader({ title, back, right }: { title: string; back: string; right?: React.ReactNode }) {
  return (
    <header className="h-header">
      <Link to={back} className="h-icon-btn" aria-label="Back">{Icon.back}</Link>
      <h1 className="h-header__title">{title}</h1>
      {right}
    </header>
  );
}
