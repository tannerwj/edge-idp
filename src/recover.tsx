import { Hono } from "hono";
import type { Env } from "./config";
import { requestRecovery } from "./recovery";
import { getInstanceSettings } from "./settings-cache";
import { OpError } from "./ops-core";
import { AuthLayout, uiFor } from "./ui/layout";
import { DonePage, ErrorPage } from "./pages";
import { Icon } from "./ui/icons";
import { sha256Hex } from "./util";

export const recover = new Hono<{ Bindings: Env }>();

recover.get("/recover", async (c) => {
  const ui = await uiFor(c);
  if ((await getInstanceSettings(c.env.DB)).recoveryMode === "off")
    return c.html(
      <ErrorPage
        ui={ui}
        title="Ask your admin"
        message="Lost passkeys are handled by an admin here. Ask them for a new enrollment link."
      />,
      404,
    );
  return c.html(
    <AuthLayout ui={ui} title="Lost your passkey?">
      <div class="hero-icon">
        <Icon name="key" />
      </div>
      <h1>Lost your passkey?</h1>
      <p class="lede">
        Enter the email on your account. We'll send you a link to set up a new passkey, or ask an
        admin to.
      </p>
      <form method="post" action="/recover" class="stack-sm">
        <label class="field">
          <span class="label">Email</span>
          <input name="email" type="email" required autocomplete="email" maxLength={254} />
        </label>
        <button class="btn primary lg block" type="submit">
          Get help signing in
        </button>
      </form>
      <p class="muted small center">
        <a href="/login">Back to sign in</a>
      </p>
    </AuthLayout>,
  );
});

recover.post("/recover", async (c) => {
  const form = await c.req.parseBody();
  const ip = c.req.header("cf-connecting-ip");
  try {
    await requestRecovery(
      c.env,
      typeof form.email === "string" ? form.email : "",
      ip ? await sha256Hex(ip) : null,
    );
  } catch (e) {
    if (!(e instanceof OpError)) throw e;
    return c.html(
      <ErrorPage ui={await uiFor(c)} title="Ask your admin" message={e.message} />,
      404,
    );
  }
  return c.html(
    <DonePage
      ui={await uiFor(c)}
      title="We're on it"
      message="If that address belongs to an account here, you'll get an email with a link to set up a new passkey, or an admin will be asked to help you. Either way, there's nothing more to do on this page."
      href="/login"
    />,
  );
});
