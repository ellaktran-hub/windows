// Date and time helpers shared by the server and the browser.
// Every "day" is a YYYY-MM-DD string in the planner's time zone.

export const TZ = "America/New_York";
export const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function todayStr(now: Date = new Date()): string {
  return now.toLocaleDateString("en-CA", { timeZone: TZ });
}

/** Whole days since 1970-01-01 for a YYYY-MM-DD string. */
export function dayNum(s: string): number {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 864e5);
}

export function addDays(s: string, n: number): string {
  return new Date((dayNum(s) + n) * 864e5).toISOString().slice(0, 10);
}

/** "2026-11-03" -> "Nov 3", the same label the Sleep Log uses. */
export function lbl(s: string): string {
  const [, m, d] = s.slice(0, 10).split("-").map(Number);
  return MON[m - 1] + " " + d;
}

export function rel(s: string, t: string): string {
  const n = dayNum(s) - dayNum(t);
  if (n === 0) return "today";
  if (n === 1) return "tomorrow";
  if (n === -1) return "yesterday";
  return n > 0 ? "in " + n + " days" : -n + " days ago";
}

export function weekday(s: string): string {
  return new Date(dayNum(s) * 864e5).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
}

export function hourNow(now: Date = new Date()): number {
  return Number(now.toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: TZ })) % 24;
}

export function fmtTime(iso: string | number | Date): string {
  return new Date(iso)
    .toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TZ })
    .replace(/\s*(AM|PM)/, (_m, p: string) => " " + p.toLowerCase());
}

/**
 * Minutes after midnight for a clock time.
 * Accepts "3:45 am", "3:45 AM", "4am", "11pm", "23:30", "4 a.m.".
 */
export function parseClock(input: string | null | undefined): number | null {
  const s = String(input ?? "").trim().toLowerCase().replace(/\./g, "");
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(a|p)?m?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const mi = Number(m[2] ?? 0);
  if (mi > 59) return null;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    if (m[3] === "p" && h < 12) h += 12;
    if (m[3] === "a" && h === 12) h = 0;
  } else if (h > 23) {
    return null;
  }
  return h * 60 + mi;
}

/** Hours from bedtime to wake-up, wrapping past midnight, rounded to the nearest quarter hour. */
export function hoursBetween(bed: string, wake: string): number | null {
  const x = parseClock(bed);
  const y = parseClock(wake);
  if (x == null || y == null) return null;
  let d = y - x;
  if (d <= 0) d += 1440;
  return Math.round((d / 60) * 4) / 4;
}
