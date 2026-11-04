import { test } from "node:test";
import assert from "node:assert/strict";
import { configFrom, resetCertCache, verifyAccess, type AccessConfig } from "../server/access.js";
import worker from "../server/worker.js";

const cfg: AccessConfig = { teamDomain: "ella.cloudflareaccess.com", aud: "aud-123", email: "me@example.com" };
const b64 = (b: ArrayBuffer | Uint8Array) => Buffer.from(b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");
const enc = (o: unknown) => b64(new TextEncoder().encode(JSON.stringify(o)));

async function keypair() {
  const k = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", k.publicKey);
  return { priv: k.privateKey, jwk: { kid: "k1", kty: "RSA", n: jwk.n!, e: jwk.e! } };
}
async function sign(priv: CryptoKey, payload: Record<string, unknown>, kid = "k1") {
  const h = enc({ alg: "RS256", kid, typ: "JWT" }), p = enc(payload);
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", priv, new TextEncoder().encode(h + "." + p));
  return h + "." + p + "." + b64(sig);
}
const now = Math.floor(Date.now() / 1000);
const good = { aud: ["aud-123"], iss: "https://ella.cloudflareaccess.com", email: "Me@Example.com", exp: now + 3600, nbf: now - 10 };

test("accepts only a real login for this app and this email", async () => {
  resetCertCache();
  const { priv, jwk } = await keypair();
  const other = await keypair();
  const certs = async (url: string) => { assert.equal(url, "https://ella.cloudflareaccess.com/cdn-cgi/access/certs"); return { keys: [jwk] }; };
  assert.equal(await verifyAccess(await sign(priv, good), cfg, certs), "me@example.com");
  assert.equal(await verifyAccess(await sign(priv, { ...good, email: "someone@else.com" }), cfg, certs), null);
  assert.equal(await verifyAccess(await sign(priv, { ...good, aud: ["other-app"] }), cfg, certs), null);
  assert.equal(await verifyAccess(await sign(priv, { ...good, iss: "https://evil.cloudflareaccess.com" }), cfg, certs), null);
  assert.equal(await verifyAccess(await sign(priv, { ...good, exp: now - 3600 }), cfg, certs), null);
  assert.equal(await verifyAccess(await sign(other.priv, good), cfg, certs), null, "signed by a different key");
  const t = await sign(priv, good); const [h, , s] = t.split(".");
  assert.equal(await verifyAccess(h + "." + enc({ ...good, email: "me@example.com", exp: now + 99999 }) + "." + s, cfg, certs), null, "edited after signing");
  assert.equal(await verifyAccess("", cfg, certs), null);
  assert.equal(await verifyAccess("not.a.jwt", cfg, certs), null);
  const none = enc({ alg: "none", kid: "k1" }) + "." + enc(good) + ".";
  assert.equal(await verifyAccess(none, cfg, certs), null, "alg none");
});

test("settings must be complete or the app stays locked", () => {
  assert.equal(configFrom({}), null);
  assert.equal(configFrom({ ACCESS_TEAM_DOMAIN: "ella.cloudflareaccess.com", ACCESS_AUD: "a" }), null);
  assert.equal(configFrom({ ACCESS_TEAM_DOMAIN: "evil.com", ACCESS_AUD: "a", ALLOWED_EMAIL: "me@example.com" }), null);
  assert.deepEqual(configFrom({ ACCESS_TEAM_DOMAIN: "https://Ella.cloudflareaccess.com/", ACCESS_AUD: " a ", ALLOWED_EMAIL: "Me@Example.com" }), { teamDomain: "ella.cloudflareaccess.com", aud: "a", email: "me@example.com" });
});

test("the Cloudflare version serves nothing without a valid login", async () => {
  let assetCalls = 0;
  const env = { ASSETS: { fetch: async () => { assetCalls++; return new Response("<html>page</html>", { headers: { "content-type": "text/html" } }); } } };
  for (const path of ["/", "/api/tasks", "/api/bills", "/assets/x.js"]) {
    const r = await worker.fetch(new Request("https://hw.example.workers.dev" + path), env, {});
    assert.equal(r.status, 403, path);
    assert.match(await r.text(), /locked/);
  }
  const env2 = { ...env, ACCESS_TEAM_DOMAIN: "ella.cloudflareaccess.com", ACCESS_AUD: "aud-123", ALLOWED_EMAIL: "me@example.com" };
  const r = await worker.fetch(new Request("https://hw.example.workers.dev/api/bills", { headers: { "Cf-Access-Jwt-Assertion": "forged.token.here" } }), env2, {});
  assert.equal(r.status, 403);
  assert.equal(assetCalls, 0);
});

test("with a valid login, the page and sample data come through", async () => {
  resetCertCache();
  const { priv, jwk } = await keypair();
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: string) => {
    if (String(u) === "https://ella.cloudflareaccess.com/cdn-cgi/access/certs") return new Response(JSON.stringify({ keys: [jwk] }));
    throw new Error("unexpected network call " + u);
  }) as typeof fetch;
  try {
    const env = { ASSETS: { fetch: async () => new Response("<html>page</html>", { headers: { "content-type": "text/html" } }) }, ACCESS_TEAM_DOMAIN: "ella.cloudflareaccess.com", ACCESS_AUD: "aud-123", ALLOWED_EMAIL: "me@example.com" };
    const headers = { "Cf-Access-Jwt-Assertion": await sign(priv, good) };
    const page = await worker.fetch(new Request("https://hw.example.workers.dev/", { headers }), env, {});
    assert.equal(page.status, 200);
    assert.equal(await page.text(), "<html>page</html>");
    assert.equal(page.headers.get("cache-control"), "no-store");
    const api = await worker.fetch(new Request("https://hw.example.workers.dev/api/bills?demo=fail", { headers }), env, {});
    assert.equal(api.status, 200, "demo modes are off on Cloudflare");
    assert.equal((await api.json()).source, "sample");
  } finally {
    globalThis.fetch = realFetch;
  }
});
