/**
 * Generate the RS256 signing key for a fresh instance.
 * Prints the private JWK JSON. Save a copy offline (e.g. in 1Password), then
 * store it as the Worker secret:
 *
 *   node scripts/gen-key.mjs > key.json
 *   npx cf workers secrets update SIGNING_KEY_JWK --worker identity --type secret_text --text "$(cat key.json)"
 *   rm key.json
 *
 * Losing it invalidates every issued token (see DEPLOY.md for rotation).
 */
import { webcrypto } from "node:crypto";

const { privateKey } = await webcrypto.subtle.generateKey(
  {
    name: "RSASSA-PKCS1-v1_5",
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: "SHA-256",
  },
  true,
  ["sign", "verify"],
);

const jwk = await webcrypto.subtle.exportKey("jwk", privateKey);
jwk.kid = "sig-1";
jwk.alg = "RS256";
jwk.use = "sig";

process.stdout.write(JSON.stringify(jwk));
