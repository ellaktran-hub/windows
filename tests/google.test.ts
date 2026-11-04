import { test } from "node:test";
import assert from "node:assert/strict";
import { authUrl, exchangeCode, GoogleFail, midnight, readToday, resetGoogleCache, SCOPE } from "../server/google.js";
import { createApp } from "../server/app.js";

const T = "2026-11-04";
const cfg = { clientId: "cid", clientSecret: "csecret", refreshToken: "rtoken-123456789" };

function fakeGoogle(opts: { failCal?: string[]; tokenError?: string; events: Record<string, unknown[]> }, seen: string[] = []) {
  return (async (url: string, init: any = {}) => {
    seen.push(String(url));
    const j = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status });
    if (String(url).startsWith("https://oauth2.googleapis.com/token")) {
      if (opts.tokenError) return j({ error: opts.tokenError }, 400);
      assert.match(String(init.body), /grant_type=refresh_token/);
      return j({ access_token: "at", expires_in: 3600 });
    }
    assert.equal(init.headers.Authorization, "Bearer at");
    if (String(url).includes("/users/me/calendarList")) {
      return j({ items: [
        { id: "work@x", summary: "Work" }, { id: "nowork@x", summary: "No Work" }, { id: "appt@x", summary: "Appointments" },
        { id: "he@x", summary: "Shared", summaryOverride: "Harry + Ella" }, { id: "other@x", summary: "Holidays" },
      ] });
    }
    const id = decodeURIComponent(String(url).split("/calendars/")[1].split("/events")[0]);
    assert.ok(id !== "other@x", "calendars not on the list are never read");
    if (opts.failCal?.includes(id)) return j({}, 500);
    const u = new URL(String(url));
    assert.equal(u.searchParams.get("timeMin"), "2026-11-04T00:00:00-05:00");
    assert.equal(u.searchParams.get("timeMax"), "2026-11-05T00:00:00-05:00");
    return j({ items: opts.events[id] || [] });
  }) as typeof fetch;
}

test("midnight uses the New York offset, including daylight time", () => {
  assert.equal(midnight("2026-11-04"), "2026-11-04T00:00:00-05:00");
  assert.equal(midnight("2026-07-04"), "2026-07-04T00:00:00-04:00");
});

test("work hours, payday tag, appointments, and a shared calendar", async () => {
  resetGoogleCache();
  const cal = await readToday(cfg, T, fakeGoogle({ events: {
    "work@x": [
      { summary: "Shift", start: { dateTime: "2026-11-04T13:00:00-05:00" }, end: { dateTime: "2026-11-04T17:00:00-05:00" } },
      { summary: "Shift", start: { dateTime: "2026-11-04T09:00:00-05:00" }, end: { dateTime: "2026-11-04T12:30:00-05:00" } },
      { summary: "payday", start: { date: "2026-11-04" }, end: { date: "2026-11-05" } },
      { summary: "Old", status: "cancelled", start: { dateTime: "2026-11-04T06:00:00-05:00" } },
    ],
    "appt@x": [{ summary: "Allergist", start: { dateTime: "2026-11-04T15:30:00-05:00" }, end: { dateTime: "2026-11-04T16:00:00-05:00" } }],
    "he@x": [{ summary: "Dinner", start: { date: "2026-11-03" }, end: { date: "2026-11-06" } }],
  } }));
  assert.ok(cal.connected);
  if (!cal.connected) return;
  assert.equal(cal.work, "9:00 am – 5:00 pm");
  assert.deepEqual(cal.tags, ["payday"]);
  assert.deepEqual(cal.noWork, []);
  assert.deepEqual(cal.appts.map((a) => a.time + " " + a.title), ["all day Dinner", "3:30 pm Allergist"]);
  assert.equal(cal.failed, 0);
});

test("a day off, and one calendar failing still shows the rest", async () => {
  resetGoogleCache();
  const cal = await readToday(cfg, T, fakeGoogle({ failCal: ["appt@x"], events: { "nowork@x": [{ summary: "Day off", start: { date: T }, end: { date: "2026-11-05" } }] } }));
  if (!cal.connected) throw new Error("expected connected");
  assert.equal(cal.work, null);
  assert.deepEqual(cal.noWork, ["Day off"]);
  assert.equal(cal.failed, 1);
});

test("every calendar failing is an error, not an empty day", async () => {
  resetGoogleCache();
  await assert.rejects(readToday(cfg, T, fakeGoogle({ failCal: ["work@x", "nowork@x", "appt@x", "he@x"], events: {} })), (e: unknown) => e instanceof GoogleFail);
});

test("a removed approval asks to connect again", async () => {
  resetGoogleCache();
  await assert.rejects(readToday(cfg, T, fakeGoogle({ tokenError: "invalid_grant", events: {} })), (e: unknown) => e instanceof GoogleFail && e.code === "google_reconnect");
});

test("connect asks only for read-only calendar access", () => {
  const u = new URL(authUrl("cid", "https://hw.test/api/google/callback", "st"));
  assert.equal(u.searchParams.get("scope"), "https://www.googleapis.com/auth/calendar.readonly");
  assert.equal(SCOPE.endsWith(".readonly"), true);
  assert.equal(u.searchParams.get("access_type"), "offline");
  assert.equal(u.searchParams.get("state"), "st");
});

test("code exchange needs a refresh token back", async () => {
  const ok = (async () => new Response(JSON.stringify({ refresh_token: "rt", scope: SCOPE }))) as typeof fetch;
  assert.equal(await exchangeCode(cfg, "code", "https://hw.test/cb", ok), "rt");
  const none = (async () => new Response(JSON.stringify({ access_token: "a" }))) as typeof fetch;
  await assert.rejects(exchangeCode(cfg, "code", "https://hw.test/cb", none));
});

test("connect and callback routes", async () => {
  const app = createApp({ notion: () => null, demo: false, google: () => ({ clientId: "cid", clientSecret: "cs", refreshToken: "" }) });
  const r = await app.request("https://hw.test/api/google/connect");
  assert.equal(r.status, 302);
  const loc = new URL(r.headers.get("location")!);
  assert.equal(loc.origin, "https://accounts.google.com");
  assert.equal(loc.searchParams.get("redirect_uri"), "https://hw.test/api/google/callback");
  const cookie = r.headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/);
  const bad = await app.request("https://hw.test/api/google/callback?code=x&state=wrong", { headers: { cookie: cookie.split(";")[0] } });
  assert.equal(bad.status, 400);
  const cal = await app.request("https://hw.test/api/calendar");
  assert.deepEqual((await cal.json()).calendar, { connected: false, canConnect: true });
  const none = createApp({ notion: () => null, demo: false, google: () => ({ clientId: "", clientSecret: "", refreshToken: "" }) });
  assert.deepEqual((await (await none.request("https://hw.test/api/calendar")).json()).calendar, { connected: false });
});
