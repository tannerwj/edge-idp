/** Passkey ceremonies: sign-in (button + autofill), enrollment, add-a-key. */
import {
  startRegistration,
  startAuthentication,
  browserSupportsWebAuthn,
  browserSupportsWebAuthnAutofill,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";

import { $, $$ } from "./dom";

/* ───────────────────────────── passkeys ───────────────────────────── */

function status(elId: string, msg: string, kind: "" | "error" | "ok" = ""): void {
  const el = $(elId);
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("error", kind === "error");
  el.classList.toggle("ok", kind === "ok");
}

function friendlyError(e: unknown): string {
  if (e instanceof Error) {
    if (e.name === "NotAllowedError") return "Cancelled — no problem. Try again when you're ready.";
    if (e.name === "InvalidStateError") return "This device already has a passkey here. Try signing in instead.";
    if (e.name === "SecurityError") return "This site's address doesn't match its passkey domain. Tell your admin.";
    if (e.message === "auth_failed") return "That passkey isn't recognized here. Was it removed?";
    if (e.message === "invalid_enrollment_token") return "This enrollment link was already used or has expired.";
    if (e.message === "rate_limited") return "Too many attempts — wait a minute and try again.";
  }
  return "Something went wrong — please try again.";
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

async function postJSON(url: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    credentials: "same-origin",
  });
  const data: unknown = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(isRecord(data) && typeof data.error === "string" ? data.error : "request_failed");
  if (!isRecord(data)) throw new Error("bad_response");
  return data;
}

const isAuthOptions = (v: unknown): v is PublicKeyCredentialRequestOptionsJSON =>
  isRecord(v) && typeof v.challenge === "string" && typeof v.rpId === "string";
const isRegOptions = (v: unknown): v is PublicKeyCredentialCreationOptionsJSON =>
  isRecord(v) && typeof v.challenge === "string" && isRecord(v.rp) && isRecord(v.user);

/** One login attempt. Returns true when the session cookie is set. */
async function attemptLogin(email: string | undefined, autofill: boolean): Promise<boolean> {
  const raw = await postJSON("/webauthn/auth/options", email ? { email } : {});
  if (!isAuthOptions(raw)) throw new Error("bad_response");
  const resp = await startAuthentication({ optionsJSON: raw, useBrowserAutofill: autofill });
  if (!resp) return false;
  const result = await postJSON("/webauthn/auth/verify", { response: resp, email });
  return result.ok === true;
}

function setBusy(btn: Element | null, busy: boolean): void {
  if (btn instanceof HTMLButtonElement) {
    btn.disabled = busy;
    btn.classList.toggle("busy", busy);
  }
}

export async function initLogin(): Promise<void> {
  const box = $("login-box");
  if (!box) return;
  const next = box.getAttribute("data-next") || "/";
  const btn = $("passkey-btn");
  if (!browserSupportsWebAuthn()) {
    status("login-status", "This browser doesn't support passkeys. Try Safari, Chrome, Edge or Firefox.", "error");
    setBusy(btn, true);
    return;
  }
  const finish = () => {
    status("login-status", "Signed in — one moment…", "ok");
    window.location.href = next;
  };
  // Conditional mediation: passkeys offered inline in the email field.
  if (await browserSupportsWebAuthnAutofill()) {
    attemptLogin(undefined, true)
      .then((ok) => {
        if (ok) finish();
        return ok;
      })
      .catch(() => false);
  }
  btn?.addEventListener("click", () => void onLoginClick(btn, finish));
}

async function onLoginClick(btn: HTMLElement, finish: () => void): Promise<void> {
  const emailEl = $("email");
  const email = emailEl instanceof HTMLInputElement ? emailEl.value.trim() : "";
  status("login-status", "Waiting for your device…");
  setBusy(btn, true);
  try {
    if (await attemptLogin(email || undefined, false)) finish();
    else status("login-status", "Sign-in didn't complete. Try again?", "error");
  } catch (e) {
    status("login-status", friendlyError(e), "error");
  } finally {
    setBusy(btn, false);
  }
}

async function register(body: Record<string, unknown>, name: string): Promise<boolean> {
  const raw = await postJSON("/webauthn/register/options", body);
  if (!isRegOptions(raw)) throw new Error("bad_response");
  const resp = await startRegistration({ optionsJSON: raw });
  const result = await postJSON("/webauthn/register/verify", { ...body, response: resp, name });
  return result.ok === true;
}

export function initEnroll(): void {
  const box = $("enroll-box");
  if (!box) return;
  const token = box.getAttribute("data-enrollment-token") ?? "";
  const btn = $("enroll-btn");
  btn?.addEventListener("click", () => void onEnrollClick(btn, token));
}

async function onEnrollClick(btn: HTMLElement, token: string): Promise<void> {
  const nameEl = $("key-name");
  const name = nameEl instanceof HTMLInputElement ? nameEl.value.trim() : "";
  status("enroll-status", "Follow the prompt on your device…");
  setBusy(btn, true);
  try {
    if (await register({ enrollmentToken: token }, name)) {
      status("enroll-status", "Passkey saved — you're in.", "ok");
      $$(".steps span").forEach((s) => s.classList.add("on"));
      setTimeout(() => (window.location.href = "/?ok=key_added"), 700);
    }
  } catch (e) {
    status("enroll-status", friendlyError(e), "error");
    setBusy(btn, false);
  }
}

export function initAccount(): void {
  const btn = $("add-key-btn");
  btn?.addEventListener("click", () => void onAddKeyClick(btn));
}

async function onAddKeyClick(btn: HTMLElement): Promise<void> {
  status("account-status", "Follow the prompt on your device…");
  setBusy(btn, true);
  try {
    if (await register({}, "")) window.location.href = "/account?ok=key_added#passkeys";
  } catch (e) {
    if (e instanceof Error && e.message === "reauth_required") {
      window.location.href = `/login?reauth=1&next=${encodeURIComponent("/account#passkeys")}`;
      return;
    }
    status("account-status", friendlyError(e), "error");
  } finally {
    setBusy(btn, false);
  }
}

