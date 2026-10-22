import { Hono } from "hono";
import type { Env } from "./config";
import { getSession, hasRecentStepUp } from "./session";
import { confirmEmailChange, startEmailChange } from "./email-change";
import { OpError } from "./ops-core";
import { ErrorPage } from "./pages";
import { DonePage, TokenFormPage } from "./pages-flow";
import { setFlash, uiFor } from "./ui/layout";

export const accountEmail = new Hono<{ Bindings: Env }>();

accountEmail.post("/account/email", async (c) => {
  const s = await getSession(c);
  if (!s) return c.redirect("/login?next=%2Faccount", 303);
  if (!hasRecentStepUp(s))
    return c.redirect(`/login?reauth=1&next=${encodeURIComponent("/account#profile")}`, 303);
  const form = await c.req.parseBody();
  try {
    const email = await startEmailChange(
      c.env,
      s.user,
      typeof form.email === "string" ? form.email : "",
    );
    setFlash(c, `Check ${email} for a confirmation link. Your email changes once you open it.`);
  } catch (e) {
    if (!(e instanceof OpError)) throw e;
    setFlash(c, e.message, "bad");
  }
  return c.redirect("/account#profile", 303);
});

accountEmail.get("/account/email/confirm", async (c) =>
  c.html(
    <TokenFormPage
      ui={await uiFor(c)}
      title="Confirm your new email"
      lede="Apps you sign in to will see this address from now on."
      action="/account/email/confirm"
      button="Use this email"
    />,
    200,
    { "referrer-policy": "no-referrer" },
  ),
);

accountEmail.post("/account/email/confirm", async (c) => {
  const form = await c.req.parseBody();
  const ui = await uiFor(c);
  try {
    const user = await confirmEmailChange(c.env, typeof form.token === "string" ? form.token : "");
    return c.html(
      <DonePage
        ui={ui}
        title="Email updated"
        message={`Your email is now ${user.email}. Apps pick it up the next time you sign in to them.`}
        href="/account"
      />,
    );
  } catch (e) {
    if (!(e instanceof OpError)) throw e;
    return c.html(
      <ErrorPage ui={ui} title="Couldn't change your email" message={e.message} />,
      400,
    );
  }
});
