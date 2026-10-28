// Apex dashboard — Audits money flows (Phase 2).
//
// Pricing (Ryan 2026-10-27, see db/billing.js): audit $25 (the uncover),
// fix guide $25, bundle $40 upfront, done-for-you fixes $100/hr $200 min.
// Guide = unlocked section on the customer's report page + written doc
// by email. Guides wait for Ryan's review (draft -> ready) before going
// out, and NOTHING deliverable goes out unpaid:
//
//   PAY FIRST, THEN SEND (Ryan 2026-10-27): the invoice/payment comes
//   first, Ryan confirms payment (recorded purchase), THEN the report or
//   guide is sent. Send actions are gated on a recorded purchase; test
//   sends go to Ryan only.
//
// Payment-link purchases are recorded manually in the dashboard (Stripe
// notifies Ryan; there is no webhook) — the act of recording one IS the
// payment confirmation. Fix invoices are real Stripe invoices created
// through the same machinery as the renewal invoices (invoices.js).
//
// This module also carries the re-audit paths (Ryan 2026-10-27): findings
// can be marked fixed (note + date kept as history), scores recompute
// from OPEN issues only, new findings/sites can be added, and the masked
// public export is generated from PG (not audits.json) so the public tool
// stays current as sites improve.
"use strict";
const crypto = require("crypto");
const { getPool, pgEnabled } = require("./pg");
const { PRICES, LINKS, unlockAfterPurchase, fixAmountCents } = require("./billing");
const { scoreFor } = require("./audits");
const { buildGuideDraft, STORE_TYPE_DISPLAY, STORE_TYPES } = require("./guide-template");
const {
  stripeCall, findOrCreateCustomer, sendMail, fetchBuffer,
} = require("../invoices");
const { getAudit } = require("./audits");

const COPY_EMAIL = process.env.INVOICE_COPY_EMAIL || "sizemore.ryan@gmail.com";
const FROM = "Apex King Digital <hello@apexkingdigital.com>";
const PUBLIC_TOOL_URL = "https://apex-tracking-audit.netlify.app";

function noPg(res) {
  res.status(503).json({ error: "audits unavailable (Postgres not configured)" });
  return true;
}
function cleanEmail(s) { return String(s || "").trim().slice(0, 120); }
function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "")); }

async function getAuditRow(pool, id) {
  const { rows } = await pool.query(
    `SELECT id, domain, masked_domain, audit_date, audit_scope, verdict,
            is_thin, score, label, unlock_status, guide_status, fix_status, notes, store_type
     FROM audits WHERE id = $1`,
    [id]);
  return rows[0] || null;
}

// Order form (Ryan 2026-10-27): "example.com", "https://shop.example.com/"
// and "www.example.com/path" all mean the same domain.
function normalizeDomain(website) {
  let w = String(website || "").trim().toLowerCase();
  w = w.replace(/^https?:\/\//, "").replace(/^www\./, "");
  w = w.split(/[/?#]/)[0].trim();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(w)) return null;
  return w;
}

// Score rubric, one place (same as build_data.py / audits.scoreFor):
// 100 − 12 per OPEN critical − 5 per OPEN warning, floor 0; thin → NULL.
async function recomputeScore(pool, auditId) {
  const { rows: a } = await pool.query(
    "SELECT verdict, is_thin FROM audits WHERE id = $1", [auditId]);
  if (!a.length) return null;
  const { rows: c } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE kind = 'issue' AND severity = 'critical' AND status = 'open')::int AS critical,
            COUNT(*) FILTER (WHERE kind = 'issue' AND severity = 'warning' AND status = 'open')::int AS warning
     FROM audit_findings WHERE audit_id = $1`,
    [auditId]);
  const issues = [];
  for (let i = 0; i < (c[0].critical || 0); i++) issues.push({ severity: "critical" });
  for (let i = 0; i < (c[0].warning || 0); i++) issues.push({ severity: "warning" });
  const { thin, score, label } = scoreFor(issues, a[0].verdict);
  await pool.query(
    "UPDATE audits SET score = $1, label = $2, updated_at = now() WHERE id = $3",
    [score, label, auditId]);
  return { thin, score, label, critical: c[0].critical, warning: c[0].warning };
}

async function hasPurchase(pool, auditId, kinds, onlyReal) {
  const { rows } = await pool.query(
    `SELECT id, kind, buyer_email FROM audit_purchases
     WHERE audit_id = $1 AND kind = ANY($2) ${onlyReal ? "AND is_test = FALSE" : ""}
     ORDER BY created_at DESC LIMIT 1`,
    [auditId, kinds]);
  return rows[0] || null;
}

function reportEmailBody(a) {
  const L = [];
  L.push("Tracking Health Score — " + a.domain);
  L.push("");
  L.push("Score: " + (a.score === null ? "— (limited audit)" : a.score + "/100 (" + a.label + ")"));
  L.push("Audited: " + (a.date || "—") + " · " + (a.scope || ""));
  L.push("");
  if ((a.issues || []).length) {
    L.push("Findings — verbatim from the audit:");
    for (const i of a.issues) L.push("[" + i.severity.toUpperCase() + "] " + i.text);
    L.push("");
  } else {
    L.push("No findings recorded.");
    L.push("");
  }
  if ((a.trackers || []).length) {
    L.push("Trackers found:");
    for (const t of a.trackers) L.push(" - " + t.name + ": " + t.status);
    L.push("");
  }
  L.push("How scores work: 100 − 12 per critical issue − 5 per warning (info = 0). 85+ Healthy, 70–84 Fair, below 70 Needs Attention. Scores are computed from the findings; the audit itself assigned no numeric score.");
  L.push("");
  // Guide upsell — point 1 of 2 (the other is the guide delivery email).
  // The $25 guide is also sold as a $40 bundle upfront; the link is the
  // payment link when Stripe has it, otherwise reply-for-link/invoice.
  if (LINKS.guide) {
    L.push("Want the fix guide — exactly how to fix each finding above? It's $25: " + LINKS.guide);
  } else {
    L.push("Want the fix guide — exactly how to fix each finding above? It's $25 — reply to this email and we'll send the payment link or an invoice.");
  }
  // Hire-us-to-fix — offered right after the audit (point 1 of 2).
  L.push("Want us to fix it for you? $100/hour, $200 minimum, estimate first — reply and we will scope it.");
  L.push("");
  L.push("— Ryan Sizemore, Apex King Digital · hello@apexkingdigital.com · apexkingdigital.com");
  return L.join("\n");
}

function publicGuideLink(auditId, token) {
  return PUBLIC_TOOL_URL + "/?audit=" + encodeURIComponent(auditId) +
    "&guide=" + encodeURIComponent(token);
}

async function billingState(pool, auditId) {
  const row = await getAuditRow(pool, auditId);
  if (!row) return null;
  const purchases = (await pool.query(
    "SELECT id, kind, amount_cents, stripe_ref, buyer_email, is_test, note, created_at FROM audit_purchases WHERE audit_id = $1 ORDER BY created_at DESC",
    [auditId])).rows;
  const guides = (await pool.query(
    "SELECT status, platform, delivered_to, delivered_at, LENGTH(body) AS body_len FROM audit_guides WHERE audit_id = $1",
    [auditId])).rows;
  const quotes = (await pool.query(
    `SELECT id, hours, rate_cents, amount_cents, platform, access_needed, buyer_email,
            stripe_invoice_id, stripe_number, status, created_at
     FROM audit_fix_quotes WHERE audit_id = $1 ORDER BY created_at DESC`,
    [auditId])).rows;
  const deliveries = (await pool.query(
    "SELECT kind, delivered_to, delivered_at, is_test FROM audit_deliveries WHERE audit_id = $1 ORDER BY delivered_at DESC",
    [auditId])).rows;
  return {
    audit: {
      id: row.id, domain: row.domain, maskedDomain: row.masked_domain,
      unlockStatus: row.unlock_status, guideStatus: row.guide_status,
      fixStatus: row.fix_status, notes: row.notes, storeType: row.store_type,
    },
    purchases, guide: guides[0] || null, quotes, deliveries,
    links: { audit: LINKS.audit, guide: LINKS.guide, bundle: LINKS.bundle },
    prices: {
      audit: PRICES.audit.amountCents, guide: PRICES.guide.amountCents,
      bundle: PRICES.bundle.amountCents,
    },
  };
}

// ---------- fix invoices (Stripe, same machinery as renewals) ----------
async function createFixInvoice(quote, buyerEmail, domain, isTest) {
  const customer = await findOrCreateCustomer(buyerEmail, isTest ? "TEST — " + domain : domain);
  const desc = "Tracking fix — " + domain + " — " + quote.hours + "h @ $100/hr (minimum $200). Estimate; work starts after payment.";
  const inv = await stripeCall("POST", "/v1/invoices", {
    customer: customer.id,
    collection_method: "send_invoice",
    days_until_due: 14,
    auto_advance: false,
    pending_invoice_items_behavior: "exclude",
    description: desc,
    metadata: {
      apex_audit_id: quote.audit_id, kind: "fix",
      test: isTest ? "1" : "", quote_id: quote.id,
    },
  });
  await stripeCall("POST", "/v1/invoiceitems", {
    customer: customer.id, invoice: inv.id,
    amount: quote.amount_cents, currency: "usd",
    description: "Tracking fix — " + domain + " — " + quote.hours + "h @ $100/hr",
  });
  const check = await stripeCall("GET", "/v1/invoices/" + inv.id);
  if (!check.total) throw new Error("line item did not attach (invoice total is 0)");
  return inv;
}

async function sendFixInvoice(quote, buyerEmail, domain) {
  const invId = quote.stripe_invoice_id;
  await stripeCall("POST", "/v1/invoices/" + invId + "/finalize");
  const sent = await stripeCall("POST", "/v1/invoices/" + invId + "/send");
  // Copy to Ryan with the PDF attached (same pattern as renewal invoices).
  const atts = [];
  if (sent.invoice_pdf) {
    try { atts.push({ filename: "Invoice-" + (sent.number || invId) + ".pdf", content: await fetchBuffer(sent.invoice_pdf) }); }
    catch (e) { /* link still in body */ }
  }
  await sendMail({
    to: COPY_EMAIL,
    subject: "Copy — Fix invoice " + (sent.number || "") + " sent to " + buyerEmail + " (" + domain + ") — $" + (quote.amount_cents / 100).toFixed(2),
    text:
      "Apex King Digital fix invoice sent.\n\n" +
      "Site: " + domain + " (audit " + quote.audit_id + ")\n" +
      "Sent to: " + buyerEmail + "\n" +
      "Invoice: " + (sent.number || invId) + "\n" +
      "Amount: $" + (quote.amount_cents / 100).toFixed(2) + " (" + quote.hours + "h @ $100/hr, $200 minimum)\n" +
      "Platform: " + (quote.platform || "—") + "\n" +
      "Access needed: " + (quote.access_needed || "—") + "\n" +
      "View / pay: " + (sent.hosted_invoice_url || "(link pending)") + "\n\n" +
      "Work starts only after this invoice is paid.\n",
    attachments: atts,
  });
  return sent;
}

async function refreshFixQuote(pool, quote) {
  if (!quote.stripe_invoice_id || quote.status === "paid" || quote.status === "void") return quote;
  try {
    const inv = await stripeCall("GET", "/v1/invoices/" + quote.stripe_invoice_id);
    const st = inv.status === "paid" ? "paid" : inv.status === "void" ? "void" : inv.status === "open" ? "sent" : quote.status;
    if (st !== quote.status) {
      await pool.query(
        "UPDATE audit_fix_quotes SET status = $1, stripe_number = $2, updated_at = now() WHERE id = $3",
        [st, inv.number || quote.stripe_number, quote.id]);
      quote.status = st;
      quote.stripe_number = inv.number || quote.stripe_number;
      if (st === "paid") {
        await pool.query("UPDATE audits SET fix_status = 'paid', updated_at = now() WHERE id = $1", [quote.audit_id]);
      }
    }
  } catch (e) { /* keep stored state */ }
  return quote;
}

function mountAuditBilling(app, authRequired) {
  const needPg = (req, res) => !pgEnabled() && noPg(res);

  // ---------- billing state: one card = one site's complete backend ----------
  app.get("/api/audits/:id/billing", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const state = await billingState(getPool(), req.params.id);
      if (!state) return res.status(404).json({ error: "not found" });
      // Refresh open fix quotes from Stripe so paid flips show up.
      for (const q of state.quotes) await refreshFixQuote(getPool(), q);
      res.json(state);
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // ---------- purchases: recording a payment IS the payment confirmation ----------
  app.post("/api/audits/:id/purchases", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const pool = getPool();
      const b = req.body || {};
      const kind = String(b.kind || "");
      if (!["audit", "guide", "bundle"].includes(kind)) {
        return res.status(400).json({ error: "kind must be audit, guide or bundle" });
      }
      const amount = b.amount_cents != null ? Number(b.amount_cents) : PRICES[kind].amountCents;
      if (amount !== PRICES[kind].amountCents) {
        return res.status(400).json({ error: PRICES[kind].label + " is $" + (PRICES[kind].amountCents / 100) + " — decided price, no overrides" });
      }
      const row = await getAuditRow(pool, req.params.id);
      if (!row) return res.status(404).json({ error: "not found" });
      const next = unlockAfterPurchase(row.unlock_status, kind);
      if (!next) {
        return res.status(400).json({ error: "cannot record a " + kind + " purchase while unlock status is " + row.unlock_status });
      }
      const buyerEmail = cleanEmail(b.buyer_email);
      if (buyerEmail && !isEmail(buyerEmail)) return res.status(400).json({ error: "buyer email is not an email address" });
      const { rows } = await pool.query(
        `INSERT INTO audit_purchases (audit_id, kind, amount_cents, stripe_ref, buyer_email, is_test, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, kind, amount_cents, stripe_ref, buyer_email, is_test, created_at`,
        [req.params.id, kind, amount, String(b.stripe_ref || "").slice(0, 120) || null,
         buyerEmail || null, !!b.is_test, String(b.note || "").slice(0, 300) || null]);
      await pool.query("UPDATE audits SET unlock_status = $1, updated_at = now() WHERE id = $2", [next, req.params.id]);
      res.json({ ok: true, purchase: rows[0], unlockStatus: next });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // ---------- notes ----------
  app.post("/api/audits/:id/notes", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const pool = getPool();
      const notes = String((req.body || {}).notes || "").slice(0, 2000);
      const { rowCount } = await pool.query(
        "UPDATE audits SET notes = $1, updated_at = now() WHERE id = $2", [notes, req.params.id]);
      if (!rowCount) return res.status(404).json({ error: "not found" });
      res.json({ ok: true, notes });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // ---------- report send (PAY FIRST — gated on a recorded audit/bundle purchase) ----------
  app.post("/api/audits/:id/report/send", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const pool = getPool();
      const b = req.body || {};
      const test = !!b.test;
      const audit = await getAudit(pool, req.params.id);
      if (!audit) return res.status(404).json({ error: "not found" });
      let to = cleanEmail(b.to);
      if (test) {
        to = COPY_EMAIL;
      } else {
        const paid = await hasPurchase(pool, req.params.id, ["audit", "bundle"], true);
        if (!paid) {
          return res.status(402).json({ error: "not paid — record the $25 audit (or $40 bundle) purchase first, then send the report" });
        }
        to = to || cleanEmail(paid.buyer_email);
        if (!isEmail(to)) return res.status(400).json({ error: "no buyer email — record the purchase with the buyer's email, or pass 'to'" });
      }
      const sent = await sendMail({
        to,
        subject: "Your Tracking Health Score report — " + audit.maskedDomain,
        text: reportEmailBody(audit),
      });
      if (!sent) return res.status(502).json({ error: "email failed (SMTP not configured)" });
      await pool.query(
        "INSERT INTO audit_deliveries (audit_id, kind, delivered_to, is_test) VALUES ($1,'report',$2,$3)",
        [req.params.id, to, test]);
      res.json({ ok: true, deliveredTo: to, test });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // ---------- guide: draft / save / ready / send ----------
  app.post("/api/audits/:id/guide/draft", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const pool = getPool();
      const audit = await getAudit(pool, req.params.id);
      if (!audit) return res.status(404).json({ error: "not found" });
      const draft = buildGuideDraft(audit);
      await pool.query(
        `INSERT INTO audit_guides (audit_id, body, platform, status) VALUES ($1,$2,$3,'draft')
         ON CONFLICT (audit_id) DO UPDATE SET body = EXCLUDED.body, platform = EXCLUDED.platform,
           status = 'draft', updated_at = now()`,
        [req.params.id, draft.body, draft.platform]);
      await pool.query("UPDATE audits SET guide_status = 'draft', updated_at = now() WHERE id = $1", [req.params.id]);
      res.json({ ok: true, platform: draft.platform, body: draft.body });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  app.get("/api/audits/:id/guide", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const { rows } = await getPool().query(
        "SELECT body, platform, status, delivered_to, delivered_at FROM audit_guides WHERE audit_id = $1",
        [req.params.id]);
      if (!rows.length) return res.json({ exists: false });
      res.json({ exists: true, ...rows[0] });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  app.put("/api/audits/:id/guide", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const pool = getPool();
      const b = req.body || {};
      const body = String(b.body || "");
      if (!body.trim()) return res.status(400).json({ error: "guide body cannot be empty" });
      if (body.length > 100000) return res.status(400).json({ error: "guide too long" });
      const { rowCount } = await pool.query(
        `UPDATE audit_guides SET body = $1, platform = $2, updated_at = now()
         WHERE audit_id = $3`,
        [body, String(b.platform || "").slice(0, 80) || null, req.params.id]);
      if (!rowCount) return res.status(404).json({ error: "no guide draft — generate one first" });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  app.post("/api/audits/:id/guide/ready", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const pool = getPool();
      const { rows } = await pool.query(
        "SELECT body FROM audit_guides WHERE audit_id = $1", [req.params.id]);
      if (!rows.length || !String(rows[0].body || "").trim()) {
        return res.status(400).json({ error: "no guide draft — generate one first" });
      }
      await pool.query("UPDATE audit_guides SET status = 'ready', updated_at = now() WHERE audit_id = $1", [req.params.id]);
      await pool.query("UPDATE audits SET guide_status = 'ready', updated_at = now() WHERE id = $1", [req.params.id]);
      res.json({ ok: true, status: "ready" });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  app.post("/api/audits/:id/guide/send", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const pool = getPool();
      const b = req.body || {};
      const test = !!b.test;
      const row = await getAuditRow(pool, req.params.id);
      if (!row) return res.status(404).json({ error: "not found" });
      const { rows: g } = await pool.query(
        "SELECT body, platform, status, unlock_token FROM audit_guides WHERE audit_id = $1", [req.params.id]);
      if (!g.length || !String(g[0].body || "").trim()) {
        return res.status(400).json({ error: "no guide draft — generate one first" });
      }
      if (g[0].status !== "ready" && g[0].status !== "delivered") {
        return res.status(400).json({ error: "guide is not ready — Ryan must review and mark it ready first" });
      }
      let to = cleanEmail(b.to);
      if (test) {
        to = COPY_EMAIL;
      } else {
        const paid = await hasPurchase(pool, req.params.id, ["guide", "bundle"], true);
        if (!paid) {
          return res.status(402).json({ error: "not paid — record the $25 guide (or $40 bundle) purchase first, then send the guide" });
        }
        to = to || cleanEmail(paid.buyer_email);
        if (!isEmail(to)) return res.status(400).json({ error: "no buyer email — record the purchase with the buyer's email, or pass 'to'" });
      }
      const token = g[0].unlock_token || crypto.randomBytes(24).toString("hex");
      const link = publicGuideLink(req.params.id, token);
      const body = g[0].body;
      const sent = await sendMail({
        to,
        subject: "Your Tracking Fix Guide — " + row.masked_domain,
        text:
          "Hi,\n\n" +
          "Your Tracking Fix Guide for " + row.masked_domain + " is below, and attached as a file to keep.\n" +
          "You can also read it on its report page (unlocked for you): " + link + "\n\n" +
          "---\n\n" + body + "\n\n" +
          "---\n\n" +
          // Hire-us-to-fix — offered again after the guide (point 2 of 2).
          "Want us to do the fixes for you? $100/hour, $200 minimum, estimate first — reply to this email and we will scope it.\n\n" +
          "— Ryan Sizemore, Apex King Digital · hello@apexkingdigital.com · apexkingdigital.com\n",
        attachments: [{ filename: "Tracking-Fix-Guide-" + req.params.id + ".md", content: body }],
      });
      if (!sent) return res.status(502).json({ error: "email failed (SMTP not configured)" });
      await sendMail({
        to: COPY_EMAIL,
        subject: "Copy — Fix guide sent to " + to + " (" + row.masked_domain + ")",
        text: "Fix guide delivered to " + to + " for audit " + req.params.id + " (" + row.masked_domain + ").\nUnlock link: " + link + "\n\n---\n\n" + body,
      });
      await pool.query(
        `UPDATE audit_guides SET status = 'delivered', unlock_token = $1, delivered_to = $2, delivered_at = now(), updated_at = now()
         WHERE audit_id = $3`,
        [token, to, req.params.id]);
      await pool.query("UPDATE audits SET guide_status = 'delivered', updated_at = now() WHERE id = $1", [req.params.id]);
      await pool.query(
        "INSERT INTO audit_deliveries (audit_id, kind, delivered_to, is_test) VALUES ($1,'guide',$2,$3)",
        [req.params.id, to, test]);
      res.json({ ok: true, deliveredTo: to, test, unlockLink: link });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // ---------- fix quotes: invoice-to-start ($100/hr, $200 minimum) ----------
  app.post("/api/audits/:id/fix-quotes", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const pool = getPool();
      const b = req.body || {};
      const test = !!b.test;
      const row = await getAuditRow(pool, req.params.id);
      if (!row) return res.status(404).json({ error: "not found" });
      let amount;
      try { amount = fixAmountCents(b.hours); }
      catch (e) { return res.status(400).json({ error: e.message }); }
      const buyerEmail = test ? COPY_EMAIL : cleanEmail(b.buyer_email);
      if (!isEmail(buyerEmail)) return res.status(400).json({ error: "buyer email required (or send as test to Ryan)" });
      const { rows } = await pool.query(
        `INSERT INTO audit_fix_quotes (audit_id, hours, rate_cents, amount_cents, platform, access_needed, buyer_email, status)
         VALUES ($1,$2,10000,$3,$4,$5,$6,'draft') RETURNING id`,
        [req.params.id, Number(b.hours), amount,
         String(b.platform || "").slice(0, 80) || null,
         String(b.access_needed || "").slice(0, 1000) || null, buyerEmail]);
      const quote = { id: rows[0].id, audit_id: req.params.id, hours: Number(b.hours), amount_cents: amount };
      const inv = await createFixInvoice(quote, buyerEmail, row.domain, test);
      await pool.query(
        "UPDATE audit_fix_quotes SET stripe_invoice_id = $1, updated_at = now() WHERE id = $2",
        [inv.id, quote.id]);
      await pool.query("UPDATE audits SET fix_status = 'quoted', updated_at = now() WHERE id = $1", [req.params.id]);
      res.json({ ok: true, quote: { ...quote, stripe_invoice_id: inv.id, status: "draft", buyer_email: buyerEmail } });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  app.post("/api/audits/:id/fix-quotes/:quoteId/send", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const pool = getPool();
      const { rows } = await pool.query(
        "SELECT * FROM audit_fix_quotes WHERE id = $1 AND audit_id = $2", [req.params.quoteId, req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "quote not found" });
      const q = rows[0];
      if (q.status !== "draft") return res.status(400).json({ error: "only drafts can be sent (status: " + q.status + ")" });
      const row = await getAuditRow(pool, req.params.id);
      const sent = await sendFixInvoice(q, q.buyer_email, row ? row.domain : req.params.id);
      await pool.query(
        "UPDATE audit_fix_quotes SET status = 'sent', stripe_number = $1, updated_at = now() WHERE id = $2",
        [sent.number || null, q.id]);
      await pool.query("UPDATE audits SET fix_status = 'invoiced', updated_at = now() WHERE id = $1", [req.params.id]);
      res.json({ ok: true, status: "sent", number: sent.number || null });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  app.post("/api/audits/:id/fix-quotes/:quoteId/void", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const pool = getPool();
      const { rows } = await pool.query(
        "SELECT * FROM audit_fix_quotes WHERE id = $1 AND audit_id = $2", [req.params.quoteId, req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "quote not found" });
      const q = rows[0];
      if (q.status === "paid") return res.status(400).json({ error: "cannot void a paid invoice" });
      if (q.status === "void") return res.json({ ok: true, status: "void" });
      if (q.stripe_invoice_id) {
        if (q.status === "draft") await stripeCall("DELETE", "/v1/invoices/" + q.stripe_invoice_id);
        else await stripeCall("POST", "/v1/invoices/" + q.stripe_invoice_id + "/void");
      }
      await pool.query("UPDATE audit_fix_quotes SET status = 'void', updated_at = now() WHERE id = $1", [q.id]);
      // Recompute the audit's fix_status from its remaining live quotes:
      // paid > sent > draft > none. Voiding one quote must not hide
      // another quote that is still sent or paid.
      const { rows: live } = await pool.query(
        "SELECT status FROM audit_fix_quotes WHERE audit_id = $1 AND status != 'void'", [req.params.id]);
      const st = live.some(x => x.status === "paid") ? "paid"
        : live.some(x => x.status === "sent") ? "invoiced"
        : live.some(x => x.status === "draft") ? "quoted" : "none";
      await pool.query("UPDATE audits SET fix_status = $1, updated_at = now() WHERE id = $2", [st, req.params.id]);
      res.json({ ok: true, status: "void" });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // ---------- re-audit: findings + history + add-a-site ----------
  app.post("/api/audits", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const pool = getPool();
      const b = req.body || {};
      const domain = String(b.domain || "").trim().toLowerCase();
      if (!domain || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
        return res.status(400).json({ error: "a valid domain is required" });
      }
      const exists = await pool.query("SELECT id FROM audits WHERE domain = $1", [domain]);
      if (exists.rows.length) return res.status(400).json({ error: "that domain is already listed as " + exists.rows[0].id });
      const { rows: mx } = await pool.query(
        "SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 2) AS INTEGER)), 0) AS m FROM audits WHERE id ~ '^a[0-9]+$'");
      const id = "a" + String((mx[0].m || 0) + 1).padStart(3, "0");
      const { maskDomain } = require("./audits");
      const storeType = String(b.store_type || "").toLowerCase();
      if (storeType && !STORE_TYPES.includes(storeType)) {
        return res.status(400).json({ error: "store_type must be one of: " + STORE_TYPES.join(", ") });
      }
      const issues = Array.isArray(b.issues) ? b.issues : [];
      const trackers = Array.isArray(b.trackers) ? b.trackers : [];
      // No findings yet = pending shell, not a 100/100: score NULL until
      // Ryan adds findings from the card (recomputeScore fills it in).
      const scored = scoreFor(issues, b.verdict || null);
      const { thin, score, label } = issues.length ? scored : { thin: false, score: null, label: "Pending" };
      await pool.query(
        `INSERT INTO audits (id, domain, masked_domain, audit_date, audit_scope, verdict, is_thin, score, label, store_type)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, domain, maskDomain(domain), b.audit_date || null, String(b.audit_scope || "").slice(0, 300) || null,
         String(b.verdict || "").slice(0, 500) || null, thin, score, label, storeType || null]);
      let order = 0;
      for (const iss of issues) {
        if (!iss.text || !["critical", "warning", "info"].includes(iss.severity)) continue;
        await pool.query(
          "INSERT INTO audit_findings (audit_id, kind, severity, name, text, sort_order) VALUES ($1,'issue',$2,NULL,$3,$4)",
          [id, iss.severity, String(iss.text).slice(0, 2000), order++]);
      }
      for (const t of trackers) {
        if (!t.name) continue;
        await pool.query(
          "INSERT INTO audit_findings (audit_id, kind, severity, name, text, sort_order) VALUES ($1,'tracker',NULL,$2,$3,$4)",
          [id, String(t.name).slice(0, 120), String(t.status || "").slice(0, 500), order++]);
      }
      res.json({ ok: true, id, domain, maskedDomain: maskDomain(domain), score, label, thin });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  app.post("/api/audits/:id/findings", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const pool = getPool();
      const b = req.body || {};
      const row = await getAuditRow(pool, req.params.id);
      if (!row) return res.status(404).json({ error: "not found" });
      if (b.kind === "tracker") {
        if (!String(b.name || "").trim()) return res.status(400).json({ error: "tracker name required" });
        const { rows } = await pool.query(
          `INSERT INTO audit_findings (audit_id, kind, severity, name, text, sort_order)
           VALUES ($1,'tracker',NULL,$2,$3,(SELECT COALESCE(MAX(sort_order), -1) + 1 FROM audit_findings WHERE audit_id = $1))
           RETURNING id`,
          [req.params.id, String(b.name).slice(0, 120), String(b.status || "").slice(0, 500)]);
        res.json({ ok: true, findingId: rows[0].id });
      } else {
        if (!["critical", "warning", "info"].includes(b.severity)) {
          return res.status(400).json({ error: "severity must be critical, warning or info" });
        }
        if (!String(b.text || "").trim()) return res.status(400).json({ error: "finding text required" });
        const { rows } = await pool.query(
          `INSERT INTO audit_findings (audit_id, kind, severity, name, text, sort_order)
           VALUES ($1,'issue',$2,NULL,$3,(SELECT COALESCE(MAX(sort_order), -1) + 1 FROM audit_findings WHERE audit_id = $1))
           RETURNING id`,
          [req.params.id, b.severity, String(b.text).slice(0, 2000)]);
        await pool.query(
          "INSERT INTO audit_finding_events (audit_id, finding_id, action, note) VALUES ($1,$2,'added',$3)",
          [req.params.id, rows[0].id, String(b.note || "").slice(0, 500) || null]);
        const score = await recomputeScore(pool, req.params.id);
        res.json({ ok: true, findingId: rows[0].id, score });
      }
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  app.post("/api/audits/:id/findings/:findingId/fix", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const pool = getPool();
      const note = String((req.body || {}).note || "").slice(0, 500);
      const { rowCount } = await pool.query(
        `UPDATE audit_findings SET status = 'fixed', fixed_note = $1, fixed_at = now()
         WHERE id = $2 AND audit_id = $3 AND kind = 'issue'`,
        [note || null, req.params.findingId, req.params.id]);
      if (!rowCount) return res.status(404).json({ error: "finding not found (issues only)" });
      await pool.query(
        "INSERT INTO audit_finding_events (audit_id, finding_id, action, note) VALUES ($1,$2,'fixed',$3)",
        [req.params.id, req.params.findingId, note || null]);
      const score = await recomputeScore(pool, req.params.id);
      res.json({ ok: true, score });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  app.post("/api/audits/:id/findings/:findingId/reopen", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const pool = getPool();
      const note = String((req.body || {}).note || "").slice(0, 500);
      const { rowCount } = await pool.query(
        `UPDATE audit_findings SET status = 'open', fixed_note = NULL, fixed_at = NULL
         WHERE id = $1 AND audit_id = $2 AND kind = 'issue'`,
        [req.params.findingId, req.params.id]);
      if (!rowCount) return res.status(404).json({ error: "finding not found (issues only)" });
      await pool.query(
        "INSERT INTO audit_finding_events (audit_id, finding_id, action, note) VALUES ($1,$2,'reopened',$3)",
        [req.params.id, req.params.findingId, note || null]);
      const score = await recomputeScore(pool, req.params.id);
      res.json({ ok: true, score });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  app.get("/api/audits/:id/history", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const { rows } = await getPool().query(
        `SELECT e.id, e.action, e.note, e.created_at, f.severity, f.text
         FROM audit_finding_events e LEFT JOIN audit_findings f ON f.id = e.finding_id
         WHERE e.audit_id = $1 ORDER BY e.created_at DESC LIMIT 100`,
        [req.params.id]);
      res.json({ events: rows });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // ---------- masked export from PG (re-audits + new sites reach the public tool) ----------
  // Returns the raw audits in audits.json shape so the Python transform +
  // mask pipeline (build_data.py / mask_data.py) can rebuild the public
  // file from live PG data instead of the frozen source file.
  app.get("/api/admin/audits/masked-export", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const pool = getPool();
      const { rows: audits } = await pool.query(
        `SELECT id, domain, audit_date, audit_scope, verdict FROM audits
         WHERE domain NOT LIKE '%example%' ORDER BY domain`);
      const out = [];
      for (const a of audits) {
        const { rows: fr } = await pool.query(
          "SELECT kind, severity, name, text, status FROM audit_findings WHERE audit_id = $1 ORDER BY sort_order",
          [a.id]);
        // Pending shells (created from an order, no findings yet) stay
        // off the public side until Ryan audits them — an empty audit
        // would otherwise score a false 100.
        if (!fr.length) continue;
        out.push({
          id: a.id, domain: a.domain,
          date: a.audit_date ? a.audit_date.toISOString().slice(0, 10) : null,
          audit_scope: a.audit_scope, verdict: a.verdict,
          // Public side shows the CURRENT state: fixed findings are gone
          // (the PG score already excludes them) and live only in the
          // dashboard history.
          issues: fr.filter(r => r.kind === "issue" && r.status === "open").map(r => ({ severity: r.severity, text: r.text })),
          trackers: fr.filter(r => r.kind === "tracker").map(r => ({ name: r.name, status: r.text })),
        });
      }
      res.json({ generated: new Date().toISOString().slice(0, 10), count: out.length, audits: out });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // ---------- public guide fetch (no login — bearer token, delivered guides only) ----------
  // The public report page fetches this with the unlock link from the
  // delivery email. A wrong token, or a guide that was never delivered,
  // gets the same 404 — nothing leaks about what exists.
  // CORS: the static public tool (Netlify) fetches this cross-origin.
  // Only this public, token-gated endpoint allows it — nothing else.
  const PUBLIC_ORIGIN = "https://apex-tracking-audit.netlify.app";
  app.options("/api/public/audits/:id/guide", (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", PUBLIC_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "GET");
    res.status(204).end();
  });
  app.get("/api/public/audits/:id/guide", async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", PUBLIC_ORIGIN);
    try {
      if (!pgEnabled()) return res.status(404).json({ error: "not found" });
      const token = String(req.query.token || "");
      if (!token) return res.status(404).json({ error: "not found" });
      const { rows } = await getPool().query(
        `SELECT g.body, g.delivered_at, a.masked_domain
         FROM audit_guides g JOIN audits a ON a.id = g.audit_id
         WHERE g.audit_id = $1 AND g.unlock_token = $2 AND g.status = 'delivered'`,
        [req.params.id, token]);
      if (!rows.length) return res.status(404).json({ error: "not found" });
      res.json({ id: req.params.id, domain: rows[0].masked_domain, guide: rows[0].body, deliveredAt: rows[0].delivered_at });
    } catch (e) { res.status(404).json({ error: "not found" }); }
  });

  // ---------- order flow (Ryan 2026-10-27) ----------
  // Public form on the tool: website URL + store type -> payment choice
  // (audit $25 / bundle $40) -> pay at Stripe -> audit delivered ->
  // guide upsell -> hire-us-to-fix at both points. The order is stored
  // here and Ryan is emailed; the payment itself happens at Stripe
  // (the link collects the website), and Ryan matches the Stripe
  // notification to the stored order, then records the purchase on the
  // audit. No webhook, no auto-charge, no client data leaves the
  // dashboard except the notification email to Ryan.
  app.options("/api/public/audits/orders", (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", PUBLIC_ORIGIN);
    res.setHeader("Access-Control-Allow-Methods", "POST");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.status(204).end();
  });
  app.post("/api/public/audits/orders", async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", PUBLIC_ORIGIN);
    try {
      if (!pgEnabled()) return res.status(503).json({ error: "orders unavailable (Postgres not configured)" });
      const pool = getPool();
      const b = req.body || {};
      const domain = normalizeDomain(b.website);
      if (!domain) return res.status(400).json({ error: "enter a valid website URL, e.g. example.com" });
      const storeType = String(b.store_type || "").toLowerCase();
      if (!STORE_TYPES.includes(storeType)) {
        return res.status(400).json({ error: "pick what kind of store it is" });
      }
      const choice = String(b.choice || "");
      if (!["audit", "bundle"].includes(choice)) {
        return res.status(400).json({ error: "pick audit ($25) or bundle ($40)" });
      }
      const paymentUrl = LINKS[choice];
      if (!paymentUrl) {
        return res.status(400).json({ error: choice === "bundle"
          ? "bundle checkout is still being set up — pick the $25 audit for now, or email hello@apexkingdigital.com and we'll bundle it for you"
          : "audit checkout is unavailable right now — email hello@apexkingdigital.com" });
      }
      const buyerEmail = cleanEmail(b.buyer_email);
      if (buyerEmail && !isEmail(buyerEmail)) return res.status(400).json({ error: "that email address doesn't look right" });
      const { rows } = await pool.query(
        `INSERT INTO audit_orders (website, domain, store_type, choice, buyer_email)
         VALUES ($1,$2,$3,$4,$5) RETURNING id, domain, store_type, choice, created_at`,
        [String(b.website).slice(0, 300), domain, storeType, choice, buyerEmail || null]);
      const o = rows[0];
      await sendMail({
        to: COPY_EMAIL,
        subject: "New tracking audit order — " + domain + " (" + choice + ", " + (STORE_TYPE_DISPLAY[storeType] || storeType) + ")",
        text:
          "A visitor ordered a tracking audit from the public tool.\n\n" +
          "Website: " + domain + " (typed: " + String(b.website).slice(0, 300) + ")\n" +
          "Store type: " + (STORE_TYPE_DISPLAY[storeType] || storeType) + "\n" +
          "Choice: " + choice + " — $" + (PRICES[choice].amountCents / 100) + "\n" +
          "Buyer email: " + (buyerEmail || "(not given — Stripe checkout collects it)") + "\n" +
          "Order: " + o.id + " · " + o.created_at + "\n\n" +
          "Next: when the Stripe payment notification arrives, match it to this order in the dashboard (Audits > Incoming orders), create the audit, and record the purchase on it. The report goes out only after payment is recorded.\n",
      });
      res.json({ ok: true, orderId: o.id, domain, paymentUrl });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  app.get("/api/audits/orders", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const { rows } = await getPool().query(
        `SELECT o.id, o.website, o.domain, o.store_type, o.choice, o.buyer_email,
                o.status, o.audit_id, o.created_at, a.masked_domain
         FROM audit_orders o LEFT JOIN audits a ON a.id = o.audit_id
         ORDER BY o.created_at DESC LIMIT 100`);
      res.json({ orders: rows });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  app.post("/api/audits/orders/:id/create-audit", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const pool = getPool();
      const { rows } = await pool.query("SELECT * FROM audit_orders WHERE id = $1", [req.params.id]);
      if (!rows.length) return res.status(404).json({ error: "order not found" });
      const o = rows[0];
      if (o.status === "cancelled") return res.status(400).json({ error: "order was cancelled" });
      if (o.audit_id) return res.json({ ok: true, auditId: o.audit_id, existing: true });
      const { rows: ex } = await pool.query("SELECT id FROM audits WHERE domain = $1", [o.domain]);
      if (ex.length) {
        // Already listed (e.g. a re-order for a sampled site): link it.
        await pool.query("UPDATE audit_orders SET audit_id = $1, status = 'audited' WHERE id = $2", [ex[0].id, o.id]);
        return res.json({ ok: true, auditId: ex[0].id, existing: true });
      }
      const { rows: mx } = await pool.query(
        "SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 2) AS INTEGER)), 0) AS m FROM audits WHERE id ~ '^a[0-9]+$'");
      const id = "a" + String((mx[0].m || 0) + 1).padStart(3, "0");
      const { maskDomain } = require("./audits");
      const today = new Date().toISOString().slice(0, 10);
      // Pending shell: no findings yet, so no score — it must NOT reach
      // the public masked export (which would score an empty audit 100).
      await pool.query(
        `INSERT INTO audits (id, domain, masked_domain, audit_date, audit_scope, verdict, is_thin, score, label, store_type)
         VALUES ($1,$2,$3,$4,'tracking, consent',NULL,FALSE,NULL,'Pending',$5)`,
        [id, o.domain, maskDomain(o.domain), today, o.store_type]);
      await pool.query("UPDATE audit_orders SET audit_id = $1, status = 'audited' WHERE id = $2", [id, o.id]);
      res.json({ ok: true, auditId: id, existing: false });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  app.post("/api/audits/orders/:id/cancel", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const { rowCount } = await getPool().query(
        "UPDATE audit_orders SET status = 'cancelled' WHERE id = $1 AND status = 'ordered'", [req.params.id]);
      if (!rowCount) return res.status(404).json({ error: "order not found or already handled" });
      res.json({ ok: true, status: "cancelled" });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // ---------- TEMPORARY test-audit endpoints (verification only — REMOVE before reporting done) ----------
  app.post("/api/admin/audits/test-audit", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const pool = getPool();
      const domain = "test-apex-" + crypto.randomBytes(4).toString("hex") + ".example";
      const { rows: mx } = await pool.query(
        "SELECT COALESCE(MAX(CAST(SUBSTRING(id FROM 2) AS INTEGER)), 0) AS m FROM audits WHERE id ~ '^a[0-9]+$'");
      const id = "a" + String((mx[0].m || 0) + 1).padStart(3, "0");
      const { maskDomain } = require("./audits");
      await pool.query(
        `INSERT INTO audits (id, domain, masked_domain, audit_date, audit_scope, verdict, is_thin, score, label)
         VALUES ($1,$2,$3,'2026-10-27','test audit','test',FALSE,88,'Healthy')`,
        [id, domain, maskDomain(domain)]);
      await pool.query(
        "INSERT INTO audit_findings (audit_id, kind, severity, name, text, sort_order) VALUES ($1,'issue','critical',NULL,$2,0), ($1,'issue','warning',NULL,$3,1)",
        [id, "No consent banner exists; Meta Pixel fires pre-consent.", "Privacy policy claims no third-party trackers, but the X pixel is present."]);
      await pool.query(
        "INSERT INTO audit_findings (audit_id, kind, severity, name, text, sort_order) VALUES ($1,'tracker',NULL,$2,$3,2)",
        [id, "Meta Pixel", "present, fires pre-consent"]);
      res.json({ ok: true, id, domain });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  app.delete("/api/admin/audits/test-audit/:id", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const pool = getPool();
      const { rowCount } = await pool.query(
        "DELETE FROM audits WHERE id = $1 AND domain LIKE 'test-apex-%.example'", [req.params.id]);
      if (!rowCount) return res.status(404).json({ error: "test audit not found" });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });
}

module.exports = { mountAuditBilling, recomputeScore, billingState };
