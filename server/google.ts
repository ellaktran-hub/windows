// Reads today's events from Google Calendar. Read only: the only scope ever
// requested is calendar.readonly, and there is no call that changes anything.
// Client secret and refresh token stay on the server.

import { addDays, fmtTime, TZ } from "../shared/dates.js";
import type { Appointment, Calendar } from "../shared/types.js";

export const SCOPE = "https://www.googleapis.com/auth/calendar.readonly";
export const WANT = ["Work", "No Work", "Appointments", "Personal", "School", "Reminders", "Harry + Ella"];
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const API = "https://www.googleapis.com/calendar/v3";
const TIMEOUT_MS = 15000;

export interface GoogleConfig { clientId: string; clientSecret: string; refreshToken: string }
type Fetch = typeof fetch;

export class GoogleFail extends Error {
  constructor(public code: string, public status = 0) { super(code); }
}

export function googleConfigFrom(env: Record<string, unknown>): { clientId: string; clientSecret: string; refreshToken: string } {
  const s = (k: string) => String(env[k] ?? "").trim();
  return { clientId: s("GOOGLE_CLIENT_ID"), clientSecret: s("GOOGLE_CLIENT_SECRET"), refreshToken: s("GOOGLE_REFRESH_TOKEN") };
}

async function timed(fetchImpl: Fetch, url: string, init: RequestInit = {}): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try { return await fetchImpl(url, { ...init, signal: ctl.signal }); }
  catch { throw new GoogleFail(ctl.signal.aborted ? "timeout" : "upstream_error"); }
  finally { clearTimeout(timer); }
}

/** The address of the Google consent page for the one-time connect step. */
export function authUrl(clientId: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: SCOPE,
    access_type: "offline", prompt: "consent", include_granted_scopes: "false", state,
  });
  return AUTH_URL + "?" + q.toString();
}

/** Trades the one-time code from Google for a long-lived refresh token. */
export async function exchangeCode(cfg: { clientId: string; clientSecret: string }, code: string, redirectUri: string, fetchImpl: Fetch = (i, n) => fetch(i, n)): Promise<string> {
  const res = await timed(fetchImpl, TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code, grant_type: "authorization_code", redirect_uri: redirectUri }).toString(),
  });
  const j = (await res.json().catch(() => ({}))) as { refresh_token?: string; scope?: string; error?: string };
  if (!res.ok || !j.refresh_token) throw new GoogleFail(j.error || "no_refresh_token", res.status);
  if (j.scope && j.scope.split(" ").some((s) => s !== SCOPE && s.includes("calendar") && !s.endsWith(".readonly"))) throw new GoogleFail("wrong_scope");
  return j.refresh_token;
}

let tokenCache: { key: string; token: string; until: number } | null = null;
export function resetGoogleCache() { tokenCache = null; }

async function accessToken(cfg: GoogleConfig, fetchImpl: Fetch): Promise<string> {
  const key = cfg.clientId + ":" + cfg.refreshToken.slice(-8);
  if (tokenCache && tokenCache.key === key && Date.now() < tokenCache.until) return tokenCache.token;
  const res = await timed(fetchImpl, TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, refresh_token: cfg.refreshToken, grant_type: "refresh_token" }).toString(),
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !j.access_token) {
    // invalid_grant: the approval was removed or ran out, so it needs connecting again.
    throw new GoogleFail(j.error === "invalid_grant" ? "google_reconnect" : res.status === 401 || res.status === 400 ? "google_reconnect" : "upstream_error", res.status);
  }
  tokenCache = { key, token: j.access_token, until: Date.now() + Math.max(60, (j.expires_in || 3600) - 120) * 1000 };
  return j.access_token;
}

async function getJson(url: string, token: string, fetchImpl: Fetch): Promise<any> {
  const res = await timed(fetchImpl, url, { headers: { Authorization: "Bearer " + token, Accept: "application/json" } });
  if (res.status === 401) throw new GoogleFail("google_reconnect", 401);
  if (res.status === 403 || res.status === 429) throw new GoogleFail("rate_limited", res.status);
  if (!res.ok) throw new GoogleFail("upstream_error", res.status);
  return res.json();
}

/** "2026-11-04" -> "2026-11-04T00:00:00-05:00", midnight in the planner's time zone. */
export function midnight(day: string): string {
  const probe = new Date(day + "T12:00:00Z");
  const name = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" }).formatToParts(probe).find((p) => p.type === "timeZoneName")?.value || "GMT";
  const m = name.match(/GMT([+-]\d{2}):?(\d{2})?/);
  const off = m ? `${m[1]}:${m[2] || "00"}` : "+00:00";
  return `${day}T00:00:00${off}`;
}

interface GEvent { status?: string; summary?: string; start?: { date?: string; dateTime?: string }; end?: { date?: string; dateTime?: string } }

/** Today's calendar, shaped for today.exe. One failing calendar does not stop the rest. */
export async function readToday(cfg: GoogleConfig, today: string, fetchImpl: Fetch = (i, n) => fetch(i, n)): Promise<Calendar> {
  const token = await accessToken(cfg, fetchImpl);
  const list = await getJson(`${API}/users/me/calendarList?minAccessRole=reader&maxResults=250`, token, fetchImpl);
  const items: Array<{ id: string; summary?: string; summaryOverride?: string }> = Array.isArray(list?.items) ? list.items : [];
  const cals = items
    .map((c) => ({ id: c.id, name: (c.summaryOverride || c.summary || "").trim() }))
    .filter((c) => WANT.includes(c.name));

  const timeMin = midnight(today), timeMax = midnight(addDays(today, 1));
  const results = await Promise.allSettled(cals.map(async (c) => {
    const q = new URLSearchParams({ timeMin, timeMax, singleEvents: "true", orderBy: "startTime", timeZone: TZ, maxResults: "50" });
    const r = await getJson(`${API}/calendars/${encodeURIComponent(c.id)}/events?${q}`, token, fetchImpl);
    return { cal: c.name, events: (Array.isArray(r?.items) ? r.items : []) as GEvent[] };
  }));

  const out = { connected: true as const, work: null as string | null, noWork: [] as string[], tags: [] as string[], appts: [] as Appointment[], failed: 0 };
  const starts: string[] = [], ends: string[] = [];
  for (const r of results) {
    if (r.status !== "fulfilled") { out.failed++; continue; }
    for (const ev of r.value.events) {
      if (!ev || ev.status === "cancelled" || !ev.summary || !ev.start) continue;
      const timed = !!ev.start.dateTime;
      if (!timed) {
        const s = ev.start.date || "", e = ev.end?.date || addDays(s, 1);
        if (!(s <= today && today < e)) continue;
      }
      if (r.value.cal === "Work") {
        if (timed) { starts.push(ev.start.dateTime!); ends.push(ev.end?.dateTime || ev.start.dateTime!); }
        else out.tags.push(ev.summary);
      } else if (r.value.cal === "No Work") {
        out.noWork.push(ev.summary);
      } else {
        out.appts.push({ sort: timed ? ev.start.dateTime! : "0", time: timed ? fmtTime(ev.start.dateTime!) : "all day", title: ev.summary });
      }
    }
  }
  if (starts.length) {
    starts.sort((a, b) => +new Date(a) - +new Date(b));
    ends.sort((a, b) => +new Date(b) - +new Date(a));
    out.work = fmtTime(starts[0]) + " – " + fmtTime(ends[0]);
  }
  out.appts.sort((a, b) => (a.sort < b.sort ? -1 : 1));
  // If every calendar failed, that's an error, not an empty day.
  if (cals.length && out.failed === cals.length) {
    const first = results.find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    throw first?.reason instanceof GoogleFail ? first.reason : new GoogleFail("upstream_error");
  }
  return out;
}
