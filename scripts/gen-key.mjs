import { randomBytes, webcrypto } from "node:crypto";

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
jwk.kid = `sig-${randomBytes(8).toString("hex")}`;
jwk.alg = "RS256";
jwk.use = "sig";

process.stdout.write(JSON.stringify(jwk));
