import { Hono } from "hono";
import { generateAuthenticationOptions } from "@simplewebauthn/server";
import type { Env } from "./config";
import { getCredentialsForUser } from "./db";
import { getSession } from "./session";
import { base64url, rpIdFromIssuer } from "./util";
import { storeChallenge } from "./webauthn-challenges";

export const passkeyCheck = new Hono<{ Bindings: Env }>();
passkeyCheck.post("/check/options", async (c) => {
  const session = await getSession(c);
  if (!session) return c.json({ error: "unauthorized" }, 401);
  const body = await c.req.json<{ key?: string }>();
  const credentials = await getCredentialsForUser(c.env.DB, session.user.id);
  const selected = credentials.find((k) => k.id === body.key);
  if (!selected) return c.json({ error: "unknown_passkey" }, 404);
  const options = await generateAuthenticationOptions({
    rpID: rpIdFromIssuer(c.env.ISSUER),
    userVerification: "required",
    allowCredentials: [{ id: base64url(selected.credential_id), transports: selected.transports }],
  });
  await storeChallenge(c.env.DB, options.challenge, {
    type: "authentication",
    userId: session.user.id,
    data: { uv: "required", checkKey: selected.id, session: session.idHash },
  });
  return c.json(options);
});
