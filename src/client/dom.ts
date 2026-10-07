/** Tiny DOM helpers + toasts shared by the browser modules. */
export const $ = (id: string): HTMLElement | null => document.getElementById(id);
export const $$ = <T extends Element = HTMLElement>(
  sel: string,
  root: ParentNode = document,
): T[] => [...root.querySelectorAll<T>(sel)];

/* ───────────────────────────── toasts ───────────────────────────── */

export function toast(msg: string, tone: "ok" | "bad" = "ok"): void {
  const box = $("toasts");
  if (!box) return;
  const t = document.createElement("div");
  t.className = tone === "bad" ? "toast bad" : "toast";
  t.setAttribute("role", tone === "bad" ? "alert" : "status");
  t.textContent = msg;
  box.appendChild(t);
  setTimeout(() => t.classList.add("leaving"), tone === "bad" ? 6000 : 3200);
  setTimeout(() => t.remove(), tone === "bad" ? 6400 : 3600);
}
