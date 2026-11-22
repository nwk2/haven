/** Today's date in the household's time zone (PRD › Edge cases › Time). */
export const todayIn = (tz: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

export const fmtDay = (d: string, opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric" }) =>
  new Intl.DateTimeFormat(undefined, { ...opts, timeZone: "UTC" }).format(new Date(`${d}T00:00:00Z`));
