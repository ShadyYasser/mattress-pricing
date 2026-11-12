# Mattress pricing (تسعير المراتب)

Pricing tool for an Egyptian mattress maker: components (fabric, felt, sponge, rebond, spring chassis, glue, packaging, labor) are combined into mattress models; the site outputs manufacturing-cost, sale-price and optional "offer" (pre-discount) tables for every width at a fixed length.

## Stack
- Single static page `site/index.html` (vanilla JS, Arabic RTL, no build). supabase-js v2 from jsDelivr.
- Hosting: GitHub Pages via `.github/workflows/deploy.yml` (uploads `site/`). Repo `ShadyYasser/mattress-pricing`.
- Backend: Supabase project `mattress-pricing`, ref `qaiyjxooiefcxzzigrpo` (org free plan, eu-central-1). URL and publishable key are public and live in the page; never put the service_role key or DB password in the repo.
- Keep every schema change as a SQL file in `supabase/migrations/`.

## Data model
- `pricing_state` (single row id=1): `data` jsonb = `{settings, items, models, updatedAt, sample}`; `rev` int for optimistic concurrency (client updates `where rev = known`; 0 rows = conflict banner).
- `price_list` (single row id=1): computed sale/offer tables only (no costs) — written by the owner client on every save, read by viewers.
- `members` (user_id, email, role owner|viewer, must_change_password). RLS: owner reads/writes state; owner+viewer read price_list.
- RPCs (security definer, owner-checked): `create_viewer(email,password)`, `reset_member_password(user_id,password)`, `delete_member(user_id)`; `password_changed()` for self; `keepalive()` for anon.
- Accounts are created by SQL (`_create_auth_user`) — there is no public sign-up in the UI.

## Pricing rules
- Item `method`: face (W×L), twoFaces (2·W·L), sides (2·(W+L)·H), cover (2·W·L + 2·(W+L)·H), perWidth (price for a mattress of width `refW` cm, scaled by W), fixed (per mattress). `basis` for area methods: sheet ("متر" = 1 m × length piece), m2, or block (`block` {l,w,h cm, price} → price per m³ × thickness). `waste` % applies to area methods.
- The factory counts fabric and foam in "متر" = a 1 m × 2 m piece; the breakdown shows fabric split into top, bottom and sides in that unit.
- Height = Σ thickness×qty for face + 2×thickness×qty for twoFaces, unless `hOverride` > 0.
- Sale = cost × (1 + margin[type]%) rounded up to `round`; offer = sale × (1 + offer.pct%) rounded up.

## Conventions
- UI text in Egyptian Arabic; code and commits in English.
