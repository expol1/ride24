/**
 * Out-of-hours detection from a Caravel desk's own published schedule
 * (OpenAPI v1.67.0 Location.hours / holidays / timezone). No fixed night
 * window is assumed: the desk's hours decide, read in the desk's timezone.
 *
 * Rules from the spec: a weekday with no entry is closed all day; a close at or
 * before open crosses midnight; "00:00" as close means end of day; `holidays`
 * entries replace the weekly hours for that local date. Weekday values seen on
 * the live sandbox (14 Nov 2026): mon, tue, wed, thu, fri, sat, sun.
 * Returns null when the desk states no hours (fail closed for the caller).
 */
type Json = Record<string, unknown>;
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

function local(instantMs: number, tz: string): {date: string; prevDate: string; day: string; prevDay: string; minute: number} | null {
  try {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    }).formatToParts(new Date(instantMs)).map((p) => [p.type, p.value]));
    const date = `${parts.year}-${parts.month}-${parts.day}`;
    const dayIndex = new Date(`${date}T12:00:00Z`).getUTCDay();
    const prev = new Date(Date.parse(`${date}T12:00:00Z`) - 86400000);
    return {date, prevDate: prev.toISOString().slice(0, 10), day: DAYS[dayIndex], prevDay: DAYS[(dayIndex + 6) % 7],
      minute: Number(parts.hour) * 60 + Number(parts.minute)};
  } catch {
    return null;
  }
}

type Window = {open: number; close: number; crosses: boolean};
function windowOf(open: unknown, close: unknown): Window | null {
  if (typeof open !== "string" || typeof close !== "string" || !HHMM.test(open) || !HHMM.test(close)) return null;
  const o = minutes(open), c0 = minutes(close);
  const c = c0 === 0 ? 1440 : c0;
  return {open: o, close: c, crosses: c <= o};
}

/** Windows that start on `date`/`day`: holiday entry wins over weekly hours. */
function windowsFor(location: Json, date: string, day: string): Window[] | null {
  const holidays = Array.isArray(location.holidays) ? location.holidays as Json[] : [];
  const h = holidays.find((x) => x?.date === date);
  if (h) {
    if (h.closed === true) return [];
    const w = windowOf(h.open, h.close);
    return w ? [w] : null;
  }
  if (!Array.isArray(location.hours)) return null;
  const out: Window[] = [];
  for (const entry of location.hours as Json[]) {
    if (entry?.day !== day) continue;
    const w = windowOf(entry.open, entry.close);
    if (!w) return null;
    out.push(w);
  }
  return out;
}

/** true = outside the desk's hours, false = inside, null = schedule not stated/unreadable. */
export function caravelOutsideHours(location: unknown, instantIso: string): boolean | null {
  const loc = location && typeof location === "object" ? location as Json : null;
  const ms = Date.parse(instantIso);
  if (!loc || !Number.isFinite(ms) || typeof loc.timezone !== "string" || !Array.isArray(loc.hours)) return null;
  const t = local(ms, loc.timezone);
  if (!t) return null;
  const today = windowsFor(loc, t.date, t.day);
  const yesterday = windowsFor(loc, t.prevDate, t.prevDay);
  if (today === null || yesterday === null) return null;
  const inside = today.some((w) => t.minute >= w.open && (w.crosses || t.minute < w.close)) ||
    yesterday.some((w) => w.crosses && t.minute < w.close);
  return !inside;
}

/** Local HH:MM of an instant at the desk (for the mandatory-charge verifier input). */
export function caravelLocalTime(instantIso: string, tz: string): string | null {
  const ms = Date.parse(instantIso);
  const t = Number.isFinite(ms) ? local(ms, tz) : null;
  return t ? `${String(Math.floor(t.minute / 60)).padStart(2, "0")}:${String(t.minute % 60).padStart(2, "0")}` : null;
}
