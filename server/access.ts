// Checks the Cloudflare Access login on every request to the Cloudflare
// version. Cloudflare Access does the email login in front of the app; this
// is a second lock inside the app, so a missed setting can't open it.
//
// It fails closed: if the login settings are missing, or the login token is
// missing, expired, for another app, or for another email, nothing is served.

export interface AccessConfig {
  teamDomain: string; // like "yourname.cloudflareaccess.com"
  aud: string; // the Access application's "Application Audience (AUD) Tag"
  email: string; // the only email allowed in
}

interface Jwk { kid: string; kty: string; n: string; e: string; alg?: string }
type CertFetch = (url: string) => Promise<{ keys: Jwk[] }>;

const b64urlBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, (ch) => ch.charCodeAt(0));
};
const b64urlJson = (s: string): any => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

export function cleanTeamDomain(s: string): string {
  return String(s || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

export function configFrom(env: Record<string, unknown>): AccessConfig | null {
  const teamDomain = cleanTeamDomain(String(env.ACCESS_TEAM_DOMAIN || ""));
  const aud = String(env.ACCESS_AUD || "").trim();
  const email = String(env.ALLOWED_EMAIL || "").trim().toLowerCase();
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(teamDomain) || !aud || !email.includes("@")) return null;
  return { teamDomain, aud, email };
}

let certCache: { url: string; at: number; keys: Jwk[] } | null = null;
const defaultCerts: CertFetch = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error("certs " + r.status);
  return (await r.json()) as { keys: Jwk[] };
};

async function keysFor(cfg: AccessConfig, getCerts: CertFetch, kid: string): Promise<Jwk | undefined> {
  const url = `https://${cfg.teamDomain}/cdn-cgi/access/certs`;
  const fresh = certCache && certCache.url === url && Date.now() - certCache.at < 60 * 60e3;
  if (!fresh || !certCache!.keys.some((k) => k.kid === kid)) {
    const r = await getCerts(url);
    certCache = { url, at: Date.now(), keys: Array.isArray(r.keys) ? r.keys : [] };
  }
  return certCache!.keys.find((k) => k.kid === kid);
}

export function resetCertCache() { certCache = null; }

/** Returns the signed-in email if the login token is valid for this app, otherwise null. */
export async function verifyAccess(token: string | null | undefined, cfg: AccessConfig, getCerts: CertFetch = defaultCerts, now = Date.now()): Promise<string | null> {
  try {
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const header = b64urlJson(parts[0]);
    const payload = b64urlJson(parts[1]);
    if (header.alg !== "RS256" || !header.kid) return null;

    const jwk = await keysFor(cfg, getCerts, header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
    if (!ok) return null;

    const sec = Math.floor(now / 1000);
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(cfg.aud)) return null;
    if (payload.iss !== `https://${cfg.teamDomain}`) return null;
    if (typeof payload.exp !== "number" || payload.exp < sec - 30) return null;
    if (typeof payload.nbf === "number" && payload.nbf > sec + 30) return null;
    const email = String(payload.email || "").toLowerCase();
    if (email !== cfg.email) return null;
    return email;
  } catch {
    return null;
  }
}
