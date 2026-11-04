// Home Window front end: plain TypeScript, no framework.
// Phase 1: reads sample content from the app's own server. Taps on check
// boxes and forms change only what is on screen and say so.

import "./styles.css";
import { addDays, fmtTime, hourNow, hoursBetween, lbl, rel, todayStr, weekday } from "../shared/dates.js";
import type { Bill, CalendarResponse, ListResponse, Project, SleepEntry, Source, Task, Calendar } from "../shared/types.js";
import { errText, getJson, postJson } from "./api.js";
import * as R from "./rules.js";

type Status = "loading" | "ok" | "error";
interface Slot<T> { status: Status; data: T | null; err: unknown; source: Source | null }
const slot = <T>(): Slot<T> => ({ status: "loading", data: null, err: null, source: null });

const BLOCKS = ["Morning", "Work day", "Lunch", "After work", "Evening"];
const TABS: Array<[string, string]> = [["today", "today"], ["tasks", "tasks"], ["bills", "bills"], ["projects", "projects"], ["sleep", "sleep"]];

const S = {
  tab: "today",
  tasks: slot<Task[]>(),
  projects: slot<Project[]>(),
  bills: slot<Bill[]>(),
  sleep: slot<SleepEntry[]>(),
  cal: slot<Calendar>(),
  updated: null as number | null,
  refreshing: false,
  confirmDup: false,
  prevStatus: {} as Record<string, string>, // status a task had before it was marked Done
  doneKeep: {} as Record<string, Task>, // tasks marked done here, kept visible so they can be undone
  busy: {} as Record<string, boolean>, // a change is on its way for this task or form
  draft: { task: "", block: "", due: "", night: "", bed: "", wake: "", hours: "", hoursTouched: false },
};

const app = document.getElementById("app")!;
const toastEl = document.getElementById("toast")!;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
function money(n: number | null): string {
  return typeof n === "number" ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n) : "";
}
const isSample = () => [S.tasks, S.projects, S.bills, S.sleep, S.cal].some((s) => s.source === "sample");

/* ---------- loading ---------- */
async function load<T>(s: Slot<T>, fn: () => Promise<{ source: Source; data: T }>) {
  s.err = null;
  s.status = s.data ? "ok" : "loading";
  render();
  try {
    const r = await fn();
    s.data = r.data; s.source = r.source; s.status = "ok";
  } catch (e) {
    s.status = "error"; s.err = e; // keep the last good copy in s.data
  }
  render();
}
const list = <T>(path: string) => async () => {
  const r = await getJson<ListResponse<T>>(path);
  if (!Array.isArray(r.items)) throw new Error("bad_shape");
  return { source: r.source, data: r.items };
};

async function refreshAll() {
  if (S.refreshing) return;
  S.refreshing = true;
  render();
  await Promise.all([
    load(S.tasks, list<Task>("/api/tasks")).then(keepDone),
    load(S.projects, list<Project>("/api/projects")),
    load(S.bills, list<Bill>("/api/bills")),
    load(S.sleep, list<SleepEntry>("/api/sleep")),
    load(S.cal, async () => { const r = await getJson<CalendarResponse>("/api/calendar"); return { source: r.source, data: r.calendar }; }),
  ]);
  S.updated = Date.now();
  S.refreshing = false;
  render();
}

/* ---------- view helpers ---------- */
function win(title: string, color: string, body: string, wide = false): string {
  return `<section class="win${wide ? " wide" : ""}"><div class="bar ${color}"><span>${esc(title)}</span><span class="x" aria-hidden="true">×</span></div><div class="body">${body}</div></section>`;
}
function errBlock(e: unknown, server: string) {
  return `<div class="note">${esc(errText(e, server))}</div><div><button class="btn" data-act="refresh">try again</button></div>`;
}
function sect<T>(s: Slot<T>, fn: (d: T) => string, server = "Notion"): string {
  if (!s.data) return s.status === "error" ? errBlock(s.err, server) : '<div class="meta">loading</div>';
  let h = fn(s.data);
  if (s.status === "error") h += `<div class="note">${esc(errText(s.err, server))} Showing the last copy.</div>`;
  return h;
}
function projName(id: string) { return (S.projects.data || []).find((p) => p.id === id)?.name || ""; }

function todo(x: Task): string {
  const t = todayStr(), bits: string[] = [];
  const done = x.status === "Done";
  if (x.block) bits.push(x.block);
  if (x.area) bits.push(x.area);
  const pn = x.projectIds.map(projName).find(Boolean); if (pn) bits.push(pn);
  if (x.due) bits.push(x.due < t ? "was due " + lbl(x.due) : x.due === t ? "due today" : "due " + lbl(x.due));
  return `<div class="todo${done ? " done" : ""}">` +
    `<button class="box" role="checkbox" aria-checked="${done}" aria-label="${done ? "Undo done: " : "Mark done: "}${esc(x.title)}" data-act="toggle" data-id="${esc(x.id)}"${S.busy[x.id] ? " disabled" : ""}></button>` +
    `<div><b>${esc(x.title)}</b><div class="meta">${esc(bits.join(" · "))}</div></div>` +
    `<button class="pin" aria-pressed="${x.top3}" data-act="pin" data-id="${esc(x.id)}"${S.busy[x.id] ? " disabled" : ""}>top 3</button></div>`;
}
function blocksHtml(h: number | null): string {
  const n = Math.max(0, Math.min(8, Math.round(h || 0)));
  let s = ""; for (let i = 0; i < 8; i++) s += `<i class="${i < n ? "on" : ""}"></i>`;
  return `<div class="blocks" role="img" aria-label="${n} of 8 hours">${s}</div>`;
}
function nightSummary(n: SleepEntry | null, withLink: boolean): string {
  if (!n) return '<div class="soft">Last night is not logged yet.</div>' + (withLink ? '<div><a class="btn" href="#sleep">log it</a></div>' : "");
  return `<div class="big">${esc(n.hours == null ? "logged" : n.hours + " hours")}</div>` + (n.hours == null ? "" : blocksHtml(n.hours)) +
    `<div class="meta">${esc([n.bed && "bed " + n.bed, n.wake && "up " + n.wake].filter(Boolean).join(" · "))}</div>`;
}

/* ---------- views ---------- */
function hello(): string {
  const t = todayStr(), h = hourNow();
  const g = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  const up = S.refreshing && !S.updated ? "loading" : S.updated ? "updated " + fmtTime(S.updated) : "";
  return `<section class="win wide hello"><div class="bar pink"><span>hi, lovely</span><span class="x" aria-hidden="true">×</span></div><div class="body">` +
    `<div class="stack"><div class="date">${esc(weekday(t) + " · " + lbl(t))}</div><h1>${g}, <em>Ella.</em></h1>` +
    `<div class="soft">One small thing at a time.</div></div><svg class="heart" aria-hidden="true"><use href="#px-heart"/></svg></div></section>` +
    `<nav class="tabs" aria-label="Pages">${TABS.map(([k, name]) => `<a class="tab" href="#${k}"${S.tab === k ? ' aria-current="page"' : ""}>${name}</a>`).join("")}</nav>` +
    `<div class="status"><span class="meta">${esc(up)}</span><button class="btn quiet" data-act="refresh"${S.refreshing ? " disabled" : ""}>refresh</button></div>` +
    (isSample() ? '<div class="note sample wide">Sample content. This is not your Notion data yet, and nothing you tap here is saved.</div>' : "");
}

function todayView(): string {
  const t = todayStr(), tasks = S.tasks.data || [];
  const cal = win("today.exe", "sky", sect(S.cal, (c) => {
    if (!c.connected) return '<div class="meta">Work</div><div class="soft">The calendar is not connected yet.</div>' +
      (c.canConnect ? '<div><a class="btn" href="/api/google/connect">connect calendar</a></div><div class="meta">Read only. It can never change your calendar.</div>' : "");
    let h = '<div class="meta">Work</div>';
    if (c.work) h += `<div class="big">${esc(c.work)}</div>`;
    else if (c.noWork.length) h += '<div class="big">No work today</div>';
    else h += '<div class="soft">No shift on the calendar.</div>';
    const tags = c.tags.concat(c.noWork);
    if (tags.length) h += `<div class="row">${tags.map((x) => `<span class="tag butter">${esc(x)}</span>`).join("")}</div>`;
    h += "<hr>";
    h += c.appts.length ? `<ul class="list">${c.appts.map((a) => `<li><span class="meta">${esc(a.time)}</span><span><b>${esc(a.title)}</b></span></li>`).join("")}</ul>` : '<div class="meta">No appointments today</div>';
    if (c.failed) h += '<div class="note">One calendar did not answer, so this may be missing something.</div>';
    return h;
  }, "Google Calendar"));
  const keep = new Set(Object.keys(S.prevStatus));
  const top = R.top3(tasks, keep), due = R.dueToday(tasks, t, keep);
  const topW = win("top_3.txt", "butter", sect(S.tasks, () => top.length ? top.map(todo).join("") : '<div class="soft">No top 3 chosen. Tap "top 3" on up to three tasks.</div>'));
  const dueW = win("due_today.txt", "peach", sect(S.tasks, () => due.length ? due.map(todo).join("") : '<div class="soft">Nothing due today.</div>'));
  const sl = win("sleep.log", "lilac", sect(S.sleep, (rows) => nightSummary(R.lastNight(rows, t), true)));
  return cal + topW + dueW + sl + win("coming_up.txt", "mint", comingBody(), true) + bubble();
}

function comingBody(): string {
  const parts = [S.tasks, S.projects, S.bills];
  if (parts.some((s) => !s.data && s.status === "loading")) return '<div class="meta">loading</div>';
  if (parts.every((s) => !s.data)) return `<div class="note">${esc(errText(S.tasks.err, "Notion"))}</div><div><button class="btn" data-act="refresh">try again</button></div>`;
  const t = todayStr();
  const items = R.comingUp(t, S.tasks.data, S.projects.data, S.bills.data);
  let h = items.length
    ? `<ul class="list">${items.map((i) => {
        const what = i.kind === "deadline" ? `<strong>${esc(i.title)} deadline.</strong> ${esc(i.detail)}`
          : i.kind === "bill" ? `<strong>${esc(i.title)}</strong> ${esc(money(i.amount))}${i.pastDue ? ", past its due date" : ""}`
          : `<strong>${esc(i.title)}</strong>`;
        return `<li><span class="meta">${esc(lbl(i.date) + " · " + rel(i.date, t))}</span><span>${what}</span></li>`;
      }).join("")}</ul>`
    : '<div class="soft">Nothing dated in the next two weeks.</div>';
  const steps = R.nextSteps(S.projects.data);
  if (steps.length) h += `<hr><div class="meta">gentle next steps</div><ul class="list">${steps.map((p) => `<li><span><strong>${esc(p.name)}:</strong> ${esc(p.next)}</span></li>`).join("")}</ul>`;
  const missing = (["tasks", "projects", "bills"] as const).filter((k) => !S[k].data && S[k].status === "error");
  if (missing.length) h += `<div class="note">Could not read ${esc(missing.join(" and "))} just now. Tap refresh to try again.</div>`;
  return h;
}

function bubble(): string {
  const msg = R.startWith(todayStr(), S.tasks.data, S.projects.data);
  return msg ? `<div class="bubble"><span class="meta">start with</span><p>${esc(msg)}</p></div>` : "";
}

function tasksView(): string {
  const d = S.draft, t = todayStr();
  const add = win("add_task.exe", "sky",
    `<form data-form="task"><label for="newTask">Task<input id="newTask" data-draft="task" autocomplete="off" value="${esc(d.task)}"></label>` +
    `<div class="fields"><label for="newBlock">Time block<select id="newBlock" data-draft="block"><option value="">none</option>` +
    BLOCKS.map((b) => `<option${d.block === b ? " selected" : ""}>${b}</option>`).join("") + "</select></label>" +
    `<label for="newDue">Due<input id="newDue" type="date" data-draft="due" value="${esc(d.due)}"></label></div>` +
    `<div><button class="btn" type="submit"${S.busy.add ? " disabled" : ""}>${S.busy.add ? "adding" : "add to Notion"}</button></div></form>`, true);
  if (!S.tasks.data) return add + win("tasks.txt", "butter", sect(S.tasks, () => ""), true);
  const open = S.tasks.data.filter((x) => R.isOpen(x) || S.prevStatus[x.id]);
  const b = R.buckets(open, t);
  const defs: Array<[R.BucketKey, string, string]> = [["overdue", "overdue.txt", "peach"], ["today", "today.txt", "butter"], ["week", "next_7_days.txt", "mint"], ["later", "later.txt", "lilac"], ["none", "no_date.txt", "sky"]];
  const out = defs.filter(([k]) => b[k].length).map(([k, name, color]) => win(name, color, b[k].map(todo).join(""), true)).join("");
  const note = S.tasks.status === "error" ? win("note.txt", "peach", `<div class="note">${esc(errText(S.tasks.err, "Notion"))} Showing the last copy.</div>`, true) : "";
  return add + note + (out || win("all_clear.txt", "mint", '<div class="soft">No open tasks.</div>', true));
}

// Bills are view only. There is deliberately no pay, mark-paid, or edit control here.
function billsView(): string {
  const t = todayStr();
  return win("bills.txt", "peach", sect(S.bills, (rows) => {
    const byDate = (a: Bill, b: Bill) => (a.due || "9999") < (b.due || "9999") ? -1 : (a.due || "9999") > (b.due || "9999") ? 1 : 0;
    const open = rows.filter((b) => !b.paid).sort(byDate), paid = rows.filter((b) => b.paid).sort(byDate);
    const row = (b: Bill) => {
      const when = b.due ? (b.due < t ? "past its due date" : "due " + rel(b.due, t)) : "no date";
      return `<li><div class="line"><span><b>${esc(b.name)}</b></span><span><b>${esc(money(b.amount))}</b></span></div><span class="meta">${esc([b.type, b.repeats, b.due ? lbl(b.due) : "", when].filter(Boolean).join(" · "))}</span></li>`;
    };
    return '<div class="meta">view only</div>' + (open.length ? `<ul class="list">${open.map(row).join("")}</ul>` : '<div class="soft">No unpaid bills listed.</div>') +
      (paid.length ? `<hr><details><summary>marked paid (${paid.length})</summary><ul class="list mt">${paid.map(row).join("")}</ul></details>` : "");
  }), true);
}

function projectsView(): string {
  if (!S.projects.data) return win("projects.txt", "butter", sect(S.projects, () => ""), true);
  const rows = S.projects.data, open = (S.tasks.data || []).filter(R.isOpen);
  const defs: Array<[string, string, string]> = [["Urgent", "urgent.txt", "peach"], ["Active", "active.txt", "butter"], ["Ongoing", "ongoing.txt", "mint"], ["Later", "later.txt", "lilac"]];
  const note = S.projects.status === "error" ? `<div class="note wide">${esc(errText(S.projects.err, "Notion"))} Showing the last copy.</div>` : "";
  return note + (defs.map(([status, name, color]) => {
    const ps = rows.filter((p) => p.status === status);
    if (!ps.length) return "";
    return win(name, color, ps.map((p) => {
      const n = open.filter((x) => x.projectIds.includes(p.id)).length;
      const tags = (p.focus ? '<span class="tag butter">focus</span>' : "") + (p.deadline ? `<span class="tag peach">${esc("deadline " + lbl(p.deadline))}</span>` : "") + (n ? `<span class="tag">${n} open</span>` : "");
      return `<div class="stack tight"><div class="row"><b><a class="plain" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${esc(p.name)}</a></b>${tags}</div>` +
        (p.next ? `<div><span class="meta">next step</span><br>${esc(p.next)}</div>` : '<div class="meta">no next step written</div>') + "</div>";
    }).join("<hr>"), true);
  }).join("") || win("projects.txt", "butter", '<div class="soft">No projects yet.</div>', true));
}

function sleepView(): string {
  const t = todayStr(), d = S.draft;
  if (!d.night) d.night = lbl(addDays(t, -1));
  const rows = S.sleep.data || [];
  const dup = R.hasNight(rows, d.night);
  const form = win("log_a_night.exe", "sky",
    '<form data-form="sleep"><div class="fields">' +
    `<label for="slNight">Night of<input id="slNight" data-draft="night" autocomplete="off" value="${esc(d.night)}"></label>` +
    `<label for="slBed">Bedtime<input id="slBed" data-draft="bed" autocomplete="off" placeholder="like 3:45 am" value="${esc(d.bed)}"></label>` +
    `<label for="slWake">Wake-up<input id="slWake" data-draft="wake" autocomplete="off" placeholder="like 9:45 am" value="${esc(d.wake)}"></label>` +
    `<label for="slHours">Hours slept<input id="slHours" data-draft="hours" inputmode="decimal" autocomplete="off" value="${esc(d.hours)}"></label></div>` +
    '<div class="meta">Hours fill in from bedtime and wake-up. You can change them.</div>' +
    (dup && S.confirmDup ? `<div class="note">There is already an entry for ${esc(d.night)}. The newest one counts. Tap again to save another.</div>` : "") +
    `<div><button class="btn" type="submit"${S.busy.sleep ? " disabled" : ""}>${S.busy.sleep ? "saving" : dup && S.confirmDup ? "save another entry" : "save to Notion"}</button></div></form>`);
  const last = win("last_night.log", "lilac", sect(S.sleep, (r) => nightSummary(R.lastNight(r, t), false)));
  const wk = win("this_week.txt", "mint", sect(S.sleep, (r) => {
    const latest = R.latestPerNight(r);
    const nights: string[] = []; for (let i = 1; i <= 7; i++) nights.push(lbl(addDays(t, -i)));
    return `<div class="soft">${R.nightsLogged(r, t)} of the last 7 nights logged.</div><ul class="list">` + nights.map((lab) => {
      const e = latest.find((x) => x.night.trim().toLowerCase() === lab.toLowerCase());
      return `<li><div class="line"><span><b>${esc(lab)}</b></span><span>${esc(!e ? "not logged" : e.hours == null ? "logged" : e.hours + " h")}</span></div>${e && e.hours != null ? blocksHtml(e.hours) : ""}</li>`;
    }).join("") + "</ul>";
  }), true);
  return last + form + wk;
}

function view(): string {
  const v = S.tab === "tasks" ? tasksView() : S.tab === "bills" ? billsView() : S.tab === "projects" ? projectsView() : S.tab === "sleep" ? sleepView() : todayView();
  return hello() + v + '<div class="foot">thank you for showing up today</div>';
}

function render() {
  const a = document.activeElement as HTMLInputElement | null;
  const id = a?.id, ss = a?.selectionStart, se = a?.selectionEnd;
  app.innerHTML = view();
  if (id) {
    const n = document.getElementById(id) as HTMLInputElement | null;
    if (n) { try { n.focus({ preventScroll: true }); if (ss != null && se != null && n.setSelectionRange) n.setSelectionRange(ss, se); } catch { /* not a text field */ } }
  }
}

function toast(msg: string, bad = false) {
  toastEl.textContent = msg;
  toastEl.className = "toast" + (bad ? " bad" : "");
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 4500);
}

/* ---------- actions ---------- */
// Each of these starts from a tap; nothing writes on load. With sample
// content they change only the screen. With live data they send one change
// to the server, never retry on their own, and then re-read from Notion.
const SAMPLE_NOTE = "Sample only. Nothing was saved to Notion.";
const find = (id: string) => (S.tasks.data || []).find((x) => x.id === id);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isLive = (s: Slot<unknown>) => s.source === "live";
function writeMsg(e: unknown): string {
  const m = errText(e, "Notion");
  return /Nothing was|Refresh to check/.test(m) ? m : m + " Nothing was changed.";
}

async function reloadTasks() {
  await pause(700); // give Notion a moment so the re-read includes the change
  await load(S.tasks, list<Task>("/api/tasks"));
  keepDone();
}
/** Tasks marked done here stay on screen (crossed out) so they can be undone. */
function keepDone() {
  if (!S.tasks.data) return;
  for (const [id, t] of Object.entries(S.doneKeep)) {
    if (!S.tasks.data.some((x) => x.id === id)) S.tasks.data.push({ ...t, status: "Done" });
  }
  render();
}

async function toggleDone(id: string) {
  const x = find(id); if (!x || S.busy[id]) return;
  const wasDone = x.status === "Done";
  const before = x.status;
  const next = wasDone ? S.prevStatus[id] || "Not started" : "Done";
  if (!isLive(S.tasks)) {
    if (wasDone) { delete S.prevStatus[id]; delete S.doneKeep[id]; } else { S.prevStatus[id] = before; }
    x.status = next; render(); toast(SAMPLE_NOTE); return;
  }
  S.busy[id] = true; x.status = next; render();
  try {
    await postJson("/api/tasks/" + encodeURIComponent(id) + "/status", { status: next });
    if (wasDone) { delete S.prevStatus[id]; delete S.doneKeep[id]; }
    else { S.prevStatus[id] = before; S.doneKeep[id] = { ...x }; }
    toast(wasDone ? "Moved back onto your list." : "Marked done in Notion.");
    S.busy[id] = false;
    await reloadTasks();
  } catch (e) {
    x.status = before; S.busy[id] = false; render(); toast(writeMsg(e), true);
  }
}

async function togglePin(id: string) {
  const x = find(id); if (!x || S.busy[id]) return;
  const next = !x.top3;
  if (!isLive(S.tasks)) { x.top3 = next; render(); toast(SAMPLE_NOTE); return; }
  S.busy[id] = true; x.top3 = next; render();
  try {
    await postJson("/api/tasks/" + encodeURIComponent(id) + "/top3", { top3: next });
    if (S.doneKeep[id]) S.doneKeep[id].top3 = next;
    toast(next ? "Added to your top 3." : "Removed from your top 3.");
    S.busy[id] = false;
    await reloadTasks();
  } catch (e) {
    x.top3 = !next; S.busy[id] = false; render(); toast(writeMsg(e), true);
  }
}

async function addTask() {
  const d = S.draft, title = d.task.trim();
  if (S.busy.add) return;
  if (!title) { toast("Type a task first.", true); return; }
  if (!S.tasks.data) { toast("Tasks are not loaded yet. Tap refresh, then try again.", true); return; }
  if (!isLive(S.tasks)) {
    S.tasks.data.push({ id: "local-" + Date.now(), url: "", title, status: "Not started", top3: false, block: d.block, area: "", due: d.due || null, projectIds: [] });
    d.task = ""; d.block = ""; d.due = ""; render(); toast(SAMPLE_NOTE); return;
  }
  S.busy.add = true; render();
  try {
    await postJson("/api/tasks", { title, block: d.block, due: d.due || null });
    d.task = ""; d.block = ""; d.due = "";
    S.busy.add = false; toast("Added to Notion.");
    await reloadTasks();
  } catch (e) {
    S.busy.add = false; render(); toast(writeMsg(e).replace("Nothing was changed.", "Nothing was added."), true);
  }
}

async function saveSleep() {
  const d = S.draft, night = d.night.trim(), hrs = parseFloat(d.hours);
  if (S.busy.sleep) return;
  if (!night || isNaN(hrs) || hrs < 0 || hrs > 24) { toast("Add the night and the hours slept (0 to 24).", true); return; }
  if (!S.sleep.data) { toast("Sleep is not loaded yet. Tap refresh, then try again.", true); return; }
  if (R.hasNight(S.sleep.data, night) && !S.confirmDup) { S.confirmDup = true; render(); return; }
  const entry = { night, bed: d.bed.trim(), wake: d.wake.trim(), hours: hrs };
  const clear = () => { d.night = ""; d.bed = ""; d.wake = ""; d.hours = ""; d.hoursTouched = false; S.confirmDup = false; };
  if (!isLive(S.sleep)) {
    S.sleep.data.push({ id: "local-" + Date.now(), ...entry, logged: new Date().toISOString() });
    clear(); render(); toast(SAMPLE_NOTE); return;
  }
  S.busy.sleep = true; render();
  try {
    await postJson("/api/sleep", entry);
    clear(); S.busy.sleep = false; toast("Sleep saved to Notion.");
    await pause(700);
    await load(S.sleep, list<SleepEntry>("/api/sleep"));
  } catch (e) {
    S.busy.sleep = false; render(); toast(writeMsg(e).replace("Nothing was changed.", "Nothing was saved."), true);
  }
}

/* ---------- events ---------- */
app.addEventListener("click", (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>("[data-act]"); if (!b) return;
  const a = b.dataset.act, id = b.dataset.id || "";
  if (a === "refresh") void refreshAll();
  else if (a === "toggle") void toggleDone(id);
  else if (a === "pin") void togglePin(id);
});
app.addEventListener("input", (e) => {
  const t = e.target as HTMLInputElement, k = t.dataset?.draft as keyof typeof S.draft | undefined;
  if (!k || k === "hoursTouched") return;
  S.draft[k] = t.value;
  if (k === "hours") S.draft.hoursTouched = true;
  if (k === "night") S.confirmDup = false;
  if ((k === "bed" || k === "wake") && !S.draft.hoursTouched) {
    const h = hoursBetween(S.draft.bed, S.draft.wake);
    const el = document.getElementById("slHours") as HTMLInputElement | null;
    if (h != null) { S.draft.hours = String(h); if (el) el.value = String(h); }
  }
});
app.addEventListener("change", (e) => {
  const t = e.target as HTMLSelectElement;
  if (t.tagName === "SELECT" && t.dataset.draft === "block") S.draft.block = t.value;
});
app.addEventListener("submit", (e) => {
  e.preventDefault();
  const f = (e.target as HTMLFormElement).dataset.form;
  if (f === "task") void addTask(); else if (f === "sleep") void saveSleep();
});

function route() {
  const h = location.hash.replace("#", "");
  S.tab = TABS.some(([k]) => k === h) ? h : "today";
  render();
}
window.addEventListener("hashchange", () => { route(); window.scrollTo(0, 0); });
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && S.updated && Date.now() - S.updated > 5 * 60e3) void refreshAll();
});

route();
void refreshAll();
