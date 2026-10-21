// Apex King Digital — Stripe bridge.
//
// Purpose: a storefront service (HKL) asks this service to create Stripe
// Checkout Sessions under the Apex account. Stripe only ever sees Apex:
// the API calls, the success/cancel URLs (this domain), and the metadata
// (an opaque ref) all belong to Apex King Digital. Products are named with
// bare SKUs — basic and vague by design.
//
// Env (Render dashboard on the apex-dashboard service):
//   STRIPE_SECRET_KEY    — live secret/restricted key for the Apex account
//   STRIPE_WEBHOOK_SECRET — signing secret for /api/bridge/webhook
//   BRIDGE_SECRET        — shared secret with the storefront service
//   BRIDGE_NOTIFY_URL    — optional, defaults to the HKL settled endpoint
//   BRIDGE_INTENT_NOTIFY_URL — optional, defaults to the HKL stripe-intent
//                        endpoint (pay-to-submit PaymentIntent callbacks,
//                        see docs/STRIPE-EMBEDDED-BRIDGE.md in the HKL repo)
"use strict";
const fs = require("fs");
const path = require("path");
const https = require("https");
const crypto = require("crypto");

const STORE_FILE = process.env.DATA_FILE
  ? path.join(path.dirname(process.env.DATA_FILE), "bridge.json")
  : path.join(__dirname, "data", "bridge.json");
const NOTIFY_URL = process.env.BRIDGE_NOTIFY_URL || "https://helixkinglabs.com/api/payments/stripe-settled";
const INTENT_NOTIFY_URL = process.env.BRIDGE_INTENT_NOTIFY_URL || "https://helixkinglabs.com/api/payments/stripe-intent";
const SELF = "https://dashboard.apexkingdigital.com";

function loadStore() {
  try {
    const d = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    return { products: d.products || {}, returns: d.returns || {} };
  } catch {
    return { products: {}, returns: {} };
  }
}
function saveStore(s) {
  try {
    fs.mkdirSync(path.dirname(STORE_FILE), { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(s, null, 2));
  } catch (e) {
    console.error("bridge store save", e.message);
  }
}

function formEncode(obj, prefix, out) {
  out = out || [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? prefix + "[" + k + "]" : k;
    if (v === undefined || v === null) continue;
    if (typeof v === "object") formEncode(v, key, out);
    else out.push(encodeURIComponent(key) + "=" + encodeURIComponent(String(v)));
  }
  return out.join("&");
}

function stripeCall(method, apiPath, params, extraHeaders) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return Promise.reject(new Error("stripe_key_missing"));
  const body = params ? formEncode(params) : "";
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.stripe.com",
        path: apiPath,
        method,
        headers: Object.assign(
          {
            Authorization: "Bearer " + key,
            "Content-Type": "application/x-www-form-urlencoded",
            "Content-Length": Buffer.byteLength(body),
          },
          extraHeaders || {}
        ),
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          try {
            const data = JSON.parse(raw);
            if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
            else reject(new Error("stripe " + res.statusCode + ": " + ((data.error && data.error.message) || raw.slice(0, 200))));
          } catch {
            reject(new Error("stripe_bad_response"));
          }
        });
      }
    );
    req.setTimeout(15000, () => {
      req.destroy();
      reject(new Error("stripe_timeout"));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function productForSku(sku, store) {
  if (store.products[sku]) return store.products[sku];
  const q = encodeURIComponent("name:'" + sku.replace(/'/g, "") + "' AND active:'true'");
  try {
    const found = await stripeCall("GET", "/v1/products/search?query=" + q);
    if (found.data && found.data.length) {
      store.products[sku] = found.data[0].id;
      saveStore(store);
      return found.data[0].id;
    }
  } catch (e) {
    console.error("product search", sku, e.message);
  }
  const created = await stripeCall("POST", "/v1/products", { name: sku });
  store.products[sku] = created.id;
  saveStore(store);
  return created.id;
}

function secretOk(req) {
  const secret = process.env.BRIDGE_SECRET;
  const given = String((req.headers && req.headers["x-bridge-secret"]) || "");
  if (!secret || !given || given.length !== secret.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}

function verifyWebhook(raw, sigHeader, secret) {
  if (!raw || !sigHeader || !secret) return false;
  const parts = {};
  for (const piece of String(sigHeader).split(",")) {
    const i = piece.indexOf("=");
    if (i > 0) parts[piece.slice(0, i).trim()] = piece.slice(i + 1).trim();
  }
  if (!parts.t || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return false;
  const expect = crypto.createHmac("sha256", secret).update(parts.t + "." + raw.toString("utf8")).digest("hex");
  const a = Buffer.from(parts.v1);
  const b = Buffer.from(expect);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function notifySettled(payload, attempt) {
  attempt = attempt || 1;
  const secret = process.env.BRIDGE_SECRET;
  if (!secret) return;
  const body = JSON.stringify(payload);
  let u;
  try {
    u = new URL(NOTIFY_URL);
  } catch {
    return;
  }
  const req = https.request(
    {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname,
      method: "POST",
      headers: { "x-bridge-secret": secret, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    },
    (res) => {
      res.resume();
      if (res.statusCode >= 500 && attempt < 3) setTimeout(() => notifySettled(payload, attempt + 1), 5000 * attempt);
    }
  );
  req.setTimeout(10000, () => req.destroy());
  req.on("error", () => {
    if (attempt < 3) setTimeout(() => notifySettled(payload, attempt + 1), 5000 * attempt);
  });
  req.write(body);
  req.end();
}

// Signed callback for pay-to-submit PaymentIntent events. HKL verifies
// x-bridge-signature = hex(HMAC_SHA256(BRIDGE_SECRET, timestamp + "." + rawBody))
// with a ±5 min window, then re-reads the intent through the bridge before
// acting, so this callback is a trigger, never the source of truth.
// Retries on any non-2xx (HKL finalize is idempotent).
function notifyIntent(payload, attempt) {
  attempt = attempt || 1;
  const secret = process.env.BRIDGE_SECRET;
  if (!secret) return;
  const rawBody = JSON.stringify(payload);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac("sha256", secret).update(ts + "." + rawBody).digest("hex");
  let u;
  try {
    u = new URL(INTENT_NOTIFY_URL);
  } catch {
    return;
  }
  const retry = () => {
    if (attempt < 3) setTimeout(() => notifyIntent(payload, attempt + 1), 5000 * attempt);
  };
  const req = https.request(
    {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname,
      method: "POST",
      headers: {
        "x-bridge-secret": secret,
        "x-bridge-timestamp": ts,
        "x-bridge-signature": sig,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(rawBody),
      },
    },
    (res) => {
      res.resume();
      if (res.statusCode < 200 || res.statusCode >= 300) retry();
    }
  );
  req.setTimeout(10000, () => req.destroy());
  req.on("error", retry);
  req.write(rawBody);
  req.end();
}

// Compact items snapshot for PaymentIntent metadata (Stripe caps metadata
// values at 500 chars): [sku, qty, unitCents] triples, tail-dropped to fit.
function compactItems(items) {
  const triples = (Array.isArray(items) ? items : []).map((i) => [
    String((i && i.sku) || "").slice(0, 40),
    Math.max(1, Math.floor(Number((i && i.qty) || 1))),
    Math.round(Number((i && i.unitCents) || 0)),
  ]);
  let s = JSON.stringify(triples);
  while (s.length > 500 && triples.length) {
    triples.pop();
    s = JSON.stringify(triples);
  }
  return s;
}

function mountStripeBridge(app) {
  // Create a Checkout Session for a storefront order.
  app.post("/api/bridge/checkout", async (req, res) => {
    if (!secretOk(req)) return res.status(401).json({ error: "bad_secret" });
    if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: "stripe_key_missing" });
    const b = req.body || {};
    const ref = String(b.ref || "").slice(0, 80);
    const amountCents = Math.round(Number(b.amountCents || 0));
    const items = Array.isArray(b.items) ? b.items : [];
    if (!ref || !(amountCents > 0) || !items.length) return res.status(400).json({ error: "bad_request" });
    const sum = items.reduce((a, i) => a + Math.round(Number(i.unitCents || 0)) * Math.max(1, Math.floor(Number(i.qty || 1))), 0);
    if (sum !== amountCents) return res.status(400).json({ error: "amount_mismatch" });
    try {
      const store = loadStore();
      const line_items = [];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const sku = String(it.sku || "ITEM").slice(0, 60);
        const product = await productForSku(sku, store);
        line_items.push({
          quantity: Math.max(1, Math.floor(Number(it.qty || 1))),
          price_data: { currency: "usd", unit_amount: Math.round(Number(it.unitCents || 0)), product },
        });
      }
      const session = await stripeCall("POST", "/v1/checkout/sessions", {
        mode: "payment",
        line_items,
        success_url: SELF + "/pay/return?ref=" + encodeURIComponent(ref) + "&st=ok",
        cancel_url: SELF + "/pay/return?ref=" + encodeURIComponent(ref) + "&st=cancel",
        metadata: { ref },
        payment_intent_data: { metadata: { ref } },
        customer_email: b.customerEmail ? String(b.customerEmail).slice(0, 120) : undefined,
      });
      store.returns[ref] = {
        sessionId: session.id,
        customerReturn: String(b.customerReturn || "").slice(0, 400),
        createdAt: new Date().toISOString(),
      };
      saveStore(store);
      return res.json({ url: session.url, sessionId: session.id });
    } catch (e) {
      console.error("bridge checkout", e.message);
      return res.status(502).json({ error: "stripe_error" });
    }
  });

  // Pay-to-submit card drafts: create a PaymentIntent for a storefront draft.
  // No order exists storefront-side until the intent succeeds. Contract:
  // HKL repo docs/STRIPE-EMBEDDED-BRIDGE.md §1.
  app.post("/api/bridge/payment-intent", async (req, res) => {
    if (!secretOk(req)) return res.status(401).json({ error: "bad_secret" });
    if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: "stripe_key_missing" });
    const b = req.body || {};
    const ref = String(b.ref || "").slice(0, 80);
    const amountCents = Math.round(Number(b.amountCents || 0));
    if (!ref || !(amountCents > 0)) return res.status(400).json({ error: "bad_request" });
    const currency = String(b.currency || "usd").toLowerCase().replace(/[^a-z]/g, "").slice(0, 3) || "usd";
    const idemKey = String(req.headers["idempotency-key"] || b.idempotencyKey || "hkl-" + ref).slice(0, 255);
    const metadata = { ref, kind: "hkl_card_draft" };
    if (b.metadata && typeof b.metadata === "object") {
      for (const [k, v] of Object.entries(b.metadata)) {
        if (v === undefined || v === null) continue;
        metadata[String(k).slice(0, 40)] = String(v).slice(0, 500);
      }
    }
    metadata.items = compactItems(b.items);
    try {
      const pi = await stripeCall(
        "POST",
        "/v1/payment_intents",
        {
          amount: amountCents,
          currency,
          automatic_payment_methods: { enabled: true },
          receipt_email: b.customerEmail ? String(b.customerEmail).slice(0, 120) : undefined,
          description: "HKL " + ref,
          metadata,
        },
        { "Idempotency-Key": idemKey }
      );
      return res.json({ paymentIntentId: pi.id, clientSecret: pi.client_secret, status: pi.status });
    } catch (e) {
      console.error("bridge payment-intent", e.message);
      return res.status(502).json({ error: "stripe_error" });
    }
  });

  // Authoritative PaymentIntent read for the storefront (contract §2). The
  // storefront trusts only this read, never the browser.
  app.get("/api/bridge/payment-intent/:id", async (req, res) => {
    if (!secretOk(req)) return res.status(401).json({ error: "bad_secret" });
    if (!process.env.STRIPE_SECRET_KEY) return res.status(503).json({ error: "stripe_key_missing" });
    const id = String(req.params.id || "");
    if (!/^pi_[A-Za-z0-9_]+$/.test(id)) return res.status(400).json({ error: "bad_request" });
    try {
      const pi = await stripeCall("GET", "/v1/payment_intents/" + encodeURIComponent(id));
      return res.json({
        id: pi.id,
        status: pi.status,
        amount: pi.amount,
        amountReceived: pi.amount_received || 0,
        currency: pi.currency,
        metadata: { ref: (pi.metadata && pi.metadata.ref) || null },
        lastError: pi.last_payment_error ? pi.last_payment_error.message : null,
      });
    } catch (e) {
      console.error("bridge payment-intent read", e.message);
      return res.status(502).json({ error: "stripe_error" });
    }
  });

  // Stripe sends the customer back here; bounce them to the storefront receipt.
  app.get("/pay/return", (req, res) => {
    const ref = String(req.query.ref || "").slice(0, 80);
    const store = loadStore();
    const rec = store.returns[ref];
    if (rec && rec.customerReturn) {
      const sep = rec.customerReturn.includes("?") ? "&" : "?";
      return res.redirect(302, rec.customerReturn + sep + "pay=" + (req.query.st === "ok" ? "ok" : "cancel"));
    }
    return res
      .status(200)
      .send("<html><body style='font-family:Arial;text-align:center;padding:60px'><h2>Apex King Digital</h2><p>Payment step complete. You can close this tab and return to the store.</p></body></html>");
  });

  // Stripe webhook: signature-verified; settles via the storefront callback.
  app.post("/api/bridge/webhook", (req, res) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) return res.status(503).json({ error: "webhook_secret_missing" });
    if (!verifyWebhook(req.rawBody, req.headers["stripe-signature"], secret)) {
      return res.status(400).json({ error: "bad_signature" });
    }
    let event;
    try {
      event = JSON.parse(req.rawBody.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "bad_json" });
    }
    res.json({ received: true });
    const s = event.data && event.data.object;
    if (!s) return;
    const settled =
      (event.type === "checkout.session.completed" && s.payment_status === "paid") ||
      event.type === "checkout.session.async_payment_succeeded";
    if (settled && s.metadata && s.metadata.ref) {
      notifySettled({ ref: s.metadata.ref, sessionId: s.id, amountTotal: s.amount_total, currency: s.currency });
    }
    // Pay-to-submit drafts: forward PaymentIntent outcomes to the storefront's
    // signed stripe-intent callback (contract §3). NOTE: this only fires for
    // events the Stripe webhook endpoint is registered for — the endpoint
    // must subscribe to payment_intent.succeeded / payment_intent.payment_failed.
    const piEvent = event.type === "payment_intent.succeeded" || event.type === "payment_intent.payment_failed";
    if (piEvent && s.metadata && s.metadata.kind === "hkl_card_draft") {
      notifyIntent({
        event: event.type,
        ref: s.metadata.ref || null,
        paymentIntentId: s.id,
        amountReceived: s.amount_received || 0,
        currency: s.currency,
        status: s.status,
        lastError: s.last_payment_error ? s.last_payment_error.message : null,
      });
    }
  });
}

module.exports = { mountStripeBridge };
