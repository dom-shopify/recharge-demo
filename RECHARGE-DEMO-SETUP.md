# Recharge Demo Setup — Runbook

> **NOTE (2026-09-13):** This file was reconstructed by Claude from the details in
> Dominic's kickoff message — the original RECHARGE-DEMO-SETUP.md was not found
> anywhere on this machine. Items marked `[UNCONFIRMED]` are best guesses and need
> Dominic to confirm or correct them against the original plan.

**Store:** dominic-coryell (`https://admin.shopify.com/store/dominic-coryell`)

**Goal:** Seed the store with ~14 months of realistic subscription-commerce history
(3,500 backdated orders + customers), then use the Shopify dev toolkit live in the
demo for the parts the audience watches: the audit, the customer segment, and the
theme section.

**Division of labor:**
- `seed.mjs` (plain Node script, Admin GraphQL API, custom-app token) writes the
  bulk data: customers, backdated orders with correct `processedAt`, subscription
  markings.
- The Shopify CLI / dev toolkit is used only for reading, validating, and building
  one thing at a time — products, the audit, the segment, the theme section. It
  does **not** do the bulk import.

---

## Step 0 — Environment setup

Done (2026-09-13):
- Shopify CLI 4.8.0 installed via Homebrew (`brew install shopify-cli`, tap
  `shopify/shopify` trusted). Key commands for this project: `shopify store
  execute` (GraphQL against the store), `shopify store bulk` (bulk Admin API
  ops), `shopify store info`.
- Recharge MCP server cloned to `tools/recharge-mcp-node/` (community server
  `ChemicalLuck/recharge-mcp-node`, audited: single-file server, only network
  destination is `api.rechargeapps.com`). Registered in `.mcp.json`; the token
  is read from `$RECHARGE_ACCESS_TOKEN` at launch, never stored in a file.

### Step 0a — HUMAN: Log in to the Shopify store

Run in this session (interactive browser flow):

```
! shopify auth login
```

Then verify with `shopify store info --store dominic-coryell`.

### Step 0b — HUMAN: Provide the Recharge API token

Create/copy an Admin API token in the Recharge merchant portal
(**Apps → API tokens / Custom integrations**), then export it in the shell
that launches Claude Code:

```sh
export RECHARGE_ACCESS_TOKEN='sk_...'
```

Restart Claude Code in this directory and approve the `recharge` MCP server
when prompted. Tools are namespaced `v1_*` / `v2_*` (e.g. `v2_subscription_list`).

## Step 1 — App credentials — DONE 2026-09-14 (Dev Dashboard, not legacy custom app)

**What actually happened:** this org is on Shopify's new dev platform, so the
legacy custom-app flow (reveal-once `shpat_` token) doesn't exist here. The app
lives in the **Dev Dashboard** as `recharge-demo-app` and only exposes a
Client ID + Secret. seed.mjs exchanges those for a 24-hour Admin token itself
via the [client credentials grant](https://shopify.dev/docs/apps/build/dev-dashboard/get-api-access-tokens)
(`POST /admin/oauth/access_token`, `grant_type=client_credentials`) and
auto-refreshes. The granted scopes cover everything the seeder needs
(`write_orders`, `write_customers`, `read_all_orders`, …).

```sh
export SHOPIFY_CLIENT_ID='19732be9bcc26050985432a5595c8c3e'
export SHOPIFY_CLIENT_SECRET='shpss_...'   # Dev Dashboard → recharge-demo-app → App settings → Credentials
```

The secret was pasted into the chat/terminal during setup — **rotate it after
the demo** (App settings → Credentials → Rotate). Rotating just invalidates
the old secret; re-export the new one if you need to reseed/purge.

## Step 2 — Confirm the catalog and demo data design

**Store state as verified 2026-09-14 via `shopify store execute`:**
- Shop "RECHARGE DEMO", currency **EUR**
- 35 products: the standard apparel test catalog (NIKE / ADIDAS / VANS /
  HERSCHEL shoes & accessories, ~€20–€120)
- 15 customers, **0 orders**, **no selling plan groups** (no native
  subscription plans configured)

**Decisions (confirmed by Dominic 2026-09-14):** replace the catalog entirely;
use the default data shape with planted anomalies.

**Done 2026-09-14:**
- 31 apparel/test products **archived** (not deleted — reversible). Gift Card
  and 3 draft products left untouched.
- New catalog created and published to Online Store: **Nordkap Roasters**,
  16 products — 8 subscription coffees (Grind variants: Whole Bean / Filter /
  Espresso, €12.50–€36) + 8 one-time brew-gear items (€6.50–€79).
  Definition lives in `catalog.json`. No product images yet (follow-up:
  matters for the theme-section demo).

**Final data design (implemented in seed.mjs, verified with `--plan`):**
- 3,500 orders / 1,374 customers: 400 subscribers (tags `subscriber`,
  monthly coffee orders) + 974 one-time buyers, window 2025-07-01..2026-08-31
- Growth curve with Nov–Dec 2025 holiday bump
- Planted anomaly 1: `bf-promo` cohort — 60 subscribers acquired Nov 2025,
  ~85% churn Feb–Mar 2026 (intro-discount-ends story)
- Planted anomaly 2: failed-charge cluster — recurring orders due 8–14 May
  2026 mostly slip 3–5 days, tagged `charge-retried` (32 orders)
- Subscription markings as real Recharge orders carry them: tags
  `Subscription` + `Subscription First Order` / `Subscription Recurring Order`
  + custom attributes; no selling plans needed on historical imports
- Every seeded customer and order is tagged `demo-seed` (purgeable)

## Step 3 — `seed.mjs` — DONE 2026-09-14

Written and schedule-verified (`node seed.mjs --plan` — no API calls). Node
script, Admin GraphQL via `SHOPIFY_ADMIN_TOKEN`, API version 2026-01.
- Deterministic RNG: identical schedule every run; `seed-state.json` records
  created IDs so interrupted runs resume without duplicating.
- Orders created chronologically so Shopify order numbers ascend with
  `processedAt`.
- Orders: `orderCreate` with customer attached, backdated `processedAt`, PAID +
  FULFILLED, a SALE transaction (so analytics sees revenue), EUR,
  `sendReceipt:false` (no emails), `inventoryBehaviour: BYPASS`.
- Customers: `@example.com` emails (undeliverable by design).
- Modes: `--plan` (stats only) / `--smoke` (first 20 orders) / full /
  `--purge --yes` (delete everything tagged `demo-seed` and the state file).

## Step 4 — Smoke test — DONE 2026-09-14

20 orders + 20 customers created (orders #1024–#1043). Run overnight at
Dominic's request ("without me needing to tap").

## Step 5 — Order verification — DONE 2026-09-14 (via GraphQL, in place of eyeball)

Dominic asked for a hands-off overnight run, so Claude verified via the Admin
API instead of the admin UI:
- #1024: `processedAt` 2025-07-01 (createdAt = import time, as designed), PAID,
  FULFILLED, €39.00 total matching line item, SALE transaction, customer
  attached, `demo-seed` tag.
- #1031 / #1033: `Subscription` + `Subscription First Order` tags,
  `subscription_interval: 1 month` attribute, Grind variant titles, customers
  tagged `subscriber`, prices match catalog.

Dominic can still spot-check any order in admin — nothing was deleted.

## Step 6 — Full seed — DONE 2026-09-14 (overnight run)

All 3,500 orders + 1,374 customers written (exit 0, no retriable failures).

## Step 7 — Verify the dataset — DONE 2026-09-14 (via Admin API)

Verified against the live store:
- 3,500 `demo-seed` orders (2,222 subscription / 1,278 one-time), 32 `charge-retried`
- 1,374 `demo-seed` customers: 400 `subscriber` (60 `bf-promo`) + 974 one-time;
  the 15 pre-existing customers untouched
- Monthly totals by `processedAt`: 69, 102, 111, 151, **260, 299** (Nov–Dec bump),
  277, 264, 274, 312, 360, 375, 420, 392
- Analytics reflecting backdated history: eyeball in admin Analytics (Dominic)

Gotcha found while verifying: **`customersCount(query: "tag:...")` silently
ignores the tag filter** and returns the store total — count customers by
paginating `customers(first: 250)` and tallying tags instead. (`ordersCount`
filters correctly.)

## Step 8 — Demo-day pieces (toolkit territory)

Built live or prepped with the dev toolkit, one at a time:
1. The audit
2. The customer segment
3. The theme section

`[UNCONFIRMED — the original runbook presumably specified what each of these
contains.]`

---

## ⚠️ Paste this at the top of EVERY analysis session

> All order history in this store is imported. `createdAt` is the import
> timestamp on all 3,500 orders — filtering on it collapses fourteen months into
> one afternoon. **Always filter and group on `processedAt`, never `createdAt`.**
> Admin and the built-in analytics reports already use `processedAt`; this rule
> is for any hand-rolled GraphQL query or export.
