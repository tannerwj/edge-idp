# Johnson ID — Theme Research Brief

Research date: 2026-10-07. Sources: design breakdowns of Linear, Vercel, Raycast,
Arc, Apple/HIG, Stripe, Tailwind UI, plus current auth-page patterns (Colorlib 2026
passkey-first templates, split-panel and centered-card conventions).

Goal: 5–6 themes that are each classy, modern, and intuitive in their own way —
distinct from each other, all implementable in pure CSS (gradients, borders,
shadows, spacing, system fonts only — no webfont or image dependencies). The admin
theme picker sets one site-wide; each theme should cover login, enrollment,
account, and admin surfaces.

**Recommended main theme: Obsidian.** Dark, tactile, and confident — the
Raycast/Linear register reads as premium security tooling, and a passkey prompt
feels most at home on near-black. It's also the most visually differentiated from
generic Bootstrap-style auth pages.

---

## 1. Obsidian (recommended main)

**Aesthetic.** A near-black void where the auth card emerges like backlit glass.
Depth comes from layered shadows and hairline borders rather than color contrast;
faint colored light bleeds into the canvas at very low opacity. Feels like
high-end dev tooling — Linear meets Raycast's command terminal.

**Palette**
- `--bg` `#050607` (void canvas)
- `--card` `#101214` (surface, 1 step up)
- `--line` `#23272a` (hairline borders)
- `--text` `#f2f4f5`, `--muted` `#8a8f93`
- `--accent` `#ffffff` (inverted: the primary button is near-white on black)
- `--accent-ink` `#0a0a0a`
- Glow: radial gradients `rgba(99,161,255,.07)` + `rgba(139,92,246,.06)` behind card
- Status red reserved for errors/logo only: `#ff6363`

**Typography.** System sans stack
(`-apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", sans-serif`); tight
negative tracking (`-0.02em`) on the headline, loose positive tracking
(`+0.08em`, 11px uppercase) on eyebrow/micro labels. `ui-monospace` for the
user's email/identifier line — makes identity strings feel precise.

**Signature details**
1. **Inverted CTA** — the primary passkey button is a near-white pill
   (`#e8eaeb`) with black text on the black canvas. Inverting the convention
   makes the one action unmissable without any chromatic noise.
2. **Tactile keycap buttons** — subtle pressable feel via stacked shadows:
   `inset 0 1px 0 rgba(255,255,255,.08), 0 1px 2px rgba(0,0,0,.6)`; on `:active`
   the inset deepens. Buttons feel physical, like keyboard keys.
3. **Light-bleed backdrop** — two large blurred radial gradients (blue core,
   violet core, 6–8% opacity) positioned behind the card, so the surface reads
   as frosted obsidian lit from behind.

---

## 2. Porcelain

**Aesthetic.** Apple's museum-gallery minimalism: a white/parchment canvas, very
low density, typography carrying the entire design. Nothing competes with the
content — no borders-as-decoration, no gradients, no noise. The quietest theme,
and the most universally "safe" for a personal IdP that guests might see.

**Palette**
- `--bg` `#f5f5f7` (parchment), `--card` `#ffffff`
- `--line` `#e5e5ea` (used sparingly — dividers only)
- `--text` `#1d1d1f`, `--muted` `#6e6e73`
- `--accent` `#0066cc` (single quiet blue; the only brand color)
- `--accent-ink` `#ffffff`
- `--danger` `#d70015`

**Typography.** `-apple-system, BlinkMacSystemFont, "SF Pro Display",
"SF Pro Text", "Segoe UI", sans-serif`. Large light headline (28–32px, weight
400–500) with slight negative tracking; small 13px footnote-style secondary
text. Weight — not color or size jumps — establishes hierarchy.

**Signature details**
1. **Floating card, one soft shadow** — the card has no border at all; elevation
   is a single soft drop `0 24px 70px rgba(0,0,0,.10)`. Clean enough to feel
   expensive.
2. **Tiny blue pill CTA** — compact rounded-full button, solid `#0066cc`, white
   text, modest padding (10px 22px). Links are the same blue, never underlined.
3. **Gallery rhythm** — 56–72px vertical gaps between logo, headline, card, and
   footnote. The whitespace is the design; resist filling it.

---

## 3. Ledger

**Aesthetic.** Stripe-register precision: crisp white surfaces, hairline rules,
dense-but-ordered layout, one restrained blurple accent. Feels institutional and
trustworthy — the theme that says "your identity is handled by professionals."
Best fit for the admin console's data-dense tables.

**Palette**
- `--bg` `#f6f9fc` (cool paper), `--card` `#ffffff`
- `--line` `#e3e8ee` (hairlines everywhere — this theme loves a 1px rule)
- `--text` `#0f1b2d`, `--muted` `#5b6b7f`
- `--accent` `#635bff` (Stripe blurple), button gradient `#635bff → #4f46e5`
- `--accent-ink` `#ffffff`
- `--danger` `#df1b41`

**Typography.** System sans with tabular numerals
(`font-variant-numeric: tabular-nums`) so emails, dates, and token counts align
in admin tables. 11px uppercase micro-eyebrows (`letter-spacing: .08em`,
`#5b6b7f`) label each card section — "Identity", "Security", "Sessions".

**Signature details**
1. **Hairline architecture** — cards are `1px solid var(--line)` with a modest
   `8px` radius and near-zero shadow; separation comes from rules, not depth.
   Inputs get the same 1px treatment with a blurple focus ring
   (`0 0 0 3px rgba(99,91,255,.15)`).
2. **Gradient CTA with discipline** — the only gradient in the system, reserved
   for the primary button (`linear-gradient(180deg,#7a73ff,#635bff)`); hover
   darkens, never brightens.
3. **Eyebrow-labeled sections** — every card carries a tiny uppercase gray label
   above its title. Makes admin pages scannable at a glance and gives the login
   page a "console" feel.

---

## 4. Dusk

**Aesthetic.** Arc-browser warmth: a deep plum-charcoal canvas with an aurora of
violet, indigo, and ember drifting behind frosted-glass surfaces. Rounded,
soft, and a little playful — premium without being sterile. The theme for
people who find Obsidian too severe.

**Palette**
- `--bg` `#14101c` (plum-charcoal)
- `--card` `rgba(255,255,255,.06)` over the aurora (frosted glass,
  `backdrop-filter: blur(24px)`, border `1px solid rgba(255,255,255,.12)`)
- `--line` `rgba(255,255,255,.10)`
- `--text` `#f4f1fa`, `--muted` `#a79fc0`
- `--accent` `#b79bff` (soft violet) → gradient button `#8b5cf6 → #ec7a9e`
- `--accent-ink` `#ffffff`
- Aurora blobs: `#6d5cff` (violet), `#4f7cff` (indigo), `#ff8a7a` (ember) at
  18–28% opacity, heavily blurred

**Typography.** System rounded feel: `ui-rounded, -apple-system,
BlinkMacSystemFont, "Segoe UI", sans-serif` where available, falling back
gracefully. Medium weights (500–600), friendly 15–16px body, generous
line-height (1.6).

**Signature details**
1. **Aurora mesh backdrop** — 3–4 large `radial-gradient` blobs
   (`filter: blur(80px)`) drifting on the canvas; a slow 24s keyframe drift
   animation adds life without demanding attention. Pure CSS, no images.
2. **Frosted glass card** — `backdrop-filter: blur(24px) saturate(1.4)` over the
   aurora, 20px radius, 1px translucent white border. The form floats in colored
   light.
3. **Pill everything** — inputs and buttons fully rounded (`999px`), soft inner
   glow on focus. The whole surface feels touchable and calm.

---

## 5. Manuscript

**Aesthetic.** Warm editorial paper: cream background, ink text, a serif display
headline, and hairline rules instead of cards. Reads like a well-set book page
or a private members' club ledger — distinctive, literary, and quietly
confident. The most "human" of the six.

**Palette**
- `--bg` `#faf6ef` (paper), `--card` `#fffdf8` (barely-lifted paper)
- `--line` `#e5dccb` (warm hairlines)
- `--text` `#1c1917` (warm ink), `--muted` `#78716c`
- `--accent` `#1f4d3a` (deep racing green), `--accent-ink` `#faf6ef`
- `--danger` `#9c2b2e` (oxblood)

**Typography.** Display in system serif (`Georgia, "Iowan Old Style",
"Times New Roman", serif`) — headline with one italic accent word for the
editorial touch. Body and form in system sans. 17–18px body at 1.65
line-height; the page should read comfortably like print.

**Signature details**
1. **Rules, not cards** — the form sits directly on the paper; sections are
   separated by 1px warm rules with small-caps labels. Only the passkey button
   is a solid object. Radically reduces chrome.
2. **Serif headline with italic accent** — e.g. "Welcome back, *friend*." in
   Georgia italic for the accent word. Instantly distinctive, zero assets.
3. **Letterpressed button** — solid deep-green rectangle, 6px radius, slight
   letterspacing (`+.02em`), and a subtle inset top highlight
   (`inset 0 1px 0 rgba(255,255,255,.18)`) like ink pressed into paper.

---

## 6. Monochrome

**Aesthetic.** Vercel-docs taken to its logical extreme: black on white (with a
true dark-mode inversion), zero border radius except circles, no shadows at
all — elevation exists only as hairline borders. Hierarchy is carried purely by
weight and tracking. Feels engineered, honest, and immune to trends.

**Palette (light)**
- `--bg` `#fafafa`, `--card` `#ffffff`
- `--line` `#eaeaea`
- `--text` `#111111`, `--muted` `#666666`
- `--accent` `#111111` (the accent IS near-black), `--accent-ink` `#fafafa`
- `--danger` `#e00`
- **Dark inversion:** `--bg` `#0a0a0a`, `--card` `#111111`, `--line` `#262626`,
  `--text` `#ededed`, `--muted` `#888888`, `--accent` `#ededed`

**Typography.** System sans, headings bold with `letter-spacing: -0.03em`;
micro labels in `ui-monospace` uppercase. Active/selected states use a neutral
gray fill (`#f0f0f0` / `#1e1e1e`) rather than color — color is reserved for
status only (green/amber/red dots).

**Signature details**
1. **Radius zero** — `--radius: 0` everywhere (avatars and status dots keep
   `border-radius: 50%`). The sharpness is the brand.
2. **Borders, never shadows** — `--shadow: none` globally; cards, dropdowns,
   and modals separate from the canvas with a single 1px `--line`. Flat but
   never cheap.
3. **Weight-as-hierarchy** — page titles at 700/tracking-tight, section labels
   at 600, body at 400. No color is spent on emphasis, so when red or green
   appears (errors, success), it lands hard.

---

## Theme token contract

Each theme is a `[data-theme="..."]` block setting the existing tokens
(`--bg --card --line --text --muted --accent --accent-ink --danger --radius
--shadow`) plus three additions this research suggests:

| Token | Purpose |
|---|---|
| `--bg-glow` | Optional decorative background layer (radial gradients; `none` for flat themes) |
| `--input-bg` | Input surface, since several themes diverge card vs input treatment |
| `--font-display` | Optional display face (serif for Manuscript; inherits body elsewhere) |

Admin picker writes the chosen theme name to a site setting; pages render
`data-theme` on `<html>` server-side so there's no flash. Keep per-theme CSS in
`src/client/themes/<name>.css`, imported once — new themes stay additive and
can't break each other.

## What makes these "classy" vs generic

Across all six: **one accent color, used sparingly** (generic auth pages use
three or four); **hairlines over heavy shadows** (or one deliberate soft
shadow, never five); **typography doing the work** (tracking/weight registers
instead of colored headings); **restraint in density** (generous whitespace,
one primary action per screen). The differentiator between themes is never
"more decoration" — it's which material metaphor the surface commits to
(void glass, gallery white, ledger paper, aurora, book page, blueprint).
