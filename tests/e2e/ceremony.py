#!/usr/bin/env python3
"""
Passkey ceremony end-to-end test against the deployed instance.

Seeds a throwaway test user + enrollment token in the (production) D1,
drives a real Chromium with a CDP virtual authenticator through:
  1. enrollment (/enroll/<token>) -> passkey created -> /account
  2. sign out
  3. explicit button sign-in (/login, no auto-presence) -> /account
  4. sign out
  5. conditional mediation auto sign-in (/login, auto-presence) -> /account
then deletes the test user (cascades credentials/sessions/tokens).

Usage: IDENTITY_URL=https://auth.johnson.network python3 tests/e2e/ceremony.py
Requires: forward proxy on 127.0.0.1:18080 (see ~/workspace/e2e-infra/).
"""
import hashlib
import os
import secrets
import subprocess
import sys
import time
import uuid

from playwright.sync_api import sync_playwright

BASE = os.environ.get("IDENTITY_URL", "https://auth.johnson.network").rstrip("/")
EMAIL = f"e2e-{uuid.uuid4().hex[:8]}@example.test"
USER_ID = str(uuid.uuid4())
TOKEN = secrets.token_hex(32)
TOKEN_HASH = hashlib.sha256(TOKEN.encode()).hexdigest()
NOW = int(time.time())

failures = []


def check(name, cond):
    print(("  ok   " if cond else "  FAIL ") + name)
    if not cond:
        failures.append(name)


def wrangler(*args):
    subprocess.run(["npx", "wrangler", *args], check=True, capture_output=True,
                   cwd=os.path.expanduser("~/workspace/identity"))


def add_authenticator(cdp_session, auto_presence):
    cdp_session.send("WebAuthn.enable")
    r = cdp_session.send("WebAuthn.addVirtualAuthenticator", {"options": {
        "protocol": "ctap2",
        "transport": "internal",
        "hasResidentKey": True,
        "hasUserVerification": True,
        "isUserVerified": True,
        "automaticPresenceSimulation": auto_presence,
    }})
    return r["authenticatorId"]


def set_presence(cdp_session, auth_id, enabled):
    cdp_session.send("WebAuthn.setAutomaticPresenceSimulation",
                     {"authenticatorId": auth_id, "enabled": enabled})


def logout(page):
    page.click('form[action="/logout"] button')
    page.wait_for_url(f"{BASE}/login", timeout=15000)


print("== seed test user ==")
seed = " ".join([
    f"INSERT INTO users (id, created_at, name, email, is_admin, updated_at) VALUES ('{USER_ID}', {NOW}, 'E2E Test', '{EMAIL}', 0, {NOW});",
    f"INSERT INTO enrollment_tokens (token_hash, user_id, created_at, expires_at) VALUES ('{TOKEN_HASH}', '{USER_ID}', {NOW}, {NOW + 3600});",
])
wrangler("d1", "execute", "identity", "--remote", "--command", seed)
print("  seeded", EMAIL)

try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path="/opt/meta-chromium/chrome",
            headless=True,
            proxy={"server": "http://127.0.0.1:18080"},
            args=["--no-sandbox", "--disable-gpu", "--ignore-certificate-errors"],
        )

        # --- Flow A: enrollment + explicit button login (no auto-presence) ---
        ctx_a = browser.new_context(ignore_https_errors=True)
        page_a = ctx_a.new_page()
        cdp_a = ctx_a.new_cdp_session(page_a)
        auth_a = add_authenticator(cdp_a, auto_presence=False)

        print("== enrollment ==")
        page_a.goto(f"{BASE}/enroll/{TOKEN}", wait_until="networkidle")
        check("enroll page greets user", "E2E Test" in page_a.content())
        set_presence(cdp_a, auth_a, True)
        page_a.click("#enroll-btn")
        page_a.wait_for_url(f"{BASE}/account", timeout=30000)
        set_presence(cdp_a, auth_a, False)
        check("enroll -> /account", page_a.url.rstrip("/") == f"{BASE}/account")
        check("passkey listed", "Synced passkey" in page_a.content() or "Device passkey" in page_a.content())

        print("== button sign-in ==")
        logout(page_a)
        check("logout -> /login", "/login" in page_a.url)
        page_a.goto(f"{BASE}/login", wait_until="networkidle")
        page_a.fill("#email", EMAIL)
        set_presence(cdp_a, auth_a, True)
        page_a.click("#passkey-btn")
        page_a.wait_for_url(f"{BASE}/account", timeout=30000)
        set_presence(cdp_a, auth_a, False)
        check("button sign-in -> /account", page_a.url.rstrip("/") == f"{BASE}/account")
        check("account shows email", EMAIL in page_a.content())
        ctx_a.close()

        # --- Flow B: conditional mediation auto sign-in ---
        # Fresh profile: re-enroll the same user with a new token.
        token2 = secrets.token_hex(32)
        wrangler("d1", "execute", "identity", "--remote", "--command",
                 f"INSERT INTO enrollment_tokens (token_hash, user_id, created_at, expires_at) VALUES ('{hashlib.sha256(token2.encode()).hexdigest()}', '{USER_ID}', {int(time.time())}, {int(time.time()) + 3600});")
        ctx_b = browser.new_context(ignore_https_errors=True)
        page_b = ctx_b.new_page()
        add_authenticator(ctx_b.new_cdp_session(page_b), auto_presence=True)

        print("== conditional sign-in ==")
        page_b.goto(f"{BASE}/enroll/{token2}", wait_until="networkidle")
        page_b.click("#enroll-btn")
        page_b.wait_for_url(f"{BASE}/account", timeout=30000)
        logout(page_b)
        page_b.goto(f"{BASE}/login", wait_until="networkidle")
        # Virtual authenticator auto-completes the autofill ceremony.
        page_b.wait_for_url(f"{BASE}/account", timeout=15000)
        check("conditional auto sign-in -> /account", page_b.url.rstrip("/") == f"{BASE}/account")
        ctx_b.close()

        browser.close()
finally:
    print("== cleanup ==")
    wrangler("d1", "execute", "identity", "--remote", "--command",
             f"DELETE FROM users WHERE id = '{USER_ID}';")
    print("  test user deleted")

print("\nALL PASS" if not failures else f"\n{len(failures)} FAILURES")
sys.exit(0 if not failures else 1)
