/**
 * Browser client for the passkey ceremonies. Loaded on the sign-in,
 * enrollment, and account pages (see src/pages.tsx). No frameworks —
 * just @simplewebauthn/browser and fetch.
 */
import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function status(elId: string, msg: string, isError = false): void {
  const el = $(elId);
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("error", isError);
}

function friendlyError(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === "NotAllowedError")
      return "That was cancelled — no problem. Try again when you're ready.";
    if (e.name === "InvalidStateError")
      return "This device already has a passkey here. Try signing in instead.";
    if (e.name === "SecurityError")
      return "Something looks off with this site's address. Please let the admin know.";
  }
  return "Something went wrong — please try again.";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

async function postJSON(
  url: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data: unknown = await res.json();
  if (!res.ok) {
    const msg =
      isRecord(data) && typeof data.error === "string"
        ? data.error
        : "request_failed";
    throw new Error(msg);
  }
  if (!isRecord(data)) throw new Error("bad_response");
  return data;
}

/** Fail fast if the server's options don't look like WebAuthn options. */
function isAuthOptions(
  v: unknown,
): v is PublicKeyCredentialRequestOptionsJSON {
  return (
    isRecord(v) &&
    typeof v.challenge === "string" &&
    typeof v.rpId === "string"
  );
}

function isRegOptions(
  v: unknown,
): v is PublicKeyCredentialCreationOptionsJSON {
  return (
    isRecord(v) &&
    typeof v.challenge === "string" &&
    isRecord(v.rp) &&
    typeof v.rp.name === "string" &&
    isRecord(v.user) &&
    typeof v.user.name === "string"
  );
}

/** One login attempt. Returns true when the session cookie is set. */
async function attemptLogin(
  email: string | undefined,
  autofill: boolean,
): Promise<boolean> {
  const raw = await postJSON("/webauthn/auth/options", email ? { email } : {});
  if (!isAuthOptions(raw)) throw new Error("bad_response");
  const resp = await startAuthentication({
    optionsJSON: raw,
    useBrowserAutofill: autofill,
  });
  // With autofill armed, the promise only resolves once the user picks a
  // credential; a false-y return means "still waiting", not failure.
  if (!resp) return false;
  const result = await postJSON("/webauthn/auth/verify", {
    response: resp,
    email,
  });
  return result.ok === true;
}

async function onPasskeyClick(next: string): Promise<void> {
  const emailEl = $("email");
  const email =
    emailEl instanceof HTMLInputElement ? emailEl.value.trim() : "";
  status("login-status", "Waiting for your device…");
  try {
    const ok = await attemptLogin(email || undefined, false);
    if (ok) {
      window.location.href = next;
    } else {
      status("login-status", "Sign-in didn't complete. Try again?", true);
    }
  } catch (e) {
    status("login-status", friendlyError(e), true);
  }
}

async function initLogin(): Promise<void> {
  const box = $("login-box");
  if (!box) return;
  const next = box.getAttribute("data-next") || "/account";

  if (!browserSupportsWebAuthn()) {
    status("login-status", "This browser doesn't support passkeys.", true);
    const btn = $("passkey-btn");
    if (btn instanceof HTMLButtonElement) btn.disabled = true;
    return;
  }

  // Conditional mediation: the browser offers the user's passkeys inline in
  // the email field. Starting a modal ceremony below replaces it — the
  // library aborts the pending conditional request for us.
  if (await browserSupportsWebAuthnAutofill()) {
    attemptLogin(undefined, true)
      .then((ok) => {
        if (ok) window.location.href = next;
        return;
      })
      .catch(() => {
        /* user will use the button instead */
      });
  }

  $("passkey-btn")?.addEventListener("click", () => {
    void onPasskeyClick(next);
  });
}

async function onEnrollClick(token: string): Promise<void> {
  status("enroll-status", "Waiting for your device…");
  try {
    const raw = await postJSON("/webauthn/register/options", {
      enrollmentToken: token,
    });
    if (!isRegOptions(raw)) throw new Error("bad_response");
    const resp = await startRegistration({ optionsJSON: raw });
    const result = await postJSON("/webauthn/register/verify", {
      response: resp,
      enrollmentToken: token,
    });
    if (result.ok === true) {
      status("enroll-status", "Passkey saved — you're signed in.");
      window.setTimeout(() => (window.location.href = "/account"), 800);
    }
  } catch (e) {
    status("enroll-status", friendlyError(e), true);
  }
}

async function initEnroll(): Promise<void> {
  const box = $("enroll-box");
  if (!box) return;
  const token = box.getAttribute("data-enrollment-token") ?? "";
  $("enroll-btn")?.addEventListener("click", () => {
    void onEnrollClick(token);
  });
}

async function onAddKeyClick(): Promise<void> {
  status("account-status", "Waiting for your device…");
  try {
    const raw = await postJSON("/webauthn/register/options", {});
    if (!isRegOptions(raw)) throw new Error("bad_response");
    const resp = await startRegistration({ optionsJSON: raw });
    const name =
      window.prompt(
        "Name this passkey (e.g. “iPhone”, “Windows laptop”):",
      ) ?? "";
    const result = await postJSON("/webauthn/register/verify", {
      response: resp,
      name,
    });
    if (result.ok === true) window.location.reload();
  } catch (e) {
    status("account-status", friendlyError(e), true);
  }
}

async function onRemoveKeyClick(btn: Element): Promise<void> {
  const id = btn.getAttribute("data-remove-key");
  if (!id) return;
  if (!window.confirm("Remove this passkey? You can always add it back."))
    return;
  const res = await fetch(
    `/account/keys/${encodeURIComponent(id)}/remove`,
    { method: "POST" },
  );
  if (res.ok) window.location.reload();
  else status("account-status", "Couldn't remove that key.", true);
}

async function initAccount(): Promise<void> {
  const box = $("account-box");
  if (!box) return;

  $("add-key-btn")?.addEventListener("click", () => {
    void onAddKeyClick();
  });

  document.querySelectorAll("[data-remove-key]").forEach((btn) => {
    btn.addEventListener("click", () => {
      void onRemoveKeyClick(btn);
    });
  });
}

// data-select: click-to-select for the "show once" secret/link fields.
document.querySelectorAll("[data-select]").forEach((el) => {
  el.addEventListener("click", () => {
    if (el instanceof HTMLInputElement) el.select();
  });
});

const page = document.body.getAttribute("data-page");
if (page === "login") void initLogin();
else if (page === "enroll") void initEnroll();
else if (page === "account") void initAccount();
