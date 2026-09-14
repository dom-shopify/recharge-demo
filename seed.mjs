#!/usr/bin/env node
/**
 * seed.mjs — seeds the RECHARGE DEMO store with 14 months of subscription history.
 *
 * Usage (auth, pick one):
 *   export SHOPIFY_CLIENT_ID='...' SHOPIFY_CLIENT_SECRET='shpss_...'
 *       # Dev Dashboard app credentials — the script exchanges them for a 24h
 *       # Admin token itself (client credentials grant) and refreshes as needed.
 *   export SHOPIFY_ADMIN_TOKEN='shpat_...'   # legacy custom-app token (still supported)
 *
 *   node seed.mjs --smoke        # first 20 orders (chronological) + their customers
 *   node seed.mjs                # everything not yet created (resumes via seed-state.json)
 *   node seed.mjs --purge --yes  # delete ALL demo-seed tagged orders & customers
 *
 * Design (see RECHARGE-DEMO-SETUP.md):
 *   - ~400 subscribers (monthly coffee orders) + one-time gear/coffee buyers, 3,500 orders
 *     total across 2025-07-01 .. 2026-08-31.
 *   - Deterministic RNG: every run generates the identical schedule; seed-state.json
 *     records what has been created, so reruns resume instead of duplicating.
 *   - Orders are created in chronological processedAt order so Shopify's order numbers
 *     ascend with the timeline.
 *   - Planted anomalies for the live audit:
 *       1. "bf-promo" cohort: 60 subscribers acquired in Nov 2025, nearly all churn
 *          in Feb 2026 when the intro discount ends.
 *       2. Failed-charge cluster: recurring orders due 8-14 May 2026 mostly slip 3-5
 *          days and carry tag "charge-retried" (payment processor incident story).
 *   - IMPORTANT for any later analysis: createdAt on these orders is the import time.
 *     Always filter/group on processedAt.
 */

import fs from "node:fs";

const SHOP = process.env.SHOP || "dominic-coryell.myshopify.com";
const API_VERSION = process.env.API_VERSION || "2026-01";
const STATE_FILE = new URL("./seed-state.json", import.meta.url).pathname;

const SMOKE = process.argv.includes("--smoke");
const PURGE = process.argv.includes("--purge");
const YES = process.argv.includes("--yes");
const PLAN = process.argv.includes("--plan"); // print schedule stats only, no API calls
const SMOKE_COUNT = 20;
const TOTAL_ORDERS = 3500;

const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
if (!process.env.SHOPIFY_ADMIN_TOKEN && !(CLIENT_ID && CLIENT_SECRET) && !PLAN) {
  console.error("Set SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (Dev Dashboard app) or SHOPIFY_ADMIN_TOKEN in your shell (never store credentials in a file here).");
  process.exit(1);
}

// ---------- Access token (client credentials grant, 24h expiry) ----------
let tokenCache = process.env.SHOPIFY_ADMIN_TOKEN
  ? { token: process.env.SHOPIFY_ADMIN_TOKEN, expiresAt: Infinity }
  : { token: null, expiresAt: 0 };

async function getToken() {
  // refresh 10 minutes before expiry
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 10 * 60 * 1000) return tokenCache.token;
  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed: HTTP ${res.status} ${await res.text()}`);
  const body = await res.json();
  tokenCache = { token: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
  return tokenCache.token;
}

// ---------- GraphQL client with throttle handling ----------
async function gql(query, variables = {}, attempt = 0) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": await getToken() },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 6) throw new Error(`HTTP ${res.status} after ${attempt} retries`);
    await sleep(1500 * (attempt + 1));
    return gql(query, variables, attempt + 1);
  }
  const body = await res.json();
  if (body.errors) {
    // GraphQL errors are an array; auth/routing failures come back as a string
    // or object (e.g. {"errors":"[API] Invalid API key or access token"}).
    const errs = Array.isArray(body.errors) ? body.errors : [body.errors];
    const throttled = errs.some((e) => e?.extensions?.code === "THROTTLED");
    if (throttled && attempt < 6) {
      await sleep(2000 * (attempt + 1));
      return gql(query, variables, attempt + 1);
    }
    throw new Error(`HTTP ${res.status}: ${typeof body.errors === "string" ? body.errors : JSON.stringify(body.errors)}`);
  }
  const avail = body.extensions?.cost?.throttleStatus?.currentlyAvailable;
  if (avail !== undefined && avail < 200) await sleep(1000);
  return body.data;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Deterministic RNG ----------
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(20260913);
const rand = () => rng();
const randInt = (min, max) => min + Math.floor(rand() * (max - min + 1));
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

// ---------- State ----------
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
  catch { return { customers: {}, orders: {} }; }
}
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
}

// ---------- Data pools ----------
const FIRST = ["Emma","Liam","Sofie","Noah","Julia","Lucas","Mila","Finn","Lena","Jonas","Freja","Elias","Nora","Oscar","Ida","Anton","Maja","Felix","Clara","Hugo","Ella","Mats","Sara","Nils","Eva","Tim","Anna","Jan","Marie","Sven","Lotte","Erik","Amelie","Bram","Greta","Milan","Astrid","Kasper","Femke","Lars","Johanna","Piet","Ingrid","Thomas","Camille","Stefan","Elin","Ruben","Hanna","Joris","Sanne","Viktor","Lea","Arne","Tessa","Bjorn","Isabel","Daan","Mette","Paul"];
const LAST = ["Jansen","Muller","Nielsen","Andersson","de Vries","Schmidt","Hansen","Johansson","Bakker","Weber","Pedersen","Lindqvist","Visser","Becker","Larsen","Karlsson","Smit","Hoffmann","Christensen","Eriksson","Meijer","Wagner","Jorgensen","Nilsson","Mulder","Koch","Madsen","Persson","Bos","Richter","Sorensen","Svensson","de Jong","Klein","Rasmussen","Gustafsson","Vos","Wolf","Thomsen","Olsson","Peters","Neumann","Poulsen","Lindberg","Hendriks","Braun","Mortensen","Berg","Dekker","Schulz"];
const CITIES = [
  { city: "Amsterdam", countryCode: "NL", zip: "1012 AB" },
  { city: "Rotterdam", countryCode: "NL", zip: "3011 BR" },
  { city: "Utrecht", countryCode: "NL", zip: "3511 AD" },
  { city: "Berlin", countryCode: "DE", zip: "10115" },
  { city: "Hamburg", countryCode: "DE", zip: "20095" },
  { city: "Munich", countryCode: "DE", zip: "80331" },
  { city: "Vienna", countryCode: "AT", zip: "1010" },
  { city: "Brussels", countryCode: "BE", zip: "1000" },
  { city: "Antwerp", countryCode: "BE", zip: "2000" },
  { city: "Dublin", countryCode: "IE", zip: "D01 F5P2" },
  { city: "Helsinki", countryCode: "FI", zip: "00100" },
  { city: "Lisbon", countryCode: "PT", zip: "1100-148" },
];
const STREETS = ["Keizersgracht","Hauptstrasse","Kirkegade","Storgatan","Prinsenlaan","Bergweg","Lindenallee","Kanalvej","Havnegade","Parkstraat","Ringbahnstrasse","Molenweg"];

// months in window: index 0 = 2025-07 ... 13 = 2026-08
const MONTHS = Array.from({ length: 14 }, (_, i) => {
  const y = 2025 + Math.floor((6 + i) / 12);
  const m = ((6 + i) % 12) + 1;
  return { y, m };
});
function iso(y, m, d, h, min) {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:00+01:00`;
}

// ---------- Schedule generation (fully deterministic) ----------
function buildSchedule(catalog) {
  const coffee = catalog.filter((v) => v.subscription);
  const gear = catalog.filter((v) => !v.subscription);
  const customers = [];
  const orders = [];
  let custSeq = 0;

  function newCustomer(kind, tags = []) {
    const fn = pick(FIRST), ln = pick(LAST);
    custSeq += 1;
    const email = `${fn}.${ln}.${custSeq}@example.com`.toLowerCase().replace(/\s+/g, "");
    const loc = pick(CITIES);
    const c = {
      key: `c${custSeq}`, firstName: fn, lastName: ln, email, kind,
      tags: ["demo-seed", ...tags],
      address: {
        address1: `${pick(STREETS)} ${randInt(1, 180)}`,
        city: loc.city, countryCode: loc.countryCode, zip: loc.zip,
        firstName: fn, lastName: ln,
      },
    };
    customers.push(c);
    return c;
  }

  // --- Subscribers ---
  // Regular joins across months 0..12 with a growth ramp; plus the bf-promo cohort (60) in month 4 (Nov 2025).
  const joinWeights = MONTHS.slice(0, 13).map((_, i) => 8 + i * 1.6);
  const wSum = joinWeights.reduce((a, b) => a + b, 0);
  const regularJoins = joinWeights.map((w) => Math.round((w / wSum) * 340));
  const subscribers = [];
  regularJoins.forEach((n, monthIdx) => {
    for (let k = 0; k < n; k++) subscribers.push({ joinMonth: monthIdx, promo: false });
  });
  for (let k = 0; k < 60; k++) subscribers.push({ joinMonth: 4, promo: true });

  for (const sub of subscribers) {
    const cust = newCustomer("subscriber", sub.promo ? ["subscriber", "bf-promo"] : ["subscriber"]);
    const variant = pick(coffee);
    const qty = rand() < 0.85 ? 1 : 2;
    const day = randInt(1, 28);
    // churn month (exclusive): promo cohort churns almost entirely in month 7 (Feb 2026)
    let endMonth = 14;
    if (sub.promo) {
      endMonth = rand() < 0.85 ? 7 + (rand() < 0.3 ? 1 : 0) : 14;
    } else {
      for (let m = sub.joinMonth + 1; m < 14; m++) {
        if (rand() < 0.04) { endMonth = m; break; }
      }
    }
    let n = 0;
    for (let m = sub.joinMonth; m < endMonth && m < 14; m++) {
      const { y, m: mm } = MONTHS[m];
      const jitter = n === 0 ? 0 : randInt(-2, 2);
      const d = Math.min(28, Math.max(1, day + jitter));
      const lineItems = [{ variantId: variant.id, quantity: qty }];
      if (rand() < 0.08) lineItems.push({ variantId: pick(gear).id, quantity: 1 });
      orders.push({
        customerKey: cust.key,
        processedAt: iso(y, mm, d, randInt(6, 22), randInt(0, 59)),
        lineItems,
        tags: ["demo-seed", "Subscription", n === 0 ? "Subscription First Order" : "Subscription Recurring Order"],
        attrs: [{ key: "subscription_interval", value: "1 month" }],
      });
      n += 1;
    }
  }

  // --- Failed-charge cluster: recurring orders due 8-14 May 2026 mostly slip 3-5 days ---
  for (const o of orders) {
    const dt = o.processedAt.slice(0, 10);
    if (dt >= "2026-05-08" && dt <= "2026-05-14" && o.tags.includes("Subscription Recurring Order") && rand() < 0.65) {
      const d = new Date(o.processedAt);
      d.setDate(d.getDate() + randInt(3, 5));
      o.processedAt = d.toISOString().replace(/\.\d{3}Z$/, "+00:00");
      o.tags.push("charge-retried");
      o.attrs.push({ key: "charge_retry_count", value: String(randInt(1, 3)) });
    }
  }

  // --- One-time buyers fill the remainder to exactly TOTAL_ORDERS ---
  const oneTimeCount = TOTAL_ORDERS - orders.length;
  if (oneTimeCount < 0) throw new Error(`subscription orders (${orders.length}) already exceed ${TOTAL_ORDERS}`);
  const monthWeights = MONTHS.map((_, i) => (1 + 0.06 * i) * (i === 4 ? 1.5 : i === 5 ? 1.7 : 1));
  const mwSum = monthWeights.reduce((a, b) => a + b, 0);
  const buyers = [];
  for (let k = 0; k < oneTimeCount; k++) {
    let cust;
    if (buyers.length && rand() < 0.25) cust = pick(buyers);
    else { cust = newCustomer("one-time"); buyers.push(cust); }
    let r = rand() * mwSum, monthIdx = 0;
    for (let i = 0; i < monthWeights.length; i++) { r -= monthWeights[i]; if (r <= 0) { monthIdx = i; break; } }
    const { y, m } = MONTHS[monthIdx];
    const lineItems = [];
    const nItems = rand() < 0.6 ? 1 : rand() < 0.8 ? 2 : 3;
    for (let i = 0; i < nItems; i++) lineItems.push({ variantId: pick(rand() < 0.55 ? gear : coffee).id, quantity: 1 });
    orders.push({
      customerKey: cust.key,
      processedAt: iso(y, m, randInt(1, 28), randInt(6, 22), randInt(0, 59)),
      lineItems, tags: ["demo-seed"], attrs: [],
    });
  }

  orders.sort((a, b) => a.processedAt.localeCompare(b.processedAt));
  orders.forEach((o, i) => (o.key = `o${i}`));
  return { customers, orders };
}

// ---------- Store operations ----------
async function fetchCatalog() {
  const data = await gql(`query { products(first: 30, query: "vendor:'Nordkap Roasters'") {
    nodes { productType variants(first: 10) { nodes { id title price } } } } }`);
  const variants = [];
  for (const p of data.products.nodes)
    for (const v of p.variants.nodes)
      variants.push({ id: v.id, price: v.price, subscription: p.productType === "Coffee" });
  if (!variants.length) throw new Error("No Nordkap Roasters variants found in store");
  return variants;
}

async function ensureCustomer(state, cust) {
  if (state.customers[cust.key]) return state.customers[cust.key];
  const data = await gql(
    `mutation ($input: CustomerInput!) { customerCreate(input: $input) {
       customer { id } userErrors { field message } } }`,
    { input: { firstName: cust.firstName, lastName: cust.lastName, email: cust.email,
               tags: cust.tags, addresses: [cust.address] } }
  );
  const errs = data.customerCreate.userErrors;
  if (errs.length) throw new Error(`customerCreate ${cust.email}: ${JSON.stringify(errs)}`);
  state.customers[cust.key] = data.customerCreate.customer.id;
  saveState(state);
  return state.customers[cust.key];
}

async function createOrder(state, order, customerId, catalogById) {
  if (state.orders[order.key]) return false;
  const total = order.lineItems
    .reduce((s, li) => s + parseFloat(catalogById[li.variantId].price) * li.quantity, 0)
    .toFixed(2);
  const data = await gql(
    `mutation ($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
       orderCreate(order: $order, options: $options) {
         order { id name } userErrors { field message } } }`,
    {
      order: {
        customer: { toAssociate: { id: customerId } },
        processedAt: order.processedAt,
        financialStatus: "PAID",
        fulfillmentStatus: "FULFILLED",
        currency: "EUR",
        lineItems: order.lineItems,
        tags: order.tags,
        customAttributes: order.attrs,
        transactions: [{ kind: "SALE", status: "SUCCESS",
          amountSet: { shopMoney: { amount: total, currencyCode: "EUR" } } }],
      },
      options: { sendReceipt: false, sendFulfillmentReceipt: false, inventoryBehaviour: "BYPASS" },
    }
  );
  const errs = data.orderCreate.userErrors;
  if (errs.length) throw new Error(`orderCreate ${order.key}: ${JSON.stringify(errs)}`);
  state.orders[order.key] = { id: data.orderCreate.order.id, name: data.orderCreate.order.name };
  saveState(state);
  return true;
}

// ---------- Purge ----------
async function purge() {
  if (!YES) { console.error("Refusing to purge without --yes"); process.exit(1); }
  let deleted = 0;
  for (;;) {
    const data = await gql(`query { orders(first: 50, query: "tag:demo-seed") { nodes { id } } }`);
    const nodes = data.orders.nodes;
    if (!nodes.length) break;
    for (const n of nodes) {
      await gql(`mutation ($orderId: ID!) { orderDelete(orderId: $orderId) { userErrors { message } } }`, { orderId: n.id });
      deleted += 1;
      if (deleted % 100 === 0) console.log(`deleted ${deleted} orders...`);
    }
  }
  console.log(`deleted ${deleted} orders`);
  let cdeleted = 0;
  for (;;) {
    const data = await gql(`query { customers(first: 50, query: "tag:demo-seed") { nodes { id } } }`);
    const nodes = data.customers.nodes;
    if (!nodes.length) break;
    for (const n of nodes) {
      await gql(`mutation ($input: CustomerDeleteInput!) { customerDelete(input: $input) { userErrors { message } } }`, { input: { id: n.id } });
      cdeleted += 1;
    }
  }
  console.log(`deleted ${cdeleted} customers`);
  try { fs.unlinkSync(STATE_FILE); } catch {}
}

// ---------- Main ----------
function planReport() {
  const fake = Array.from({ length: 30 }, (_, i) => ({ id: `v${i}`, price: "13.00", subscription: i < 19 }));
  const { customers, orders } = buildSchedule(fake);
  const byMonth = {};
  for (const o of orders) {
    const ym = o.processedAt.slice(0, 7);
    byMonth[ym] = byMonth[ym] || { total: 0, sub: 0, retried: 0 };
    byMonth[ym].total += 1;
    if (o.tags.includes("Subscription")) byMonth[ym].sub += 1;
    if (o.tags.includes("charge-retried")) byMonth[ym].retried += 1;
  }
  console.log(`orders: ${orders.length}, customers: ${customers.length}`);
  console.log(`subscribers: ${customers.filter((c) => c.kind === "subscriber").length}, one-time buyers: ${customers.filter((c) => c.kind === "one-time").length}`);
  console.log(`promo cohort: ${customers.filter((c) => c.tags.includes("bf-promo")).length}`);
  console.log("month      total   sub   retried");
  for (const [ym, s] of Object.entries(byMonth).sort())
    console.log(`${ym}   ${String(s.total).padStart(5)} ${String(s.sub).padStart(5)} ${String(s.retried).padStart(6)}`);
}

async function main() {
  if (PLAN) return planReport();
  if (PURGE) return purge();

  const catalog = await fetchCatalog();
  const catalogById = Object.fromEntries(catalog.map((v) => [v.id, v]));
  const { customers, orders } = buildSchedule(catalog);
  const customersByKey = Object.fromEntries(customers.map((c) => [c.key, c]));
  console.log(`schedule: ${orders.length} orders, ${customers.length} customers`);
  const subCount = orders.filter((o) => o.tags.includes("Subscription")).length;
  console.log(`  subscription orders: ${subCount}, one-time: ${orders.length - subCount}`);
  console.log(`  window: ${orders[0].processedAt} .. ${orders[orders.length - 1].processedAt}`);

  const state = loadState();
  const target = SMOKE ? orders.slice(0, SMOKE_COUNT) : orders;
  let created = 0, skipped = 0;
  for (const order of target) {
    if (state.orders[order.key]) { skipped += 1; continue; }
    const cust = customersByKey[order.customerKey];
    const customerId = await ensureCustomer(state, cust);
    await createOrder(state, order, customerId, catalogById);
    created += 1;
    if (created % 25 === 0) console.log(`created ${created}/${target.length - skipped} (latest: ${order.processedAt.slice(0, 10)})`);
    await sleep(250);
  }
  console.log(`done: ${created} orders created, ${skipped} already existed.`);
  if (SMOKE) console.log("\nSMOKE TEST COMPLETE — eyeball an order in admin before the full run (Step 5 in the runbook).");
}

main().catch((e) => { console.error(e); process.exit(1); });
