// Quick guard for the app's hard rules. Fails if the code gains a way to
// delete, archive, or pay anything, or if a secret ends up in the built page.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";

function files(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

const problems = [];
const code = ["src", "server", "shared"].flatMap(files).filter((f) => /\.(ts|js|html)$/.test(f));
const banned = [
  [/\barchived\s*:/i, "archives a Notion page"],
  [/\bin_trash"?\s*:/i, "moves a Notion page to trash"],
  [/method\s*:\s*["']DELETE["']/i, "sends a DELETE request"],
  [/app\.delete\(/, "adds a delete route"],
  [/["']?Paid["']?\s*:\s*(true|false|"__YES__")/, "writes the Paid checkbox"],
  [/\b(pay now|mark paid|add a card|payment plan)\b/i, "offers a payment action"],
];
for (const f of code) {
  const text = readFileSync(f, "utf8");
  for (const [re, why] of banned) if (re.test(text)) problems.push(`${f}: ${why}`);
}

const secretish = [/ntn_[A-Za-z0-9]{20,}/, /secret_[A-Za-z0-9]{20,}/, /ghp_[A-Za-z0-9]{20,}/, /GOCSPX-[A-Za-z0-9_-]{10,}/, /ya29\.[A-Za-z0-9_-]{20,}/];
for (const f of files("dist")) {
  const text = readFileSync(f, "utf8");
  for (const re of secretish) if (re.test(text)) problems.push(`${f}: looks like a secret in the built page`);
  if (/NOTION_TOKEN|GOOGLE_CLIENT_SECRET/.test(text)) problems.push(`${f}: mentions a secret setting`);
}

// Secrets belong in the Cloudflare dashboard, never in the settings file.
if (existsSync("wrangler.jsonc") && /NOTION_TOKEN"?\s*:|ntn_/.test(readFileSync("wrangler.jsonc", "utf8"))) problems.push("wrangler.jsonc: holds the Notion token");
if (existsSync("wrangler.jsonc") && !/"run_worker_first"\s*:\s*true/.test(readFileSync("wrangler.jsonc", "utf8"))) problems.push("wrangler.jsonc: the login check must run before the page is served");

if (problems.length) { console.error("Safety check found problems:\n" + problems.join("\n")); process.exit(1); }
console.log(`Safety check passed (${code.length} source files, ${files("dist").length} built files).`);
