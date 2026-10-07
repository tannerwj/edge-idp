/** Progressive-enhancement behaviors wired through data-* attributes. */
import makeQr from "qrcode-generator";
import { $, $$, toast } from "./dom";

/* ───────────────────────────── dialogs & forms ───────────────────────────── */

export function initDialogs(): void {
  document.addEventListener("click", (ev) => {
    const t = ev.target instanceof Element ? ev.target : null;
    const opener = t?.closest("[data-open]");
    if (opener) {
      const d = $(opener.getAttribute("data-open") ?? "");
      if (d instanceof HTMLDialogElement) {
        d.showModal();
        d.querySelector<HTMLElement>(
          "input:not([type=hidden]):not([type=radio]):not([type=checkbox]), textarea",
        )?.focus();
      }
      return;
    }
    const closer = t?.closest("[data-close]");
    if (closer) closer.closest("dialog")?.close();
    // Click on the backdrop closes.
    if (t instanceof HTMLDialogElement && t.open) {
      const r = t.getBoundingClientRect();
      const e = ev as MouseEvent;
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)
        t.close();
    }
  });
  $$("[data-autoopen]").forEach((el) => el.click());
  initConfirm();

  // Confirm before destructive submits.
  document.addEventListener("submit", (ev) => {
    const form = ev.target;
    if (!(form instanceof HTMLFormElement)) return;
    const msg = form.getAttribute("data-confirm");
    if (msg && form.dataset.confirmed !== "1") {
      ev.preventDefault();
      askToConfirm(form, msg, ev instanceof SubmitEvent ? ev.submitter : null);
      return;
    }
    form.querySelectorAll<HTMLButtonElement>("button[type=submit]").forEach((b) => {
      // Keep the clicked button's name/value in the submission, then lock.
      setTimeout(() => (b.disabled = true), 0);
    });
  });
  $$<HTMLSelectElement>("select[data-autosubmit]").forEach((s) =>
    s.addEventListener("change", () => s.form?.submit()),
  );
}

let pendingConfirm: { form: HTMLFormElement; submitter: HTMLElement | null } | null = null;

function askToConfirm(form: HTMLFormElement, message: string, submitter: HTMLElement | null): void {
  const dialog = $("confirm-dialog");
  const title = $("confirm-title");
  const detail = $("confirm-detail");
  const ok = $("confirm-ok");
  if (!(dialog instanceof HTMLDialogElement) || !title || !detail || !ok) {
    if (window.confirm(message)) submitConfirmed(form, submitter);
    return;
  }
  const split = /^(.+?\?)\s+(.+)$/s.exec(message);
  title.textContent = split?.[1] ?? message;
  detail.textContent = split?.[2] ?? "";
  ok.textContent = submitter?.textContent?.trim() || submitter?.title || "Confirm";
  ok.className = submitter?.classList.contains("danger") ? "btn danger solid" : "btn primary";
  dialog.classList.toggle("danger", ok.classList.contains("danger"));
  pendingConfirm = { form, submitter };
  dialog.showModal();
  dialog.querySelector<HTMLElement>("[data-close]")?.focus();
}

function initConfirm(): void {
  $("confirm-ok")?.addEventListener("click", () => {
    const pending = pendingConfirm;
    pendingConfirm = null;
    const dialog = $("confirm-dialog");
    if (dialog instanceof HTMLDialogElement) dialog.close();
    if (pending) submitConfirmed(pending.form, pending.submitter);
  });
}

function submitConfirmed(form: HTMLFormElement, submitter: HTMLElement | null): void {
  form.dataset.confirmed = "1";
  form.requestSubmit(submitter instanceof HTMLButtonElement ? submitter : undefined);
}

/* ───────────────────────────── copy / share / qr ───────────────────────────── */

export function initCopy(): void {
  document.addEventListener("click", (ev) => void onCopyClick(ev));
}

async function onCopyClick(ev: MouseEvent): Promise<void> {
  const t = ev.target instanceof Element ? ev.target : null;
  const btn = t?.closest<HTMLElement>("[data-copy]");
  if (btn) {
    try {
      await navigator.clipboard.writeText(btn.getAttribute("data-copy") ?? "");
      btn.classList.add("done");
      const label = btn.querySelector("span");
      const prev = label?.textContent;
      if (label) label.textContent = "Copied";
      setTimeout(() => {
        btn.classList.remove("done");
        if (label && prev) label.textContent = prev;
      }, 1600);
    } catch {
      toast("Couldn't copy — select it manually.", "bad");
    }
    return;
  }
  const share = t?.closest<HTMLElement>("[data-share]");
  if (share) {
    const url = share.getAttribute("data-share") ?? "";
    if (navigator.share) {
      navigator
        .share({ title: share.getAttribute("data-share-title") ?? document.title, url })
        .catch(() => {});
    } else {
      await navigator.clipboard.writeText(url).catch(() => {});
      toast("Link copied");
    }
    return;
  }
  const qr = t?.closest<HTMLElement>("[data-qr]");
  if (qr) {
    const target = document.querySelector<HTMLElement>("[data-qr-target]");
    if (!target) return;
    if (!target.hidden) {
      target.hidden = true;
      return;
    }
    target.replaceChildren(qrSvg(qr.getAttribute("data-qr") ?? ""));
    target.hidden = false;
  }
}

function qrSvg(text: string): SVGSVGElement {
  const q = makeQr(0, "M");
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `-2 -2 ${n + 4} ${n + 4}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "QR code for the link");
  let d = "";
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "#111");
  svg.appendChild(path);
  return svg;
}

/* ───────────────────────────── time ───────────────────────────── */

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const dtf = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

function relTime(d: Date): string {
  const s = (d.getTime() - Date.now()) / 1000;
  const a = Math.abs(s);
  if (a < 45) return s < 0 ? "just now" : "in a moment";
  if (a < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (a < 86400) return rtf.format(Math.round(s / 3600), "hour");
  if (a < 7 * 86400) return rtf.format(Math.round(s / 86400), "day");
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(d);
}

export function initTimes(): void {
  $$("time[data-time]").forEach((el) => {
    const d = new Date(el.getAttribute("datetime") ?? "");
    if (Number.isNaN(d.getTime())) return;
    el.title = dtf.format(d);
    el.textContent = el.getAttribute("data-time") === "abs" ? dtf.format(d) : relTime(d);
  });
}

/* ───────────────────────────── color mode ───────────────────────────── */

export function initMode(): void {
  $$("[data-mode-set]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const mode = btn.getAttribute("data-mode-set") ?? "system";
      document.cookie = `ui_mode=${mode}; path=/; max-age=31536000; samesite=lax; secure`;
      if (mode === "system") document.documentElement.removeAttribute("data-mode");
      else document.documentElement.setAttribute("data-mode", mode);
      $$("[data-mode-set]").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
    }),
  );
}

/* ───────────────────────────── tables ───────────────────────────── */

export function initTables(): void {
  // Whole-row links (keyboard users still have the real <a> in the row).
  document.addEventListener("click", (ev) => {
    const t = ev.target instanceof Element ? ev.target : null;
    if (!t || t.closest("a, button, input, select, textarea, label, summary, form")) return;
    const row = t.closest<HTMLElement>("tr[data-href]");
    if (row) window.location.href = row.getAttribute("data-href") ?? "#";
  });
  $$<HTMLInputElement>("input[data-filter-table]").forEach((input) => {
    const table = $(input.getAttribute("data-filter-table") ?? "");
    input.addEventListener("input", () => {
      const q = input.value.trim().toLowerCase();
      table?.querySelectorAll<HTMLElement>("tr[data-filter-text]").forEach((tr) => {
        tr.classList.toggle(
          "is-hidden",
          !!q && !(tr.getAttribute("data-filter-text") ?? "").includes(q),
        );
      });
    });
  });
}
