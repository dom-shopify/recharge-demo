// Automated test checkout on happyhootsnft.com (dominic-coryell dev store).
// Buys one subscription item as a given customer so Shopify vaults the test card,
// which is the prerequisite for creating that customer in Recharge.
//
// Usage: node checkout.mjs <customer.json> [--headed]
//   customer.json: { email, firstName, lastName, address1, city, zip, country,
//                    variantId, sellingPlanId }
// Env: STORE_PASSWORD (storefront password)
//
// Test card: 4242 4242 4242 4242 — requires Shopify Payments test mode.

import { chromium } from "playwright";
import fs from "node:fs";

const args = process.argv.slice(2);
const headed = args.includes("--headed");
const custFile = args.find((a) => !a.startsWith("--"));
const c = JSON.parse(fs.readFileSync(custFile, "utf8"));
const PASSWORD = process.env.STORE_PASSWORD; // optional — store may be unlocked

const BASE = "https://happyhootsnft.com";
const shots = `shots/${c.email.split("@")[0]}`;
fs.mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(30000);

async function shot(name) {
  await page.screenshot({ path: `${shots}/${name}.png`, fullPage: false });
}

try {
  // 1. Storefront password gate (skipped when the store is unlocked)
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  if (page.url().includes("/password")) {
    if (!PASSWORD) throw new Error("store is password-protected but STORE_PASSWORD not set");
    const pwInput = page.locator('input[type="password"], input[name="password"]').first();
    await pwInput.fill(PASSWORD);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => {}),
      pwInput.press("Enter"),
    ]);
    await shot("1-after-password");
    if (page.url().includes("/password")) throw new Error("password rejected");
  }

  // 2. Add subscription item via cart/add.js (permalinks drop selling_plan), then checkout
  const added = await page.evaluate(
    async ({ variantId, sellingPlanId }) => {
      const r = await fetch("/cart/add.js", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: [{ id: Number(variantId), quantity: 1, selling_plan: Number(sellingPlanId) }],
        }),
      });
      return { status: r.status, body: await r.text() };
    },
    { variantId: c.variantId, sellingPlanId: c.sellingPlanId }
  );
  if (added.status !== 200) throw new Error(`cart/add.js ${added.status}: ${added.body.slice(0, 300)}`);
  const item = JSON.parse(added.body).items?.[0];
  if (!item?.selling_plan_allocation) throw new Error("selling plan not applied to cart item");
  await page.goto(`${BASE}/checkout`, { waitUntil: "domcontentloaded" });
  await page.waitForURL(/checkouts/, { timeout: 30000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await shot("2-checkout-loaded");

  // 3. Contact + shipping
  const email = page.locator('input[id="email"], input[name="email"]').first();
  await email.waitFor();
  await email.fill(c.email);

  async function fillIf(sel, value) {
    const loc = page.locator(sel).first();
    if (await loc.count()) { await loc.fill(value); return true; }
    return false;
  }
  const country = page.locator('select[name="countryCode"]').first();
  if (await country.count()) {
    const opts = await country.locator("option").evaluateAll((os) =>
      os.map((o) => ({ value: o.value, label: o.textContent.trim() }))
    );
    const hit =
      opts.find((o) => o.value === c.country) ||
      opts.find((o) => o.label.toLowerCase() === (c.countryName || "").toLowerCase());
    if (!hit) throw new Error(`country ${c.country} not shippable; options: ${opts.map((o) => o.value).join(",")}`);
    await country.selectOption(hit.value);
  }
  await fillIf('input[name="firstName"]', c.firstName);
  await fillIf('input[name="lastName"]', c.lastName);
  const addr = page.locator('input[name="address1"]').first();
  await addr.fill(c.address1);
  await page.keyboard.press("Escape"); // dismiss address autocomplete
  await fillIf('input[name="city"]', c.city);
  await fillIf('input[name="postalCode"]', c.zip);
  // Province/state: find any select that isn't the country dropdown
  for (const zone of await page.locator("select").all()) {
    const name = (await zone.getAttribute("name")) || "";
    if (name === "countryCode") continue;
    const zopts = await zone.locator("option").evaluateAll((os) =>
      os.map((o) => ({ value: o.value, label: o.textContent.trim() }))
    );
    const want = (c.province || c.city || "").toLowerCase();
    let zhit =
      zopts.find((o) => o.value && o.value.toLowerCase() === want) ||
      zopts.find((o) => o.value && o.label.toLowerCase() === want) ||
      zopts.find((o) => o.value && o.label.toLowerCase().startsWith(want));
    if (!zhit) {
      console.error(`no exact zone match for "${want}"; options: ${JSON.stringify(zopts.slice(0, 60))}`);
      zhit = zopts.find((o) => o.value); // any non-empty option as last resort
    }
    if (zhit) {
      await zone.selectOption(zhit.value);
      console.error(`zone select name="${name}" -> ${zhit.label} (${zhit.value})`);
    }
  }
  await shot("3-contact-filled");

  // 4. Card fields live in iframes
  const frameFor = async (namePart) => {
    const fl = page.frameLocator(`iframe[title*="${namePart}"]`);
    return fl;
  };
  const numberFrame = page.frameLocator('iframe[title*="card number" i], iframe[id^="card-fields-number"]').first
    ? page.frameLocator('iframe[title*="card number" i]')
    : null;

  // simpler: iterate all card-fields iframes by their input names
  async function fillCardField(inputName, value) {
    for (const frame of page.frames()) {
      try {
        const input = frame.locator(`input[name="${inputName}"]`);
        if (await input.count()) { await input.fill(value); return true; }
      } catch {}
    }
    return false;
  }
  await page.waitForFunction(
    () => [...document.querySelectorAll("iframe")].some((f) => (f.id || "").startsWith("card-fields")),
    { timeout: 30000 }
  ).catch(() => {});
  const okNum = await fillCardField("number", "4242 4242 4242 4242");
  await fillCardField("expiry", "12/29");
  await fillCardField("verification_value", "123");
  await fillCardField("name", `${c.firstName} ${c.lastName}`);
  if (!okNum) throw new Error("card number field not found");
  await shot("4-card-filled");

  // 5. Wait for shipping methods to resolve, then pay
  await page
    .locator('input[name="shipping-methods"], [id*="shipping"] input[type="radio"]')
    .first()
    .waitFor({ timeout: 15000 })
    .catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});
  const pay = page.locator('button#checkout-pay-button, button:has-text("Pay now"), button:has-text("Subscribe now")').first();
  await pay.click();
  await page.waitForURL(/thank[-_]?you|post_purchase|processing/, { timeout: 60000 }).catch(() => {});
  await page.waitForLoadState("networkidle").catch(() => {});
  await shot("5-after-pay");

  const url = page.url();
  const body = (await page.textContent("body").catch(() => "")) || "";
  const confirmed = /thank[-_]?you/.test(url) || /confirmed|thank you/i.test(body.slice(0, 3000));
  console.log(JSON.stringify({ email: c.email, url, confirmed }));
  process.exit(confirmed ? 0 : 1);
} catch (e) {
  await shot("error");
  console.error(JSON.stringify({ email: c.email, error: String(e.message || e), url: page.url() }));
  process.exit(1);
} finally {
  await browser.close();
}
