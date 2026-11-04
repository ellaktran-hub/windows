// Talks only to this app's own server. No tokens live in the browser.

export class ApiFail extends Error {
  constructor(public code: string) {
    super(code);
  }
}

const TIMEOUT_MS = 20000;
const demo = new URLSearchParams(location.search).get("demo");

export async function getJson<T>(path: string): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const url = demo ? path + "?demo=" + encodeURIComponent(demo) : path;
  let res: Response;
  try {
    // redirect: "manual" so an expired login shows up as a redirect, not a network error.
    res = await fetch(url, { signal: ctl.signal, headers: { Accept: "application/json" }, cache: "no-store", redirect: "manual" });
  } catch (e) {
    throw new ApiFail(ctl.signal.aborted ? "timeout" : "offline");
  } finally {
    clearTimeout(timer);
  }
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) throw new ApiFail("signed_out");
  let body: unknown = null;
  try { body = await res.json(); } catch { /* handled below */ }
  if (!res.ok) {
    const code = (body as { error?: { code?: string } } | null)?.error?.code || (res.status === 403 ? "signed_out" : "server_error");
    throw new ApiFail(code);
  }
  if (body == null) throw new ApiFail("bad_shape");
  return body as T;
}

/** Calm, plain words for each kind of failure: what happened, then what to do. */
export function errText(e: unknown, server: string): string {
  const c = e instanceof ApiFail ? e.code : "unknown";
  if (c === "offline") return "Could not reach the app. Check your connection, then tap try again.";
  if (c === "timeout") return server + " is taking a long time. Tap try again in a moment.";
  if (c === "signed_out") return "Your sign-in ended. Reload the page to sign in again.";
  if (c === "not_connected") return server + " is not connected yet.";
  if (c === "unauthorized") return server + " did not accept the token. Check the Notion token in the .env file, restart the app, then tap try again.";
  if (c === "not_shared") return "A " + server + " database is not shared with the app yet. Share it with the integration (steps in the README), then tap try again.";
  if (c === "bad_request") return server + " did not accept the request. A property name may have changed in Notion.";
  if (c === "rate_limited") return server + " asked us to slow down. Try again in a minute.";
  if (c === "upstream_error" || c === "server_error") return server + " did not answer. Try again in a moment.";
  if (c === "bad_shape") return server + " sent back something unexpected. Try again in a moment.";
  return server + " could not finish that. Try again in a moment.";
}
