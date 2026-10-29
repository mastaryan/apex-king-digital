// Apex dashboard — Card home (2026-10-28, Ryan: "Let's build it").
//
// The landing view: 9 cards, title + status numbers only. Tap a card and
// that piece opens. Card set: Audits, Local SEO, Websites, Bots,
// Invoices, Email, Customers, Mock-ups, M.R. TV. Silverback Group footer.
//
// Rules this module lives by (Ryan's card-by-card review, Oct 28):
//  - AUDITS: no buy buttons in the backend (frontend only). Three queues
//    with REAL counts from live order/purchase data — never hardcoded.
//    The queue counts live ONLY inside the Audits detail, nowhere else.
//    Each queue splits by customer email, and every row shows the email +
//    the website URL + the matched Stripe reference. A purchase recorded
//    in the dashboard IS the invoice match (Ryan matches the Stripe
//    notification when he records it); an order with no purchase yet
//    shows "not matched yet" — never a faked reference.
//  - LOCAL SEO: to-do lane (front-end signups land here) -> tracking
//    lane (setup done, flags monitored).
//  - WEBSITES: existing sites; names are clickable links (frontend).
//  - BOTS: treated like websites — built, then added here; pending
//    while being built. No order form.
//  - INVOICES: left as-is (Ryan is coming back to it). The home endpoint
//    only READS invoice state for the card number.
//  - EMAIL: Resend stats via the /emails/metrics API when RESEND_API_KEY
//    is configured; honest "not connected" slots when it is not. HKL +
//    Apex share one Resend account, so the numbers are combined.
//  - CUSTOMERS: searchable list, add + pick product(s), Has /
//    Outstanding / Before per customer.
//  - MOCK-UPS: tracking list; click to reveal the full version.
//  - M.R. TV: coming-soon shape — start = invoice date, end = start +
//    1 year (yearly) / + 1 month (monthly), days left front and center.
//    NO credits, NO pause. Invoice route (TV provider vs Apex) is OPEN.
"use strict";
const https = require("https");
const { getPool, pgEnabled } = require("./pg");
const store = require("./store");
const { computeRows, loadApprovals, loadReminderState } = require("../upcoming");

const APEX_PRODUCTS = [
  "Small Business Website", "Church Website", "GBP Setup",
  "Annual Website Renewal", "Tracking Audit", "Fix Guide",
  "Audit + Guide Bundle", "Local SEO", "Telegram Bot", "Discord Bot",
  "M.R. TV",
];

function noPg(res) {
  res.status(503).json({ error: "unavailable (Postgres not configured)" });
  return true;
}
function cleanStr(s, n) { return String(s || "").trim().slice(0, n || 200); }
function isEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || "")); }

// Dates in Ryan's timezone (America/New_York) as YYYY-MM-DD.
function nyToday() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}
function nyMonthStart() {
  const t = nyToday();
  return t.slice(0, 8) + "01";
}
function addMonthsISO(iso, n) {
  const d = new Date(iso + "T12:00:00Z");
  const y = d.getUTCFullYear(), m = d.getUTCMonth() + n;
  const day = d.getUTCDate();
  const nd = new Date(Date.UTC(y, m, 1));
  const last = new Date(Date.UTC(nd.getUTCFullYear(), nd.getUTCMonth() + 1, 0)).getUTCDate();
  nd.setUTCDate(Math.min(day, last));
  return nd.toISOString().slice(0, 10);
}
function addYearsISO(iso, n) {
  const d = new Date(iso + "T12:00:00Z");
  const nd = new Date(Date.UTC(d.getUTCFullYear() + n, d.getUTCMonth(), d.getUTCDate()));
  return nd.toISOString().slice(0, 10);
}
function daysBetween(a, b) {
  return Math.round((new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / 86400000);
}

// ---------- audit queues (real counts, live data only) ----------
// Pending = work Ryan still has to do:
//   audit queue:  orders (choice audit, status ordered) awaiting a
//                 payment match + audit creation, PLUS audits with a
//                 recorded $25 audit purchase whose report hasn't gone
//                 out yet.
//   bundle queue: orders (choice bundle, status ordered), PLUS audits
//                 with a recorded $40 bundle purchase where the report
//                 or the guide still hasn't gone out.
//   guide queue:  audits with a recorded $25 guide-only purchase whose
//                 guide hasn't been delivered yet. (Bundle audits live
//                 in the bundle queue, not here — no double-counting.)
// A test order / test purchase never counts (is_test / the inert
// test-apex-order row is status 'audited' anyway).
async function buildQueues(pool) {
  const { rows: orders } = await pool.query(
    `SELECT id, website, domain, store_type, choice, buyer_email, status, created_at
     FROM audit_orders WHERE status = 'ordered' ORDER BY created_at ASC`);
  const { rows: paid } = await pool.query(
    `SELECT a.id, a.domain, a.masked_domain, a.store_type, a.unlock_status, a.guide_status,
            (SELECT buyer_email FROM audit_purchases p WHERE p.audit_id = a.id AND p.is_test = FALSE AND p.kind = 'audit' ORDER BY p.created_at DESC LIMIT 1) AS audit_buyer,
            (SELECT stripe_ref FROM audit_purchases p WHERE p.audit_id = a.id AND p.is_test = FALSE AND p.kind = 'audit' ORDER BY p.created_at DESC LIMIT 1) AS audit_ref,
            (SELECT amount_cents FROM audit_purchases p WHERE p.audit_id = a.id AND p.is_test = FALSE AND p.kind = 'audit' ORDER BY p.created_at DESC LIMIT 1) AS audit_amount,
            (SELECT created_at FROM audit_purchases p WHERE p.audit_id = a.id AND p.is_test = FALSE AND p.kind = 'audit' ORDER BY p.created_at DESC LIMIT 1) AS audit_at,
            (SELECT buyer_email FROM audit_purchases p WHERE p.audit_id = a.id AND p.is_test = FALSE AND p.kind = 'bundle' ORDER BY p.created_at DESC LIMIT 1) AS bundle_buyer,
            (SELECT stripe_ref FROM audit_purchases p WHERE p.audit_id = a.id AND p.is_test = FALSE AND p.kind = 'bundle' ORDER BY p.created_at DESC LIMIT 1) AS bundle_ref,
            (SELECT amount_cents FROM audit_purchases p WHERE p.audit_id = a.id AND p.is_test = FALSE AND p.kind = 'bundle' ORDER BY p.created_at DESC LIMIT 1) AS bundle_amount,
            (SELECT created_at FROM audit_purchases p WHERE p.audit_id = a.id AND p.is_test = FALSE AND p.kind = 'bundle' ORDER BY p.created_at DESC LIMIT 1) AS bundle_at,
            (SELECT buyer_email FROM audit_purchases p WHERE p.audit_id = a.id AND p.is_test = FALSE AND p.kind = 'guide' ORDER BY p.created_at DESC LIMIT 1) AS guide_buyer,
            (SELECT stripe_ref FROM audit_purchases p WHERE p.audit_id = a.id AND p.is_test = FALSE AND p.kind = 'guide' ORDER BY p.created_at DESC LIMIT 1) AS guide_ref,
            (SELECT amount_cents FROM audit_purchases p WHERE p.audit_id = a.id AND p.is_test = FALSE AND p.kind = 'guide' ORDER BY p.created_at DESC LIMIT 1) AS guide_amount,
            (SELECT created_at FROM audit_purchases p WHERE p.audit_id = a.id AND p.is_test = FALSE AND p.kind = 'guide' ORDER BY p.created_at DESC LIMIT 1) AS guide_at,
            EXISTS (SELECT 1 FROM audit_deliveries d WHERE d.audit_id = a.id AND d.kind = 'report' AND d.is_test = FALSE) AS report_sent
     FROM audits a
     WHERE a.unlock_status IN ('audit_paid', 'guide_paid', 'bundle_paid')`);
  const queues = {
    audit: { label: "Website Tracking Audit", items: [] },
    guide: { label: "Tracking Fix Guide", items: [] },
    bundle: { label: "Audit + Guide Bundle", items: [] },
  };
  const byEmail = (items) => {
    const m = {};
    for (const it of items) {
      const k = it.buyerEmail || "(no email given)";
      m[k] = (m[k] || 0) + 1;
    }
    return Object.entries(m).map(([email, count]) => ({ email, count }))
      .sort((a, b) => b.count - a.count || a.email.localeCompare(b.email));
  };
  for (const o of orders) {
    const item = {
      source: "order", orderId: o.id, auditId: o.audit_id || null,
      domain: o.domain, website: o.website, storeType: o.store_type,
      buyerEmail: o.buyer_email || null, stripeRef: null, stripeMatched: false,
      amountCents: o.choice === "bundle" ? 4000 : 2500,
      createdAt: o.created_at, state: "awaiting payment match",
    };
    queues[o.choice].items.push(item);
  }
  for (const a of paid) {
    if (a.unlock_status === "audit_paid" && !a.report_sent) {
      queues.audit.items.push({
        source: "purchase", orderId: null, auditId: a.id,
        domain: a.domain, website: a.domain, storeType: a.store_type,
        buyerEmail: a.audit_buyer || null, stripeRef: a.audit_ref || null, stripeMatched: !!a.audit_ref,
        amountCents: a.audit_amount || 2500, createdAt: a.audit_at,
        state: "paid — report not sent",
      });
    }
    if (a.unlock_status === "bundle_paid" && (!a.report_sent || a.guide_status !== "delivered")) {
      queues.bundle.items.push({
        source: "purchase", orderId: null, auditId: a.id,
        domain: a.domain, website: a.domain, storeType: a.store_type,
        buyerEmail: a.bundle_buyer || null, stripeRef: a.bundle_ref || null, stripeMatched: !!a.bundle_ref,
        amountCents: a.bundle_amount || 4000, createdAt: a.bundle_at,
        state: !a.report_sent ? "paid — report not sent" : "paid — guide not sent",
      });
    }
    if (a.unlock_status === "guide_paid" && a.guide_status !== "delivered" && a.guide_buyer) {
      queues.guide.items.push({
        source: "purchase", orderId: null, auditId: a.id,
        domain: a.domain, website: a.domain, storeType: a.store_type,
        buyerEmail: a.guide_buyer || null, stripeRef: a.guide_ref || null, stripeMatched: !!a.guide_ref,
        amountCents: a.guide_amount || 2500, createdAt: a.guide_at,
        state: "paid — guide not sent",
      });
    }
  }
  for (const k of Object.keys(queues)) {
    queues[k].items.sort((x, y) => new Date(x.createdAt || 0) - new Date(y.createdAt || 0));
    queues[k].byEmail = byEmail(queues[k].items);
    queues[k].count = queues[k].items.length;
  }
  return queues;
}

// ---------- Resend metrics (account-level: HKL + Apex combined) ----------
function resendGet(path) {
  const key = process.env.RESEND_API_KEY || "";
  if (!key) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "api.resend.com", path, method: "GET",
      headers: { Authorization: "Bearer " + key, Accept: "application/json" },
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const j = JSON.parse(body);
          if (res.statusCode !== 200) return resolve({ error: (j && j.message) || ("HTTP " + res.statusCode) });
          resolve(j);
        } catch (e) { resolve({ error: "bad response from Resend" }); }
      });
    });
    req.on("error", (e) => resolve({ error: String(e.message || e).slice(0, 120) }));
    req.setTimeout(10000, () => { req.destroy(new Error("timeout")); resolve({ error: "timeout" }); });
    req.end();
  });
}

function mountHome(app, authRequired) {
  const needPg = (req, res) => !pgEnabled() && noPg(res);

  // ---------- home summary: one number per card ----------
  app.get("/api/home", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const pool = getPool();
      const sites = store.loadSites();
      const openInvoices = [];
      let paidInvoices = 0;
      for (const s of sites) {
        for (const inv of (s.invoices || [])) {
          if (inv.status === "deleted") continue;
          if (inv.status === "open") openInvoices.push({ site: s.name, number: inv.number, due: inv.dueDate });
          if (inv.status === "paid") paidInvoices++;
        }
      }
      const queues = await buildQueues(pool);
      const { rows: ac } = await pool.query(
        "SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE score IS NOT NULL)::int AS scored FROM audits");
      const { rows: cc } = await pool.query("SELECT COUNT(*)::int AS n FROM customers");
      const { rows: lc } = await pool.query(
        "SELECT COUNT(*) FILTER (WHERE status = 'todo')::int AS todo, COUNT(*) FILTER (WHERE status = 'tracking')::int AS tracking FROM local_seo_items");
      const { rows: bc } = await pool.query(
        "SELECT COUNT(*) FILTER (WHERE status = 'pending')::int AS pending, COUNT(*) FILTER (WHERE status = 'live')::int AS live, COUNT(*) FILTER (WHERE status = 'down')::int AS down FROM bots");
      const { rows: mc } = await pool.query(
        "SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'draft')::int AS draft, COUNT(*) FILTER (WHERE status = 'live')::int AS live FROM mockups");
      const { rows: tc } = await pool.query(
        "SELECT COUNT(*)::int AS total, MIN(end_date)::text AS soonest_end FROM mrtv_customers");
      // Upcoming: rows still needing Ryan (scheduled / approved / held /
      // overdue). Same computation as the panel; the panel itself is
      // authoritative and refreshes invoice statuses on load.
      let upcomingOpen = null;
      try {
        const rows = computeRows(sites, loadApprovals(), loadReminderState());
        upcomingOpen = rows.filter((r) => ["scheduled", "approved", "held", "overdue"].includes(r.status)).length;
      } catch (e) { upcomingOpen = null; }
      res.json({
        sites: { total: sites.length },
        audits: {
          total: ac[0].total, scored: ac[0].scored,
          queues: { audit: queues.audit.count, guide: queues.guide.count, bundle: queues.bundle.count },
        },
        invoices: { open: openInvoices.length, openList: openInvoices, paid: paidInvoices },
        upcoming: { open: upcomingOpen },
        customers: { total: cc[0].n },
        localSeo: { todo: lc[0].todo, tracking: lc[0].tracking },
        bots: { pending: bc[0].pending, live: bc[0].live, down: bc[0].down },
        mockups: { total: mc[0].total, draft: mc[0].draft, live: mc[0].live },
        mrtv: { total: tc[0].total, soonestEnd: tc[0].soonest_end },
      });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // ---------- audit queues (counts live ONLY in the Audits detail) ----------
  app.get("/api/audits/queues", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      res.json(await buildQueues(getPool()));
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // ---------- report preview (review before send — no email leaves) ----------
  app.get("/api/audits/:id/report/preview", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const pool = getPool();
      const { getAudit } = require("./audits");
      const { reportEmailBody } = require("./audit-billing");
      const audit = await getAudit(pool, req.params.id);
      if (!audit) return res.status(404).json({ error: "not found" });
      const { rows: p } = await pool.query(
        `SELECT buyer_email FROM audit_purchases WHERE audit_id = $1 AND kind = ANY($2) AND is_test = FALSE
         ORDER BY created_at DESC LIMIT 1`,
        [req.params.id, ["audit", "bundle"]]);
      const paid = !!p.length;
      res.json({
        paid,
        to: paid ? (p[0].buyer_email || null) : null,
        subject: "Your Tracking Health Score report — " + audit.maskedDomain,
        body: reportEmailBody(audit),
      });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // ---------- customers ----------
  app.get("/api/customers", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const pool = getPool();
      const { rows: customers } = await pool.query(
        "SELECT id, display_name, contact_name, email, phone, notes, products, created_at FROM customers ORDER BY display_name ASC");
      const { rows: sites } = await pool.query(
        "SELECT id, customer_id, name, url, client_email FROM sites ORDER BY name ASC");
      const { rows: invs } = await pool.query(
        "SELECT site_id, status, amount_cents FROM invoices WHERE status != 'deleted'");
      const invBySite = {};
      for (const iv of invs) (invBySite[iv.site_id] = invBySite[iv.site_id] || []).push(iv);
      const siteByCustomer = {};
      for (const s of sites) {
        if (s.customer_id) (siteByCustomer[s.customer_id] = siteByCustomer[s.customer_id] || []).push(s);
      }
      const out = customers.map((c) => {
        const cs = siteByCustomer[c.id] || [];
        let openCount = 0, openCents = 0, pastCount = 0;
        for (const s of cs) {
          for (const iv of (invBySite[s.id] || [])) {
            if (iv.status === "open") { openCount++; openCents += iv.amount_cents || 0; }
            else if (iv.status === "paid" || iv.status === "void") pastCount++;
          }
        }
        // Sites whose client email matches but which were never linked to
        // the customer row (pre-migration strays) still count as "has".
        const stray = sites.filter((s) => !s.customer_id && c.email && s.client_email &&
          s.client_email.toLowerCase() === String(c.email).toLowerCase());
        const allSites = cs.concat(stray);
        return {
          id: c.id, displayName: c.display_name, contactName: c.contact_name,
          email: c.email, phone: c.phone, notes: c.notes, products: c.products || [],
          sites: allSites.map((s) => ({ id: s.id, name: s.name, url: s.url })),
          outstanding: { count: openCount, amountCents: openCents },
          before: { pastInvoices: pastCount },
        };
      });
      res.json({ total: out.length, customers: out, products: APEX_PRODUCTS });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  app.post("/api/customers", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const b = req.body || {};
      const name = cleanStr(b.display_name, 120);
      if (!name) return res.status(400).json({ error: "customer name required" });
      const email = cleanStr(b.email, 120);
      if (email && !isEmail(email)) return res.status(400).json({ error: "that email doesn't look right" });
      const products = Array.isArray(b.products)
        ? [...new Set(b.products.map((p) => cleanStr(p, 60)).filter((p) => APEX_PRODUCTS.includes(p)))] : [];
      const { rows } = await getPool().query(
        `INSERT INTO customers (display_name, contact_name, email, phone, notes, products)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, display_name, contact_name, email, phone, notes, products`,
        [name, cleanStr(b.contact_name, 60) || null, email || null,
         cleanStr(b.phone, 40) || null, cleanStr(b.notes, 1000) || null, products]);
      res.json({ ok: true, customer: rows[0] });
    } catch (e) {
      if (String(e.code) === "23505") return res.status(400).json({ error: "a customer with that email already exists" });
      res.status(500).json({ error: String(e.message || e).slice(0, 300) });
    }
  });

  app.put("/api/customers/:id", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const b = req.body || {};
      const sets = [], params = [];
      const put = (col, val) => { params.push(val); sets.push(col + " = $" + params.length); };
      if (b.display_name !== undefined) put("display_name", cleanStr(b.display_name, 120));
      if (b.contact_name !== undefined) put("contact_name", cleanStr(b.contact_name, 60) || null);
      if (b.email !== undefined) {
        const email = cleanStr(b.email, 120);
        if (email && !isEmail(email)) return res.status(400).json({ error: "that email doesn't look right" });
        put("email", email || null);
      }
      if (b.phone !== undefined) put("phone", cleanStr(b.phone, 40) || null);
      if (b.notes !== undefined) put("notes", cleanStr(b.notes, 1000) || null);
      if (b.products !== undefined) {
        put("products", Array.isArray(b.products)
          ? [...new Set(b.products.map((p) => cleanStr(p, 60)).filter((p) => APEX_PRODUCTS.includes(p)))] : []);
      }
      if (!sets.length) return res.status(400).json({ error: "nothing to update" });
      params.push(req.params.id);
      const { rows } = await getPool().query(
        `UPDATE customers SET ${sets.join(", ")}, updated_at = now() WHERE id = $${params.length}
         RETURNING id, display_name, contact_name, email, phone, notes, products`,
        params);
      if (!rows.length) return res.status(404).json({ error: "not found" });
      res.json({ ok: true, customer: rows[0] });
    } catch (e) {
      if (String(e.code) === "23505") return res.status(400).json({ error: "a customer with that email already exists" });
      res.status(500).json({ error: String(e.message || e).slice(0, 300) });
    }
  });

  // ---------- local SEO ----------
  app.get("/api/local-seo", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const { rows } = await getPool().query(
        "SELECT id, business_name, kind, status, flags, notes, created_at FROM local_seo_items ORDER BY created_at ASC");
      res.json({
        todo: rows.filter((r) => r.status === "todo"),
        tracking: rows.filter((r) => r.status === "tracking"),
      });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });
  app.post("/api/local-seo", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const b = req.body || {};
      const name = cleanStr(b.business_name, 120);
      if (!name) return res.status(400).json({ error: "business name required" });
      const kind = ["gbp", "local_seo", "other"].includes(b.kind) ? b.kind : "gbp";
      const { rows } = await getPool().query(
        "INSERT INTO local_seo_items (business_name, kind, flags, notes) VALUES ($1,$2,$3,$4) RETURNING id",
        [name, kind, b.flags && typeof b.flags === "object" ? b.flags : {}, cleanStr(b.notes, 1000) || ""]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });
  app.post("/api/local-seo/:id/done", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const { rowCount } = await getPool().query(
        "UPDATE local_seo_items SET status = 'tracking', updated_at = now() WHERE id = $1 AND status = 'todo'",
        [req.params.id]);
      if (!rowCount) return res.status(404).json({ error: "item not found or already tracking" });
      res.json({ ok: true, status: "tracking" });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // ---------- bots ----------
  app.get("/api/bots", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const { rows } = await getPool().query(
        "SELECT id, company, name, platform, status, last_seen, notes, created_at FROM bots ORDER BY company ASC, name ASC");
      res.json({ bots: rows });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });
  app.post("/api/bots", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const b = req.body || {};
      const company = cleanStr(b.company, 120), name = cleanStr(b.name, 120);
      if (!company || !name) return res.status(400).json({ error: "company and bot name required" });
      const platform = ["telegram", "discord", "other"].includes(b.platform) ? b.platform : "telegram";
      const { rows } = await getPool().query(
        "INSERT INTO bots (company, name, platform, notes) VALUES ($1,$2,$3,$4) RETURNING id",
        [company, name, platform, cleanStr(b.notes, 1000) || ""]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });
  app.post("/api/bots/:id/status", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const st = String((req.body || {}).status || "");
      if (!["pending", "live", "down"].includes(st)) return res.status(400).json({ error: "status must be pending, live or down" });
      const { rowCount } = await getPool().query(
        "UPDATE bots SET status = $1, updated_at = now() WHERE id = $2", [st, req.params.id]);
      if (!rowCount) return res.status(404).json({ error: "not found" });
      res.json({ ok: true, status: st });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // ---------- mock-ups ----------
  app.get("/api/mockups", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const { rows } = await getPool().query(
        "SELECT id, name, client, url, status, notes, created_at FROM mockups ORDER BY created_at ASC");
      res.json({ mockups: rows });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });
  app.post("/api/mockups", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const b = req.body || {};
      const name = cleanStr(b.name, 120);
      if (!name) return res.status(400).json({ error: "mock-up name required" });
      const { rows } = await getPool().query(
        "INSERT INTO mockups (name, client, url, notes) VALUES ($1,$2,$3,$4) RETURNING id",
        [name, cleanStr(b.client, 120) || null, cleanStr(b.url, 300) || null, cleanStr(b.notes, 1000) || ""]);
      res.json({ ok: true, id: rows[0].id });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });
  app.post("/api/mockups/:id/status", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const st = String((req.body || {}).status || "");
      if (!["draft", "changes", "approved", "live"].includes(st)) return res.status(400).json({ error: "status must be draft, changes, approved or live" });
      const { rowCount } = await getPool().query(
        "UPDATE mockups SET status = $1, updated_at = now() WHERE id = $2", [st, req.params.id]);
      if (!rowCount) return res.status(404).json({ error: "not found" });
      res.json({ ok: true, status: st });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // ---------- M.R. TV ----------
  app.get("/api/mrtv/customers", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const today = nyToday();
      const { rows } = await getPool().query(
        "SELECT id, name, email, plan, start_date, end_date, notes, created_at FROM mrtv_customers ORDER BY end_date ASC");
      res.json({
        customers: rows.map((r) => ({
          id: r.id, name: r.name, email: r.email, plan: r.plan,
          startDate: r.start_date ? r.start_date.toISOString().slice(0, 10) : null,
          endDate: r.end_date ? r.end_date.toISOString().slice(0, 10) : null,
          daysLeft: r.end_date ? daysBetween(today, r.end_date.toISOString().slice(0, 10)) : null,
          notes: r.notes,
        })),
        invoiceRouteOpen: true,
        note: "Invoice route is still open: through the TV provider, or through Apex invoicing? Not decided yet.",
      });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });
  app.post("/api/mrtv/customers", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const b = req.body || {};
      const name = cleanStr(b.name, 120);
      if (!name) return res.status(400).json({ error: "customer name required" });
      const email = cleanStr(b.email, 120);
      if (email && !isEmail(email)) return res.status(400).json({ error: "that email doesn't look right" });
      const plan = b.plan === "monthly" ? "monthly" : "yearly";
      const start = /^\d{4}-\d{2}-\d{2}$/.test(String(b.start_date || "")) ? b.start_date : nyToday();
      const end = plan === "monthly" ? addMonthsISO(start, 1) : addYearsISO(start, 1);
      const { rows } = await getPool().query(
        "INSERT INTO mrtv_customers (name, email, plan, start_date, end_date, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, start_date, end_date",
        [name, email || null, plan, start, end, cleanStr(b.notes, 1000) || ""]);
      res.json({
        ok: true, id: rows[0].id,
        startDate: rows[0].start_date.toISOString().slice(0, 10),
        endDate: rows[0].end_date.toISOString().slice(0, 10),
        daysLeft: daysBetween(nyToday(), rows[0].end_date.toISOString().slice(0, 10)),
      });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });
  // Update an M.R. TV customer (name, email, plan, dates, notes). Any subset.
  app.patch("/api/mrtv/customers/:id", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const b = req.body || {};
      const sets = [], vals = [];
      const push = (col, v) => { vals.push(v); sets.push(col + " = $" + vals.length); };
      if (b.name !== undefined) {
        const name = cleanStr(b.name, 120);
        if (!name) return res.status(400).json({ error: "customer name required" });
        push("name", name);
      }
      if (b.email !== undefined) {
        const email = cleanStr(b.email, 120);
        if (email && !isEmail(email)) return res.status(400).json({ error: "that email doesn't look right" });
        push("email", email || null);
      }
      if (b.plan !== undefined) push("plan", b.plan === "monthly" ? "monthly" : "yearly");
      const iso = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null;
      if (b.start_date !== undefined) { const s = iso(b.start_date); if (!s) return res.status(400).json({ error: "bad start_date" }); push("start_date", s); }
      if (b.end_date !== undefined) { const s = iso(b.end_date); if (!s) return res.status(400).json({ error: "bad end_date" }); push("end_date", s); }
      if (b.notes !== undefined) push("notes", cleanStr(b.notes, 1000) || "");
      if (!sets.length) return res.status(400).json({ error: "nothing to update" });
      vals.push(req.params.id);
      const { rows } = await getPool().query(
        "UPDATE mrtv_customers SET " + sets.join(", ") + " WHERE id = $" + vals.length +
        " RETURNING id, name, email, plan, start_date, end_date", vals);
      if (!rows.length) return res.status(404).json({ error: "customer not found" });
      const r0 = rows[0], today = nyToday();
      res.json({ ok: true, id: r0.id, name: r0.name, email: r0.email, plan: r0.plan,
        startDate: r0.start_date ? r0.start_date.toISOString().slice(0, 10) : null,
        endDate: r0.end_date ? r0.end_date.toISOString().slice(0, 10) : null,
        daysLeft: r0.end_date ? daysBetween(today, r0.end_date.toISOString().slice(0, 10)) : null });
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });

  // ---------- M.R. TV profit-split ledger (Mark + Ryan, 50/50) ----------
  // Event-sourced tracker: four boxes + credits remaining, derived by
  // replaying ledger events. Lives in the M.R. TV card detail.
  try { require("./mrtv-ledger").mountMrtvLedger(app, authRequired); }
  catch (e) { console.error("mrtv-ledger mount", e.message); }

  // ---------- email stats ----------
  app.get("/api/email/stats", authRequired, async (req, res) => {
    try {
      if (needPg(req, res)) return;
      const pool = getPool();
      const today = nyToday(), monthStart = nyMonthStart();
      // MONTHLY RESET (Ryan 2026-10-28): every count here is for the
      // CURRENT month only — the 1st to today — never an all-time total.
      // The month label + reset date ride along so the card can say so.
      const monthLabel = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", month: "long", year: "numeric" });
      const resetsOn = addMonthsISO(monthStart, 1);
      // Dashboard's own sends, from PG (these go out via MXroute SMTP,
      // not Resend — so they are NOT in the Resend numbers below).
      const { rows: d } = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE delivered_at::date = $1::date AND is_test = FALSE)::int AS today,
                COUNT(*) FILTER (WHERE delivered_at >= $2::date AND is_test = FALSE)::int AS month
         FROM audit_deliveries`,
        [today, monthStart]);
      const { rows: iv } = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE sent_at::date = $1::date)::int AS today,
                COUNT(*) FILTER (WHERE sent_at >= $2::date)::int AS month
         FROM invoices WHERE sent_at IS NOT NULL`,
        [today, monthStart]);
      const out = {
        resendConfigured: !!(process.env.RESEND_API_KEY || ""),
        resend: null, resendError: null,
        monthLabel, resetsOn,
        // Headline number = this month's sends, resetting on the 1st.
        // The account's all-time total is never shown here.
        dashboard: {
          auditEmails: { today: d[0].today, month: d[0].month },
          invoiceEmails: { today: iv[0].today, month: iv[0].month },
          note: "Dashboard invoice + audit emails send via MXroute SMTP (hello@), not Resend — they are counted here, not in the Resend numbers.",
        },
        // No API exposes the account's monthly quota; the limit stays
        // blank rather than guessed. Free = 3,000/mo + 100/day, paid
        // tiers differ — check the Resend dashboard for this account.
        limit: null,
        limitNote: "Resend has no API for the account's monthly quota — check the Resend dashboard for the limit on this account.",
      };
      if (out.resendConfigured) {
        const q = (s, e) => "/emails/metrics?start_date=" + s + "&end_date=" + e +
          "&timezone=America%2FNew_York&metrics=sent%2Cdelivered%2Cbounced%2Cfailed";
        const [t, m] = await Promise.all([resendGet(q(today, today)), resendGet(q(monthStart, today))]);
        if ((t && t.error) || (m && m.error)) {
          out.resendError = (t && t.error) || (m && m.error);
        } else {
          const tot = (j) => (j && j.totals) || {};
          out.resend = {
            // Account-level: HKL + Apex API sends combined (one account).
            today: { sent: tot(t).sent ?? null, delivered: tot(t).delivered ?? null, bounced: tot(t).bounced ?? null, failed: tot(t).failed ?? null },
            month: { sent: tot(m).sent ?? null, delivered: tot(m).delivered ?? null, bounced: tot(m).bounced ?? null, failed: tot(m).failed ?? null },
            combinedNote: "Resend account-level — HKL + Apex API sends combined (one shared Resend account).",
          };
        }
      }
      res.json(out);
    } catch (e) { res.status(500).json({ error: String(e.message || e).slice(0, 300) }); }
  });
}

module.exports = { mountHome, buildQueues, APEX_PRODUCTS };
