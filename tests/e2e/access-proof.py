#!/usr/bin/env python3
"""
End-to-end proof: Cloudflare Access -> Johnson IdP -> passkey -> app.

1. Seeds a test user + enrollment token in the IdP.
2. Enrolls a passkey (virtual authenticator).
3. Visits https://constellation.tannerwj.dev/ (behind Access).
4. Access redirects to the IdP; the signed-in session completes the
   OIDC flow automatically (no consent screen for registered clients).
5. Access callback completes; the app loads.
"""
import hashlib
import os
import secrets
import subprocess
import sys
import time
import uuid

from playwright.sync_api import sync_playwright

IDP = "https://auth.johnson.network"
APP = "https://constellation.tannerwj.dev"
EMAIL = f"access-e2e-{uuid.uuid4().hex[:8]}@example.test"
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


print("== seed test user ==")
wrangler("d1", "execute", "identity", "--remote", "--command", " ".join([
    f"INSERT INTO users (id, created_at, name, email, is_admin, updated_at) VALUES ('{USER_ID}', {NOW}, 'Access E2E', '{EMAIL}', 0, {NOW});",
    f"INSERT INTO enrollment_tokens (token_hash, user_id, created_at, expires_at) VALUES ('{TOKEN_HASH}', '{USER_ID}', {NOW}, {NOW + 3600});",
]))
print("  seeded", EMAIL)

try:
    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path="/opt/meta-chromium/chrome",
            headless=True,
            proxy={"server": "http://127.0.0.1:18080"},
            args=["--no-sandbox", "--disable-gpu", "--ignore-certificate-errors"],
        )
        ctx = browser.new_context(ignore_https_errors=True)
        page = ctx.new_page()
        page.on("pageerror", lambda e: print("PAGEERROR:", str(e)[:200]))
        cdp = ctx.new_cdp_session(page)
        cdp.send("WebAuthn.enable")
        cdp.send("WebAuthn.addVirtualAuthenticator", {"options": {
            "protocol": "ctap2", "transport": "internal", "hasResidentKey": True,
            "hasUserVerification": True, "isUserVerified": True,
            "automaticPresenceSimulation": True,
        }})

        print("== enroll passkey ==")
        page.goto(f"{IDP}/enroll/{TOKEN}", wait_until="networkidle")
        page.click("#enroll-btn")
        page.wait_for_url(f"{IDP}/account", timeout=30000)
        check("enrolled, session active", "/account" in page.url)

        print("== visit app through Access ==")
        page.goto(APP, wait_until="networkidle")
        page.wait_for_timeout(5000)
        # Click the "Sign in with Johnson" IdP link on the Access login page.
        link = page.locator('a[title*="Sign in with Johnson"]')
        check("IdP link present on Access login", link.count() > 0)
        href = link.first.get_attribute("href")
        print("  idp href:", (href or "")[:100])
        # Navigate directly (more reliable than clicking in headless).
        page.goto(href, wait_until="networkidle")
        # The IdP session from enrollment is active; authorize completes
        # without prompts (no consent screen for registered clients).
        # Access callback then sets its cookie and lands on the app.
        page.wait_for_url(f"{APP}/**", timeout=30000)
        print("  landed:", page.url[:80])
        check("reached app", page.url.startswith(APP))
        body = page.content()
        check("app content served", len(body) > 1000)

        browser.close()
finally:
    print("== cleanup ==")
    wrangler("d1", "execute", "identity", "--remote", "--command",
             f"DELETE FROM users WHERE id = '{USER_ID}';")
    print("  test user deleted")

print("\nALL PASS" if not failures else f"\n{len(failures)} FAILURES")
sys.exit(0 if not failures else 1)
