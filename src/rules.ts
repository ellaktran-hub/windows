// The planner's rules, kept apart from the screen code so they can be tested.

import { addDays, dayNum, lbl } from "../shared/dates.js";
import type { Bill, Project, SleepEntry, Task } from "../shared/types.js";

export function isOpen(x: Task): boolean {
  return x.status !== "Done";
}

export function byDue(a: Task, b: Task): number {
  const x = a.due || "9999";
  const y = b.due || "9999";
  return x < y ? -1 : x > y ? 1 : a.title.localeCompare(b.title);
}

// keep: ids just marked Done on screen, so they stay visible and can be undone.
export function top3(tasks: Task[], keep: Set<string> = new Set()): Task[] {
  return tasks.filter((x) => (isOpen(x) || keep.has(x.id)) && x.top3).sort(byDue);
}

/** Due today or overdue, open, and not already in the Top 3. */
export function dueToday(tasks: Task[], t: string, keep: Set<string> = new Set()): Task[] {
  return tasks.filter((x) => (isOpen(x) || keep.has(x.id)) && !x.top3 && x.due != null && x.due <= t).sort(byDue);
}

export type BucketKey = "overdue" | "today" | "week" | "later" | "none";
export function buckets(tasks: Task[], t: string): Record<BucketKey, Task[]> {
  const b: Record<BucketKey, Task[]> = { overdue: [], today: [], week: [], later: [], none: [] };
  for (const x of tasks) {
    if (!x.due) { b.none.push(x); continue; }
    const n = dayNum(x.due) - dayNum(t);
    (n < 0 ? b.overdue : n === 0 ? b.today : n <= 7 ? b.week : b.later).push(x);
  }
  for (const k of Object.keys(b) as BucketKey[]) b[k].sort(byDue);
  return b;
}

export interface ComingItem {
  date: string;
  kind: "deadline" | "bill" | "task";
  title: string;
  detail: string;
  amount: number | null;
  pastDue: boolean;
}

/** Project deadlines and unpaid bills within 14 days, open tasks due in the next 7 days. */
export function comingUp(t: string, tasks: Task[] | null, projects: Project[] | null, bills: Bill[] | null): ComingItem[] {
  const end14 = addDays(t, 14);
  const end7 = addDays(t, 7);
  const out: ComingItem[] = [];
  for (const p of projects || []) {
    if (p.deadline && p.deadline >= t && p.deadline <= end14)
      out.push({ date: p.deadline, kind: "deadline", title: p.name, detail: p.next, amount: null, pastDue: false });
  }
  for (const b of bills || []) {
    if (!b.paid && b.due && b.due <= end14)
      out.push({ date: b.due, kind: "bill", title: b.name, detail: "", amount: b.amount, pastDue: b.due < t });
  }
  for (const x of tasks || []) {
    if (isOpen(x) && x.due && x.due > t && x.due <= end7)
      out.push({ date: x.due, kind: "task", title: x.title, detail: "", amount: null, pastDue: false });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Open tasks due after today, up to 7 days ahead. */
export function weekTasks(tasks: Task[] | null, t: string, keep: Set<string> = new Set()): Task[] {
  const end = addDays(t, 7);
  return (tasks || []).filter((x) => (isOpen(x) || keep.has(x.id)) && x.due != null && x.due > t && x.due <= end).sort(byDue);
}

/** Project deadlines from today up to 14 days ahead. */
export function deadlinesSoon(projects: Project[] | null, t: string): Project[] {
  const end = addDays(t, 14);
  return (projects || []).filter((p) => p.deadline && p.deadline >= t && p.deadline <= end)
    .sort((a, b) => (a.deadline! < b.deadline! ? -1 : a.deadline! > b.deadline! ? 1 : 0));
}

/** Unpaid bills due up to 14 days ahead, including any past their date. */
export function billsSoon(bills: Bill[] | null, t: string): Bill[] {
  const end = addDays(t, 14);
  return (bills || []).filter((b) => !b.paid && b.due && b.due <= end)
    .sort((a, b) => (a.due! < b.due! ? -1 : a.due! > b.due! ? 1 : 0));
}

export function nextSteps(projects: Project[] | null): Project[] {
  return (projects || []).filter((p) => (p.status === "Urgent" || p.status === "Active") && p.next);
}

export const REST = "Nothing pressing. Rest counts too.";

/** First open Top 3 task, else earliest overdue or due-today task, else an Urgent project's next step. */
export function startWith(t: string, tasks: Task[] | null, projects: Project[] | null): string | null {
  const open = (tasks || []).filter(isOpen);
  const a = open.filter((x) => x.top3).sort(byDue)[0] || open.filter((x) => x.due != null && x.due <= t).sort(byDue)[0];
  if (a) return a.title;
  const p = (projects || []).filter((x) => x.status === "Urgent" && x.next)[0];
  if (p) return p.next;
  return tasks ? REST : null;
}

/** One entry per night: the most recently logged one wins. Newest night first. */
export function latestPerNight(rows: SleepEntry[]): SleepEntry[] {
  const sorted = rows.slice().sort((a, b) => (a.logged < b.logged ? 1 : a.logged > b.logged ? -1 : 0));
  const seen = new Set<string>();
  const out: SleepEntry[] = [];
  for (const r of sorted) {
    const k = r.night.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

export function lastNight(rows: SleepEntry[], t: string): SleepEntry | null {
  const lab = lbl(addDays(t, -1)).toLowerCase();
  return latestPerNight(rows).find((x) => x.night.trim().toLowerCase() === lab) || null;
}

export function nightsLogged(rows: SleepEntry[], t: string): number {
  const have = new Set(latestPerNight(rows).map((r) => r.night.trim().toLowerCase()));
  let n = 0;
  for (let i = 1; i <= 7; i++) if (have.has(lbl(addDays(t, -i)).toLowerCase())) n++;
  return n;
}

export function hasNight(rows: SleepEntry[], night: string): boolean {
  const k = night.trim().toLowerCase();
  return rows.some((r) => r.night.trim().toLowerCase() === k);
}
