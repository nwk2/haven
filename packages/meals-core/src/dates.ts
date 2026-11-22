import type { LocalDate } from "./types";

const toUTC = (d: LocalDate) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const fromUTC = (t: number): LocalDate => new Date(t).toISOString().slice(0, 10);

export const addDays = (d: LocalDate, n: number): LocalDate => fromUTC(toUTC(d) + n * 86_400_000);
export const compare = (a: LocalDate, b: LocalDate) => (a < b ? -1 : a > b ? 1 : 0);
