import { readdirSync, readFileSync } from "node:fs";

const DESTRUCTIVE = /\b(DROP\s+(TABLE|COLUMN|INDEX|VIEW|TRIGGER)|RENAME\s+(TO|COLUMN))\b/i;
const bad = readdirSync("migrations")
  .filter((f) => f.endsWith(".sql"))
  .filter((f) => DESTRUCTIVE.test(readFileSync(`migrations/${f}`, "utf8").replace(/--.*$/gm, "")));
if (bad.length) {
  console.error(
    `Migrations must be additive so the previous Worker keeps running (DEPLOY.md › Upgrading and rollback): ${bad.join(", ")}`,
  );
  process.exit(1);
}
console.log("migrations: additive");
