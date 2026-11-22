import { useEffect, useId, useRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";

type Variant = "primary" | "secondary" | "danger" | "text";

export function Button({ variant = "primary", block, loading, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; block?: boolean; loading?: boolean }) {
  return (
    <button {...rest} disabled={rest.disabled || loading} aria-busy={loading || undefined}
      className={`h-btn h-btn--${variant}${block ? " h-btn--block" : ""} ${rest.className ?? ""}`}>
      {loading ? <Spinner /> : children}
    </button>
  );
}

export function LinkButton({ variant = "primary", block, href, children }: { variant?: Variant; block?: boolean; href: string; children: ReactNode }) {
  return <a href={href} className={`h-btn h-btn--${variant}${block ? " h-btn--block" : ""}`}>{children}</a>;
}

export const Spinner = () => (
  <svg className="h-spin" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.3" strokeWidth="3" /><path d="M12 3a9 9 0 0 1 9 9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg>
);

export function Field({ label, hint, error, textarea, ...rest }: { label: string; hint?: string; error?: string; textarea?: boolean } & InputHTMLAttributes<HTMLInputElement> & TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  const msgId = `${id}-msg`;
  const common = { id, className: "h-input", "aria-invalid": error ? true : undefined, "aria-describedby": hint || error ? msgId : undefined };
  return (
    <div className="h-field">
      <label htmlFor={id} className="h-field__label">{label}</label>
      {textarea ? <textarea {...(rest as TextareaHTMLAttributes<HTMLTextAreaElement>)} {...common} /> : <input {...(rest as InputHTMLAttributes<HTMLInputElement>)} {...common} />}
      {(hint || error) && <span id={msgId} className={`h-field__msg${error ? " h-field__msg--error" : ""}`}>{error ?? hint}</span>}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="h-switch" onClick={() => onChange(!checked)} />;
}

export function Stepper({ value, min = 1, max = 50, onChange, label }: { value: number; min?: number; max?: number; onChange: (v: number) => void; label: string }) {
  return (
    <span className="h-stepper" role="group" aria-label={label}>
      <button type="button" aria-label={`Fewer ${label.toLowerCase()}`} disabled={value <= min} onClick={() => onChange(value - 1)}>−</button>
      <output aria-live="polite">{value}</output>
      <button type="button" aria-label={`More ${label.toLowerCase()}`} disabled={value >= max} onClick={() => onChange(value + 1)}>+</button>
    </span>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="h-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => <button key={o.value} type="button" role="radio" aria-checked={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>)}
    </div>
  );
}

/** Focus trap + Escape + return focus (PRD › Accessibility beyond contrast). */
function useModal(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const el = ref.current!;
    const focusables = () => [...el.querySelectorAll<HTMLElement>("button, a[href], input, textarea, select, [tabindex]:not([tabindex='-1'])")].filter((x) => !x.hasAttribute("disabled"));
    (focusables()[0] ?? el).focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab") return;
      const f = focusables(); if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    };
    el.addEventListener("keydown", onKey);
    return () => { el.removeEventListener("keydown", onKey); opener?.focus(); };
  }, [onClose]);
  return ref;
}

export function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useModal(onClose);
  const id = useId();
  return (<>
    <div className="h-scrim" onClick={onClose} aria-hidden="true" />
    <div ref={ref} className="h-sheet" role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}>
      <div className="h-sheet__handle" aria-hidden="true" />
      <h2 id={id} style={{ margin: "4px 0 12px", fontSize: 20 }}>{title}</h2>
      {children}
    </div>
  </>);
}

export function Dialog({ title, body, onClose, children }: { title: string; body?: ReactNode; onClose: () => void; children: ReactNode }) {
  const ref = useModal(onClose);
  const id = useId();
  return (<>
    <div className="h-scrim" onClick={onClose} aria-hidden="true" />
    <div ref={ref} className="h-dialog" role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}>
      <h2 id={id} style={{ margin: 0, fontSize: 19 }}>{title}</h2>
      {body && <div className="muted" style={{ fontSize: 14 }}>{body}</div>}
      <div className="h-stack">{children}</div>
    </div>
  </>);
}

export const Icon = {
  back: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6" /></svg>,
  grid: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5" /><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5" /><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5" /></svg>,
  chevron: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6" /></svg>,
  cart: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="9" cy="20" r="1.4" /><circle cx="18" cy="20" r="1.4" /><path d="M2 3h3l2.6 12.2a1.6 1.6 0 0 0 1.6 1.3h8.6a1.6 1.6 0 0 0 1.6-1.2L21 8H6" /></svg>,
  calendar: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>,
  book: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z" /><path d="M4 21V5M9 8h6" /></svg>,
  list: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 6h11M9 12h11M9 18h11" /><path d="M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2" /></svg>,
  more: <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>,
  check: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M5 12l5 5 9-10" /></svg>,
  settings: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>,
};
