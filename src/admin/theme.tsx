import { Hono } from "hono";
import { audit, getSetting, setSetting } from "../db";
import { invalidateThemeCache } from "../theme-cache";
import { nowSec } from "../util";
import { THEMES } from "../pages";
import type { AdminVars } from "./shell";
import { field, p } from "./shell";

const THEME_META: Record<string, { name: string; blurb: string }> = {
  obsidian: { name: "Obsidian", blurb: "Dark, tactile, confident — the default." },
  porcelain: { name: "Porcelain", blurb: "Gallery-white minimalism." },
  ledger: { name: "Ledger", blurb: "Crisp, institutional, Stripe-precise." },
  dusk: { name: "Dusk", blurb: "Warm aurora over frosted glass." },
  manuscript: { name: "Manuscript", blurb: "Editorial paper, serif headlines." },
  monochrome: { name: "Monochrome", blurb: "Engineered black-and-white." },
};

export const themeAdmin = new Hono<AdminVars>();

themeAdmin.get("/", async (c) => {
  const current = await getSetting(c.env.DB, "theme", "obsidian");
  return await p(
    c,
    "theme",
    "Theme",
    <>
      <p class="muted">
        The site-wide theme. It applies to the sign-in page, enrollment, your
        account, and this admin.
      </p>
      <form method="post" action="/admin/theme" class="stack">
        <div class="theme-grid">
          {THEMES.map((id) => {
            const meta = THEME_META[id] ?? { name: id, blurb: "" };
            return (
              <label
                key={id}
                class={id === current ? "theme-card selected" : "theme-card"}
              >
                <input
                  type="radio"
                  name="theme"
                  value={id}
                  checked={id === current}
                />
                <span class="theme-name">{meta.name}</span>
                <span class="muted small">{meta.blurb}</span>
              </label>
            );
          })}
        </div>
        <div>
          <button class="btn primary" type="submit">
            Apply theme
          </button>
        </div>
      </form>
    </>,
  );
});

themeAdmin.post("/", async (c) => {
  const form = await c.req.parseBody();
  const choice = field(form, "theme");
  if (!THEMES.includes(choice as (typeof THEMES)[number])) {
    return c.text("Unknown theme", 400);
  }
  await setSetting(c.env.DB, "theme", choice);
  invalidateThemeCache();
  await audit(c.env.DB, "THEME_CHANGED", {
    userId: c.get("admin").id,
    detail: { theme: choice, at: nowSec() },
  });
  return c.redirect("/admin/theme", 303);
});
