import { toast } from "./dom";
import { initAccount, initEnroll, initLogin } from "./passkeys";
import { initCopy, initDialogs, initMode, initTables, initTimes } from "./ui";
import { initPalette } from "./palette";

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
if (new URLSearchParams(location.search).has("ok")) {
  const u = new URL(location.href);
  u.searchParams.delete("ok");
  history.replaceState(null, "", u.pathname + u.search + u.hash);
}
