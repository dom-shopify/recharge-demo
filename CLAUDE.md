# Nordkap Coffee — Recharge × Shopify AI demo

This repo seeds and operates a realistic subscription-commerce demo: a Shopify dev
store ("Nordkap Coffee") with 14 months of backdated order history, mirrored into a
live Recharge sandbox so subscription workflows (audits, churn analysis, winbacks,
dunning) can be demoed against real Recharge API data.

## The demo store

- Shopify store: `dominic-coryell` (storefront: happyhootsnft.com), currency EUR
- Recharge sandbox: store id 227346, connected to the same Shopify store (SCI /
  "Recharge on Shopify Checkout" mode)
- Catalog: 16 products (8 coffees with a monthly subscription option + 8 gear items),
  defined in `catalog.json`; product GIDs in `images-workbench/product-ids.json`
- Seeded history: **3,500 orders** (2,222 subscription / 1,278 one-time, 32 with
  charge retries) across 14 months, **1,374 customers** (400 subscribers, of which
  60 are the `bf-promo` Black Friday cohort that churned — the demo's churn story)

## Critical data rules (read before querying)

1. **Always filter/group on `processedAt`, never `createdAt`.** All 3,500 orders were
   bulk-imported in one afternoon, so `createdAt` collapses 14 months into a single
   day. `processedAt` carries the real backdated timeline.
2. **`customersCount(query: "tag:...")` silently ignores tag filters** and returns
   the store total. Paginate `customers` and tally tags locally. `ordersCount`
   filters correctly.
3. Test orders created by the mirror pipeline are marked `test: true` — exclude them
   from history analyses if needed.

## Auth (no secrets in this repo)

- Shopify: the org is on the new dev platform — no legacy `shpat_` tokens. The app
  `recharge-demo-app` (Dev Dashboard) exchanges Client ID + Secret for a 24h Admin
  token via the client-credentials grant. Export `SHOPIFY_CLIENT_ID` and
  `SHOPIFY_CLIENT_SECRET`; `seed.mjs` auto-refreshes.
- Recharge: `RECHARGE_API_KEY` (Admin API v2021-11). Raw curl needs the header
  `X-Recharge-Version: 2021-11` — unversioned paths 404 (except `/shop`).
- Klaviyo: `KLAVIYO_API_KEY` (account "Shopify-DEMO" / ReKepv).
- All keys live in a local `.env` (gitignored) or shell env — never commit them.

## Components

| Path | What it does |
|---|---|
| `seed.mjs` | Bulk-seeds the backdated order/customer history via Admin GraphQL. Resumable via `seed-state.json` (gitignored). |
| `RECHARGE-DEMO-SETUP.md` | Full runbook: store design, scopes, seeding gates, demo-day steps. |
| `catalog.json` | The Nordkap product catalog definition. |
| `images-workbench/` | Product-image sourcing from mock.shop CDN (`mapping.json`, `candidates.json`). All 16 products have READY media. |
| `mirror/` | **The Recharge mirror pipeline** (see below). |
| `recharge-plan-ids.json` | The 8 Recharge plan IDs (one "Monthly subscription" plan per coffee). |
| `tools/recharge-mcp-node/` | *(not committed — third-party clone)* Local Recharge MCP server (Admin API v2021-11): clone [ChemicalLuck/recharge-mcp-node](https://github.com/ChemicalLuck/recharge-mcp-node) into `tools/`, `npm install`, and `.mcp.json` registers it (expects `RECHARGE_ACCESS_TOKEN` in env). |

## The mirror pipeline (`mirror/`)

Recharge-on-Shopify refuses API-created customers unless the underlying Shopify
customer has a **vaulted payment method**, and the vaulting scope
(`write_customer_payment_methods`) is approval-gated. The workaround that needs no
special scope: **a real test checkout containing a subscription (selling-plan) item
vaults the card automatically.**

Per customer, the pipeline is:

1. `node mirror/checkout.mjs <customer.json>` — Playwright buys one subscription item
   as that customer on the storefront (test card 4242…, requires Shopify Payments
   test mode). Adds to cart via `/cart/add.js` with `selling_plan` (cart permalinks
   silently drop the selling plan — don't use them). This vaults the card and creates
   a native Shopify subscription contract.
2. `POST /customers` (Recharge) with `external_customer_id: {ecommerce: "<shopify id>"}`
   — now succeeds because the payment method exists.
3. `POST /addresses` → `POST /subscriptions` with `plan_id` + `external_variant_id`.

Gotchas learned the hard way:

- The store's shipping zone only covers **ES, US, BT** — checkout addresses must be
  in one of those (the Recharge address can still be the customer's real one).
- Spain requires a province; the select is `select[name="zone"]` and labels look like
  "Madrid Province" (match by prefix).
- Recharge **cannot hold backdated charge/order history** — the 14-month history
  stays in Shopify, which is architecturally true to real Recharge deployments.
- Churned cohorts are represented by creating the subscription then cancelling it
  with a `cancellation_reason`, so the churn story is queryable inside Recharge.

Proven end-to-end 2026-09-14 with pilot customer Femke Smit: Shopify contract
`183951425558`, Recharge customer `264782714`, subscription `879386712` (active,
House Blend, €12.50/month).

## Shopify objects that already exist

- SellingPlanGroup `gid://shopify/SellingPlanGroup/95555846166` "Nordkap
  Subscription" with SellingPlan `708403920918` "Deliver every month", attached to
  all 8 coffees.
- 8 Recharge plans (see `recharge-plan-ids.json`), 1-month interval,
  `storefront_purchase_options: "subscription_and_onetime"`.
