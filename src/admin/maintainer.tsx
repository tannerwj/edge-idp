import { Hono } from "hono";
import { page } from "./shell";
import type { AdminVars } from "./shell";
import { getSession } from "../session";
import { randomToken, sha256Hex } from "../util";

export const maintainerAdmin = new Hono<AdminVars>();
maintainerAdmin.get("/", async (c) => {
  if (!c.env.MAINTAINER_CONSOLE_URL) return c.notFound();
  return page(
    c,
    { active: "feedback", title: "Maintainer inbox" },
    <form action="/admin/maintainer/open" method="post">
      <h1>Maintainer inbox</h1>
      <p>Review shared reports and reply on the feedback app.</p>
      <button>Open maintainer inbox</button>
    </form>,
  );
});
maintainerAdmin.post("/open", async (c) => {
  const origin = c.env.MAINTAINER_CONSOLE_URL;
  const session = await getSession(c);
  if (!origin || !session) return c.notFound();
  const code = randomToken();
  await c.env.DB.prepare(
    "INSERT INTO maintainer_sessions(session_hash,token_hash,redeemed,expires_at) VALUES(?,?,0,unixepoch()+60) ON CONFLICT(session_hash) DO UPDATE SET token_hash=excluded.token_hash,redeemed=0,expires_at=excluded.expires_at",
  )
    .bind(session.idHash, await sha256Hex(code))
    .run();
  c.header("Referrer-Policy", "origin");
  return page(
    c,
    { active: "feedback", title: "Open feedback app" },
    <form data-maintainer-launch action={origin + "/admin/session"} method="post">
      <input type="hidden" name="code" value={code} />
      <button>Continue to feedback app</button>
    </form>,
  );
});
