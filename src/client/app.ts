/**
 * Browser bundle entry: passkey ceremonies + small progressive-enhancement UI
 * behaviors. Everything is wired through data-* attributes rendered by the
 * server (the CSP forbids inline script). Pages work without it except the
 * WebAuthn ceremonies, which need JS by definition.
 */
import { toast } from "./dom";
import { initAccount, initEnroll, initLogin } from "./passkeys";
import { initCopy, initDialogs, initMode, initTables, initTimes } from "./ui";
import { initPalette } from "./palette";

/* ───────────────────────────── boot ───────────────────────────── */

const page = document.body.getAttribute("data-page");
if (page === "login") void initLogin();
if (page === "enroll") initEnroll();
if (page === "account") initAccount();
initDialogs();
initCopy();
initTimes();
initMode();
initTables();
initPalette();
const flash = document.body.getAttribute("data-flash");
if (flash) toast(flash, document.body.getAttribute("data-flash-tone") === "bad" ? "bad" : "ok");
// Clean ?ok=… flash codes out of the address bar so a reload doesn't repeat them.
if (new URLSearchParams(location.search).has("ok")) {
  const u = new URL(location.href);
  u.searchParams.delete("ok");
  history.replaceState(null, "", u.pathname + u.search + u.hash);
}
