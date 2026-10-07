/** Generate the long-lived install secret for /setup and portable key encryption.
 * Save it in a password manager; do not put it in source control. */
import { randomBytes } from "node:crypto";

process.stdout.write(`${randomBytes(32).toString("base64url")}\n`);
