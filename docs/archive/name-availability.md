# Product Name Availability — checked 2026-10-07

## identd — ❌ TAKEN (multiple collisions)

- **GitHub**: taken — `github.com/identd` is a registered user/org account.
- **npm**: taken — `identd` package exists (v1.0.2, an IDENT protocol client).
- **Domain**: taken — `identd.com` resolves and serves a live site.
- **Prior art**: `identd` is the classic RFC 1413 Ident protocol daemon shipped
  in OpenBSD, Debian, Ubuntu, etc. Decades of Unix namespace baggage — using
  it for an OIDC IdP would be confusing and collide in manpages/package
  managers.

**Verdict: avoid.**

## authd — ❌ TAKEN (major collision)

- **GitHub**: taken — `github.com/authd` is a registered user/org account.
- **npm**: available — no `authd` package.
- **Domain**: taken — `authd.com` responds (403, server exists).
- **Prior art**: Canonical/Ubuntu's **authd** — an actively developed (updated
  2026-10-06) authentication daemon for cloud identity providers (MS Entra ID,
  Google IAM), GPLv3. Directly in the identity space with real mindshare.

**Verdict: avoid.**

## edge-idp — ✅ LIKELY AVAILABLE

- **GitHub**: available — `github.com/edge-idp` returns 404 (no user/org).
- **npm**: available — no `edge-idp` package.
- **Domain**: `edge-idp.com` does not resolve (connection failed — likely
  unregistered; confirm with a registrar before assuming).
- **Web**: no existing project by this name; "edge IdP" appears only as a
  generic descriptive phrase in docs.

**Verdict: clear to use.** Caveat: "edge" hints at Cloudflare Workers, but
nothing about the name requires it — the product is portable (standard OIDC
on any runtime). Slightly generic; consider whether it stands out enough.

## cf-idp — ✅ LIKELY AVAILABLE

- **GitHub**: available — `github.com/cf-idp` returns 404.
- **npm**: available — no `cf-idp` package.
- **Domain**: `cf-idp.com` does not resolve (likely unregistered).

**Verdict: technically available, but not recommended.** The `cf-` prefix
reads as "Cloudflare's IdP," which (a) risks a trademark gripe from
Cloudflare, and (b) contradicts the portability goal — friends deploying on
other infrastructure get a name tied to one vendor.

## Recommendation

**edge-idp** is the cleanest of the four: available on GitHub/npm, no domain
response, no prior-art project, no trademark risk. It's descriptive without
being vendor-locked.

If it feels too generic, consider portmanteaus along the same technical line
(e.g. `idp-edge`, `oidc-edge`) — but those weren't checked; ask before
committing.
