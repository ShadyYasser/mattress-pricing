# Mattress pricing (تسعير المراتب)

Pricing tool for an Egyptian mattress maker. Mattress types: spring (سوست), semi (نصف طبي), medical (طبي), premium (طبي بريميوم ميموري فوم), hotel (هارد للفنادق والسواقين); margins are set per type.

Recipes (Nov 2026): foams are priced per 1 cm (t=1, qty = cm) from a reference sheet/block. Spring = 17 cm springs + felt + fabric (3 cm) + hard foam for the rest. Semi = same 20 cm + 5 cm rebond + rest half hard / half soft. Medical 20/25 = 14 rebond + 2 fabric + super soft; 30 = 14 rebond + 2 fabric + half soft / half super soft; 35 = 14 rebond + 2 fabric + super soft. Premium 30 = medical 25 + 5 memory foam; premium 35 = premium 30 + 5 super soft. Hotel = 2 fabric + hard. Every recipe sets `hOverride` to its nominal height so the fabric sides use the real height.

`price_list` is rebuilt only by the owner's browser (on load and on every save). After editing `pricing_state` by SQL, the viewers' list stays stale until the owner opens the site — open it (or rebuild `price_list` the same way) and check it before reporting prices as live.

`pricing_backups` keeps snapshots of `pricing_state` taken before bulk data changes. components (fabric, felt, sponge, rebond, spring chassis, glue, packaging, labor) are combined into mattress models; the site outputs manufacturing-cost, sale-price and optional "offer" (pre-discount) tables for every width at a fixed length.

## Stack
- Single static page `site/index.html` (vanilla JS, Arabic RTL, no build). supabase-js v2 from jsDelivr.
- Hosting: GitHub Pages via `.github/workflows/deploy.yml` (uploads `site/`). Repo `ShadyYasser/mattress-pricing`.
- Backend: Supabase project `mattress-pricing`, ref `qaiyjxooiefcxzzigrpo` (org free plan, eu-central-1). URL and publishable key are public and live in the page; never put the service_role key or DB password in the repo.
- Keep every schema change as a SQL file in `supabase/migrations/`.

## Data model
- `pricing_state` (single row id=1): `data` jsonb = `{settings, items, models, updatedAt, sample}`; `rev` int for optimistic concurrency (client updates `where rev = known`; 0 rows = conflict banner).
- `price_list` (single row id=1): `{kinds, widths, models[].prices{kind:[...]}}` with only the viewer-visible levels (no costs) — written by the owner client on every save, read by viewers.
- `members` (user_id, email, role owner|viewer, must_change_password). RLS: owner reads/writes state; owner+viewer read price_list.
- RPCs (security definer, owner-checked): `create_viewer(email,password)`, `reset_member_password(user_id,password)`, `delete_member(user_id)`; `password_changed()` for self; `keepalive()` for anon.
- Accounts are created by SQL (`_create_auth_user`) — there is no public sign-up in the UI.

## Pricing rules
- Item `method`: face (W×L), twoFaces (2·W·L), sides (2·(W+L)·H), cover (2·W·L + 2·(W+L)·H), perWidth (price for a mattress of width `refW` cm, scaled by W), fixed (per mattress). `basis` for area methods: sheet ("متر" = 1 m × length piece), m2, or block (`block` {l,w,h cm, price} → price per m³ × thickness). `waste` % applies to area methods.
- The factory counts fabric and foam in "متر" = a 1 m × 2 m piece; the breakdown shows fabric split into top, bottom and sides in that unit.
- Height = Σ thickness×qty for face + 2×thickness×qty for twoFaces, unless `hOverride` > 0.
- Four price levels, each rounded up to `round`: cost → base (father's price) = cost × (1 + margins[type]%) → mine (owner's price to customers) = base + cost × myMargins[type]% (the owner's share is a % of the cost, not of the base) → offer (pre-discount, optional) = mine × (1 + offer.pct%).
- `settings.viewer` {base, mine, offer} picks which levels are written to `price_list`; viewers never receive levels that are switched off, and never the cost.

## Conventions
- UI text in Egyptian Arabic; code and commits in English.
