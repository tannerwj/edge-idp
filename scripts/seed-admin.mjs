/**
 * Create the first admin user and print their enrollment link.
 *
 * Usage: node scripts/seed-admin.mjs --email=you@example.com --name="Your Name"
 *
 * Runs `wrangler d1 execute` against the database in wrangler.toml, so run it
 * after `wrangler d1 create` + migrations. Requires no app code — it only
 * needs the ISSUER var from wrangler.toml for the printed link.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)=(.*)$/);
    return m ? [m[1], m[2]] : [a.replace(/^--/, ""), true];
  }),
);
const email = String(args.email ?? "").trim();
const name = String(args.name ?? "").trim();
if (!email || !name || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error('Usage: node scripts/seed-admin.mjs --email=you@example.com --name="Your Name"');
  process.exit(1);
}

const toml = readFileSync("wrangler.toml", "utf8");
const issuer = (toml.match(/ISSUER\s*=\s*"([^"]+)"/) ?? [])[1] ?? "";
if (!issuer || issuer.includes("REPLACE")) {
  console.error("Set ISSUER in wrangler.toml first (see DEPLOY.md).");
  process.exit(1);
}

const now = Math.floor(Date.now() / 1000);
const userId = randomUUID();
const token = randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
const tokenHash = createHash("sha256").update(token).digest("hex");
const q = (s) => `'${s.replace(/'/g, "''")}'`;

const sql = [
  `INSERT INTO users (id, created_at, name, email, is_admin, updated_at) VALUES (${q(userId)}, ${now}, ${q(name)}, ${q(email)}, 1, ${now});`,
  `INSERT INTO enrollment_tokens (token_hash, user_id, created_at, expires_at) VALUES (${q(tokenHash)}, ${q(userId)}, ${now}, ${now + 7 * 86400});`,
].join("\n");

execFileSync("npx", ["wrangler", "d1", "execute", "identity", "--remote", "--command", sql], {
  stdio: "inherit",
});

console.log(`\nAdmin user created: ${name} <${email}>`);
console.log(`Enrollment link (valid 7 days, one-time):\n${issuer}/enroll/${token}\n`);
