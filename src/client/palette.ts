import { $, $$ } from "./dom";

interface Cmd {
  kind: string;
  label: string;
  sub?: string;
  href: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

function toCmds(data: unknown): Cmd[] {
  if (!Array.isArray(data)) return [];
  return data.flatMap((r: unknown) => {
    if (!isRecord(r)) return [];
    if (typeof r.kind !== "string" || typeof r.label !== "string" || typeof r.href !== "string")
      return [];
    return [
      {
        kind: r.kind,
        label: r.label,
        href: r.href,
        ...(typeof r.sub === "string" ? { sub: r.sub } : {}),
      },
    ];
  });
}

export function initPalette(): void {
  const dlg = $("palette");
  if (!(dlg instanceof HTMLDialogElement)) return;
  const input = dlg.querySelector<HTMLInputElement>("[data-palette-input]");
  const list = dlg.querySelector<HTMLUListElement>("[data-palette-list]");
  if (!input || !list) return;
  const pages: Cmd[] = $$<HTMLAnchorElement>(".sidebar .nav-link").map((a) => ({
    kind: "Page",
    label: a.textContent?.trim() ?? "",
    href: a.getAttribute("href") ?? "/",
  }));
  const actions: Cmd[] = pages.some((p) => p.href === "/admin")
    ? [
        { kind: "Action", label: "Invite a person", href: "/admin/users?invite=1" },
        { kind: "Action", label: "Add an app", href: "/admin/apps?new=1" },
        { kind: "Action", label: "Register a client", href: "/admin/clients?new=1" },
        { kind: "Action", label: "Create an API token", href: "/admin/tokens" },
      ]
    : [{ kind: "Action", label: "Add a passkey", href: "/account#passkeys" }];
  let remote: Cmd[] = [];
  let loaded = false;
  let sel = 0;
  let shown: Cmd[] = [];

  const render = () => {
    const q = input.value.trim().toLowerCase();
    const all = [...pages, ...actions, ...remote];
    shown = (
      q
        ? all.filter((c) => `${c.label} ${c.sub ?? ""} ${c.kind}`.toLowerCase().includes(q))
        : [...pages, ...actions]
    ).slice(0, 40);
    sel = Math.min(sel, Math.max(0, shown.length - 1));
    list.replaceChildren(
      ...shown.map((c, i) => {
        const li = document.createElement("li");
        li.className = i === sel ? "sel" : "";
        li.setAttribute("role", "option");
        const a = document.createElement("a");
        a.href = c.href;
        const label = document.createElement("span");
        label.className = "grow truncate";
        label.textContent = c.label;
        if (c.sub) {
          const sub = document.createElement("span");
          sub.className = "muted small";
          sub.textContent = `  ${c.sub}`;
          label.appendChild(sub);
        }
        const kind = document.createElement("span");
        kind.className = "kind";
        kind.textContent = c.kind;
        a.append(label, kind);
        li.appendChild(a);
        return li;
      }),
    );
    if (!shown.length) {
      const li = document.createElement("li");
      li.className = "grp";
      li.textContent = "No matches";
      list.appendChild(li);
    }
    list.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  };

  const open = async () => {
    input.value = "";
    sel = 0;
    render();
    dlg.showModal();
    input.focus();
    if (!loaded && pages.some((p) => p.href === "/admin")) {
      loaded = true;
      try {
        const res = await fetch("/admin/palette.json", { credentials: "same-origin" });
        if (res.ok) remote = toCmds(await res.json());
        render();
      } catch {}
    }
  };

  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (dlg.open) dlg.close();
      else void open();
    } else if (
      e.key === "/" &&
      !dlg.open &&
      !(e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement)
    ) {
      e.preventDefault();
      void open();
    }
  });
  $$("[data-open-palette]").forEach((b) => b.addEventListener("click", () => void open()));
  input.addEventListener("input", () => {
    sel = 0;
    render();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      sel = (sel + (e.key === "ArrowDown" ? 1 : -1) + shown.length) % Math.max(1, shown.length);
      render();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const c = shown[sel];
      if (c) window.location.href = c.href;
    }
  });
}
