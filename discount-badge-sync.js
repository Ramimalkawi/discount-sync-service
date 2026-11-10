// discount-badge-sync.js
// Keeps product metafield custom.auto_discount_badge in sync with ACTIVE Shopify discounts
// (automatic + code, percentage + fixed amount, specific products / variants / collections).
//
// Mount it in your Express server BEFORE app.use(express.json(...)):
//   require("./discount-badge-sync")(app);
//
// Env vars (Render):
//   SHOPIFY_SHOP_DOMAIN     e.g. estoreapple.myshopify.com
//   SHOPIFY_ADMIN_TOKEN     Admin API access token (shpat_...)
//   SHOPIFY_WEBHOOK_SECRET  the app's API secret key (used to verify webhooks)
//   SYNC_SECRET             any long random string (protects /run and /register)
//   SHOPIFY_API_VERSION     optional, default 2025-10
//   PUBLIC_URL              optional, default https://business-inquiry-backend.onrender.com

const crypto = require("crypto");
const express = require("express");

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN;
const TOKEN = process.env.SHOPIFY_ADMIN_TOKEN; // optional
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;
// Webhooks are signed with the app's client secret
const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET || CLIENT_SECRET;
const SYNC_SECRET = process.env.SYNC_SECRET;
const API_VERSION = process.env.SHOPIFY_API_VERSION || "2025-10";
const PUBLIC_URL = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;

const BADGE_NS = "custom";
const BADGE_KEY = "auto_discount_badge";
const STATE_NS = "discount_sync";
const STATE_KEY = "badged_products"; // shop metafield: JSON map { productGid: badgeText }
const SYNC_EVERY_MS = 10 * 60 * 1000; // catches discounts that start/end by schedule

// Dev Dashboard apps get a short-lived token (~24h) via the client credentials grant.
let cachedToken = null;
let tokenExpiresAt = 0;

async function getToken() {
  if (TOKEN) return TOKEN; // optional: a static token still works if you ever have one
  if (cachedToken && Date.now() < tokenExpiresAt - 5 * 60 * 1000) return cachedToken;
  const res = await fetch(`https://${SHOP}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  if (!res.ok) throw new Error(`Token request failed HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  cachedToken = json.access_token;
  tokenExpiresAt = Date.now() + (json.expires_in || 86400) * 1000;
  return cachedToken;
}

async function gql(query, variables = {}) {
  const token = await getToken();
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Shopify HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`Shopify GraphQL: ${JSON.stringify(json.errors)}`);
  return json.data;
}

// ---------- 1. Read active discounts ----------

async function fetchActiveDiscountIds() {
  const ids = [];
  let after = null;
  do {
    const data = await gql(
      `query($after: String) {
        discountNodes(first: 100, after: $after, query: "status:active") {
          pageInfo { hasNextPage endCursor }
          nodes { id }
        }
      }`,
      { after }
    );
    const conn = data.discountNodes;
    ids.push(...conn.nodes.map((n) => n.id));
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);
  return ids;
}

const DETAIL_QUERY = `
query($id: ID!) {
  discountNode(id: $id) {
    id
    discount {
      __typename
      ... on DiscountAutomaticBasic { title customerGets { ...CG } }
      ... on DiscountCodeBasic { title codes(first: 1) { nodes { code } } customerGets { ...CG } }
    }
  }
}
fragment CG on DiscountCustomerGets {
  value {
    __typename
    ... on DiscountPercentage { percentage }
    ... on DiscountAmount { amount { amount currencyCode } }
  }
  items {
    __typename
    ... on DiscountProducts {
      products(first: 250) { nodes { id } }
      productVariants(first: 250) { nodes { product { id } } }
    }
    ... on DiscountCollections { collections(first: 25) { nodes { id } } }
  }
}`;

async function fetchCollectionProductIds(collectionId) {
  const ids = [];
  let after = null;
  do {
    const data = await gql(
      `query($id: ID!, $after: String) {
        collection(id: $id) {
          products(first: 250, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { id }
          }
        }
      }`,
      { id: collectionId, after }
    );
    const conn = data.collection && data.collection.products;
    if (!conn) break;
    ids.push(...conn.nodes.map((n) => n.id));
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);
  return ids;
}

function formatMoney(amount, currency) {
  const n = Number(amount);
  const num = Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return `${num} ${currency === "JOD" ? "JD" : currency}`;
}

// Returns { productIds: string[], text, pct, amt } or null if the discount is not supported.
async function describeDiscount(id) {
  const data = await gql(DETAIL_QUERY, { id });
  const d = data.discountNode && data.discountNode.discount;
  if (!d || !d.customerGets) return null; // BXGY, free shipping, etc. are skipped

  const value = d.customerGets.value;
  let text, pct = 0, amt = 0;
  if (value.__typename === "DiscountPercentage") {
    pct = Math.round(value.percentage * 100 * 100) / 100;
    text = `${pct}% OFF`;
  } else if (value.__typename === "DiscountAmount") {
    amt = Number(value.amount.amount);
    text = `Save ${formatMoney(value.amount.amount, value.amount.currencyCode)}`;
  } else {
    return null;
  }

  // For code discounts, show the code so customers know what to type.
  const code = d.codes && d.codes.nodes[0] && d.codes.nodes[0].code;
  if (code) text += ` · Code: ${code}`;

  const items = d.customerGets.items;
  const productIds = new Set();
  if (items.__typename === "DiscountProducts") {
    items.products.nodes.forEach((p) => productIds.add(p.id));
    items.productVariants.nodes.forEach((v) => productIds.add(v.product.id));
  } else if (items.__typename === "DiscountCollections") {
    for (const c of items.collections.nodes) {
      (await fetchCollectionProductIds(c.id)).forEach((pid) => productIds.add(pid));
    }
  } else {
    return null; // "all items" discounts are skipped on purpose (no per-product badge)
  }
  return { productIds: [...productIds], text, pct, amt };
}

// Builds { productGid: badgeText }. If several discounts hit one product, the best one wins.
async function buildDesiredBadges() {
  const ids = await fetchActiveDiscountIds();
  const best = new Map(); // productId -> { text, pct, amt }
  for (const id of ids) {
    const info = await describeDiscount(id);
    if (!info) continue;
    for (const pid of info.productIds) {
      const cur = best.get(pid);
      if (!cur || info.pct > cur.pct || (info.pct === cur.pct && info.amt > cur.amt)) {
        best.set(pid, info);
      }
    }
  }
  const out = {};
  for (const [pid, info] of best) out[pid] = info.text;
  return out;
}

// ---------- 2. Persisted state (so we know what to clear) ----------

async function loadState() {
  const data = await gql(
    `query($ns: String!, $key: String!) {
      shop { id metafield(namespace: $ns, key: $key) { value } }
    }`,
    { ns: STATE_NS, key: STATE_KEY }
  );
  let map = {};
  try {
    if (data.shop.metafield) map = JSON.parse(data.shop.metafield.value);
  } catch (_) {}
  return { shopId: data.shop.id, map };
}

async function saveState(shopId, map) {
  await metafieldsSet([
    {
      ownerId: shopId,
      namespace: STATE_NS,
      key: STATE_KEY,
      type: "json",
      value: JSON.stringify(map),
    },
  ]);
}

// ---------- 3. Write / delete product metafields ----------

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function metafieldsSet(inputs) {
  for (const batch of chunk(inputs, 25)) {
    const data = await gql(
      `mutation($m: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $m) { userErrors { field message } }
      }`,
      { m: batch }
    );
    const errs = data.metafieldsSet.userErrors;
    if (errs.length) console.error("[discount-sync] metafieldsSet errors:", JSON.stringify(errs));
  }
}

async function metafieldsDelete(identifiers) {
  for (const batch of chunk(identifiers, 25)) {
    const data = await gql(
      `mutation($m: [MetafieldIdentifierInput!]!) {
        metafieldsDelete(metafields: $m) { userErrors { field message } }
      }`,
      { m: batch }
    );
    const errs = data.metafieldsDelete.userErrors;
    if (errs.length) console.error("[discount-sync] metafieldsDelete errors:", JSON.stringify(errs));
  }
}

// ---------- 4. Sync (with a lock so webhook bursts don't overlap) ----------

let running = false;
let pending = false;

async function runSync(reason) {
  if (running) {
    pending = true;
    return;
  }
  running = true;
  try {
    do {
      pending = false;
      console.log(`[discount-sync] start (${reason})`);
      const desired = await buildDesiredBadges();
      const { shopId, map: previous } = await loadState();

      const toSet = Object.entries(desired)
        .filter(([pid, text]) => previous[pid] !== text)
        .map(([pid, text]) => ({
          ownerId: pid,
          namespace: BADGE_NS,
          key: BADGE_KEY,
          type: "single_line_text_field",
          value: text,
        }));

      const toClear = Object.keys(previous)
        .filter((pid) => !(pid in desired))
        .map((pid) => ({ ownerId: pid, namespace: BADGE_NS, key: BADGE_KEY }));

      if (toSet.length) await metafieldsSet(toSet);
      if (toClear.length) await metafieldsDelete(toClear);
      await saveState(shopId, desired);

      console.log(`[discount-sync] done: set ${toSet.length}, cleared ${toClear.length}`);
    } while (pending);
  } catch (err) {
    console.error("[discount-sync] failed:", err.message);
  } finally {
    running = false;
  }
}

// ---------- 5. Routes ----------

function verifyWebhook(rawBody, hmacHeader) {
  if (!WEBHOOK_SECRET || !hmacHeader) return false;
  const digest = crypto.createHmac("sha256", WEBHOOK_SECRET).update(rawBody).digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(hmacHeader);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireSecret(req, res, next) {
  if (!SYNC_SECRET || req.get("x-sync-secret") !== SYNC_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

module.exports = function registerDiscountBadgeSync(app) {
  if (!SHOP || !(TOKEN || (CLIENT_ID && CLIENT_SECRET))) {
    console.warn("[discount-sync] SHOPIFY_SHOP_DOMAIN and SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET missing, sync disabled");
    return;
  }

  // Webhook receiver (raw body needed for HMAC, so this must be mounted before express.json)
  app.post(
    "/webhooks/shopify/discounts",
    express.raw({ type: "application/json" }),
    (req, res) => {
      if (!verifyWebhook(req.body, req.get("x-shopify-hmac-sha256"))) {
        return res.sendStatus(401);
      }
      res.sendStatus(200); // answer fast, work afterwards
      runSync(`webhook ${req.get("x-shopify-topic")}`);
    }
  );

  // Manual / cron trigger:  curl -X POST -H "x-sync-secret: ..." <url>/api/discount-sync/run
  app.post("/api/discount-sync/run", requireSecret, (req, res) => {
    runSync("manual");
    res.json({ started: true });
  });

  // One-time webhook registration
  app.post("/api/discount-sync/register", requireSecret, async (req, res) => {
    try {
      const results = [];
      for (const topic of ["DISCOUNTS_CREATE", "DISCOUNTS_UPDATE", "DISCOUNTS_DELETE"]) {
        const data = await gql(
          `mutation($topic: WebhookSubscriptionTopic!, $url: URL!) {
            webhookSubscriptionCreate(
              topic: $topic
              webhookSubscription: { callbackUrl: $url, format: JSON }
            ) {
              webhookSubscription { id topic }
              userErrors { field message }
            }
          }`,
          { topic, url: `${PUBLIC_URL}/webhooks/shopify/discounts` }
        );
        results.push(data.webhookSubscriptionCreate);
      }
      res.json(results);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Scheduled discounts start/end without a webhook, so reconcile periodically.
  setTimeout(() => runSync("startup"), 5000);
  setInterval(() => runSync("interval"), SYNC_EVERY_MS);

  console.log("[discount-sync] ready");
};
