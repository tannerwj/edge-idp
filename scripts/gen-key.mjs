/**
 * Generate the RS256 signing key for a fresh instance.
 * Prints the private JWK JSON; store it with:
 *
 *   wrangler secret put SIGNING_KEY_JWK
 *
 * (paste the printed JSON when prompted). Keep a backup offline — losing it
 * invalidates every issued token and forces re-registration of clients.
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
