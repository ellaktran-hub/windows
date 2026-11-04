// Runs Home Window on Cloudflare Workers.
// Every request, including the page itself, must carry a valid Cloudflare
// Access login for the one allowed email. Otherwise it shows a locked page
// and no data.

import { createApp } from "./app.js";
import { configFrom, verifyAccess } from "./access.js";
import { NotionReader } from "./notion.js";

interface Env {
  ASSETS: { fetch: (req: Request) => Promise<Response> };
  NOTION_TOKEN?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  ALLOWED_EMAIL?: string;
}

const LOCKED = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Home Window</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;box-sizing:border-box;background:#c9c1f5;background-image:linear-gradient(180deg,#f7cfe0,#c9c1f5);color:#5a3326;font:15px/1.55 "Courier New",monospace}
.w{max-width:420px;background:#f6ecdc;border:2px solid #5a3326;border-radius:8px;box-shadow:6px 6px 0 #5a3326;overflow:hidden}.b{background:#f7b6cf;border-bottom:2px solid #5a3326;padding:6px 12px;font-weight:700;font-size:13px}.c{padding:18px 20px}</style></head>
<body><div class="w"><div class="b">locked.txt</div><div class="c">This page is locked. It opens after you sign in with Cloudflare Access.</div></div></body></html>`;

function locked(): Response {
  return new Response(LOCKED, {
    status: 403,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" },
  });
}

const app = createApp<Env>({
  notion: (c) => {
    const t = (c.env.NOTION_TOKEN || "").trim();
    return t ? new NotionReader(t) : null;
  },
  demo: false,
});

// Anything that isn't an /api route is the page and its files.
app.all("*", async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  const out = new Response(res.body, res);
  out.headers.set("Cache-Control", c.req.path === "/" || c.req.path.endsWith(".html") ? "no-store" : "private, max-age=3600");
  return out;
});

export default {
  async fetch(req: Request, env: Env, ctx: unknown): Promise<Response> {
    const cfg = configFrom(env as unknown as Record<string, unknown>);
    if (!cfg) return locked();
    const email = await verifyAccess(req.headers.get("Cf-Access-Jwt-Assertion"), cfg);
    if (!email) return locked();
    const res = await app.fetch(req, env, ctx as never);
    const out = new Response(res.body, res);
    out.headers.set("X-Robots-Tag", "noindex, nofollow");
    return out;
  },
};
