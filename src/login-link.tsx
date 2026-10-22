import { Hono } from "hono";
import type { Env } from "./config";
import { audit } from "./db";
import { magicLinksOpen, peekMagicLink, redeemMagicLink, sendMagicLink } from "./magic-link";
import { createSession, destroySession, setSessionCookie } from "./session";
import { ErrorPage } from "./pages";
import { DonePage, TokenFormPage } from "./pages-flow";
import { AuthLayout, uiFor } from "./ui/layout";
import { Icon } from "./ui/icons";
import { safeNext, sha256Hex } from "./util";

export const loginLink = new Hono<{ Bindings: Env }>();

const str = (v: unknown) => (typeof v === "string" ? v : "");

async function ipHash(ip: string | undefined): Promise<string | null> {
  return ip ? sha256Hex(ip) : null;
}

loginLink.post("/login/email", async (c) => {
  if (!(await magicLinksOpen(c.env))) return c.notFound();
  const form = await c.req.parseBody();
  await sendMagicLink(
    c.env,
    str(form.email),
    safeNext(str(form.next)),
    await ipHash(c.req.header("cf-connecting-ip")),
  );
  return c.html(
    <DonePage
      ui={await uiFor(c)}
      title="Check your email"
      message="If that address belongs to a member here, a sign-in link is on its way. It works once, for 10 minutes. You can close this tab."
      href="/login"
    />,
  );
});

loginLink.get("/login/link", async (c) =>
  c.html(
    <TokenFormPage
      ui={await uiFor(c)}
      title="Sign in"
      lede="Continue to see which account this link signs in to."
      action="/login/link"
      button="Continue"
      icon="logIn"
    />,
    200,
    { "referrer-policy": "no-referrer" },
  ),
);

loginLink.post("/login/link", async (c) => {
  const form = await c.req.parseBody();
  const token = str(form.token);
  const ui = await uiFor(c);
  const expired = () =>
    c.html(
      <ErrorPage
        ui={ui}
        title="This link has expired"
        message="Sign-in links work once, for 10 minutes. Ask for a new one on the sign-in page."
      />,
      400,
    );
  if (str(form.confirm) !== "1") {
    const found = await peekMagicLink(c.env, token);
    if (!found) return expired();
    return c.html(
      <AuthLayout ui={ui} title="Sign in">
        <div class="hero-icon">
          <Icon name="logIn" />
        </div>
        <h1>Sign in as {found.user.name}?</h1>
        <p class="lede">
          This link signs <b>{found.user.email}</b> in on this device. If that isn't you, close this
          tab.
        </p>
        <form method="post" action="/login/link" class="stack-sm">
          <input type="hidden" name="token" value={token} />
          <input type="hidden" name="confirm" value="1" />
          <button class="btn primary lg block" type="submit">
            Sign in on this device
          </button>
        </form>
      </AuthLayout>,
      200,
      { "referrer-policy": "no-referrer" },
    );
  }
  const found = await redeemMagicLink(c.env, token);
  if (!found) return expired();
  const ip = c.req.header("cf-connecting-ip") ?? null;
  await destroySession(c);
  const raw = await createSession(c.env.DB, found.user.id, {
    userAgent: c.req.header("user-agent") ?? null,
    ip,
    method: "email",
  });
  setSessionCookie(c, raw);
  await audit(c.env.DB, "MAGIC_LINK_SIGN_IN", {
    userId: found.user.id,
    ipHash: await ipHash(ip ?? undefined),
    userAgent: c.req.header("user-agent"),
  });
  return c.redirect(safeNext(found.next), 303);
});
