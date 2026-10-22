// Apex King Digital — dashboard invoicing.
//
// Creates Stripe renewal invoices ($100 flat) from the dashboard, tracks
// them on each site record, and emails Ryan a copy of every sent invoice
// (Stripe invoice emails have no BCC — this is the equivalent). When an
// invoice carries an attachment (e.g. a client's SEO/performance review),
// the client also gets a companion email from hello@apexkingdigital.com
// with the file actually attached, since Stripe's API can't attach files
// to invoices.
//
// Renewal review gate (POST /api/invoice-gate/run, called by the daily
// reminders cron): at 45 days out a DRAFT is created and Ryan is nudged to
// review it in the dashboard; at 30 days out an untouched draft sends
// itself. 14-day terms, capped at the renewal date itself.
//
// Env (Render): STRIPE_SECRET_KEY, SMTP_HOST, SMTP_PORT, SMTP_USER,
// SMTP_PASS, INVOICE_COPY_EMAIL (defaults to sizemore.ryan@gmail.com).
"use strict";
const fs = require("fs");
const path = require("path");
const https = require("https");

const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data", "sites.json");
const RENEWAL_PRICE = "price_1USUeuIlE5qVTzReMWr2IKhe"; // Annual Website Renewal, $100
const COPY_EMAIL = process.env.INVOICE_COPY_EMAIL || "sizemore.ryan@gmail.com";
const FROM = "Apex King Digital <hello@apexkingdigital.com>";

// ---------- sites store (same file/format as server.js) ----------
function loadSites() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { return []; }
}
function saveSites(sites) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(sites, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// ---------- Stripe (form-encoded, same pattern as stripe-bridge) ----------
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
function stripeCall(method, apiPath, params) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return Promise.reject(new Error("stripe_key_missing"));
  const body = params ? formEncode(params) : "";
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: "api.stripe.com", path: apiPath, method,
      headers: {
        "Authorization": "Basic " + Buffer.from(key + ":").toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": Buffer.byteLength(body),
      },
    }, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { return reject(new Error("stripe_bad_json")); }
        if (res.statusCode >= 400) {
          const msg = (parsed && parsed.error && parsed.error.message) || ("stripe_http_" + res.statusCode);
          return reject(new Error(msg));
        }
        resolve(parsed);
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => req.destroy(new Error("stripe_timeout")));
    if (body) req.write(body);
    req.end();
  });
}

// ---------- mail (SMTP via nodemailer; silently skipped if unconfigured) ----------
function mailer() {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env["SMTP_" + "PASS"]) return null;
  const nodemailer = require("nodemailer");
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: Number(process.env.SMTP_PORT || 465) === 465,
    auth: { user: process.env.SMTP_USER, pass: process.env["SMTP_" + "PASS"] },
  });
}
async function sendMail(opts) {
  const t = mailer();
  if (!t) { console.log("invoice mail skipped (SMTP not configured):", opts.subject); return false; }
  try { await t.sendMail(Object.assign({ from: FROM }, opts)); return true; }
  catch (e) { console.error("invoice mail failed:", e.message); return false; }
}
function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(fetchBuffer(res.headers.location));
      }
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  });
}

// ---------- helpers ----------
function domainOf(site) {
  return String(site.url || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
}
function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso + "T12:00:00");
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/New_York" });
}
function daysUntil(iso) {
  if (!iso) return null;
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const d = new Date(iso + "T00:00:00");
  return Math.round((d - t) / 86400000);
}
function earliestRenewal(site) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  let best = null;
  for (const k of ["domainRenewal", "hostingRenewal"]) {
    const ds = site[k];
    if (!ds) continue;
    const d = new Date(ds + "T00:00:00");
    if (isNaN(d)) continue;
    if (best === null || d < best.d) best = { iso: ds, d };
  }
  return best ? best.iso : null;
}
function dueTs(iso) { // noon UTC on the due date — safely "that date" in US zones
  const d = new Date(iso + "T12:00:00Z");
  return Math.floor(d.getTime() / 1000);
}
function memoFor(site, renewalIso) {
  return "Annual website renewal for " + domainOf(site) + " — hosting, updates & care for the year ahead. Renewal date: " + fmtDate(renewalIso) + ". Thank you for your business!";
}
function lineFor(site, renewalIso) {
  return "Annual Website Renewal — " + site.name + " (" + domainOf(site) + ") — renews " + fmtDate(renewalIso);
}

async function findOrCreateCustomer(email, name) {
  const found = await stripeCall("GET", "/v1/customers?email=" + encodeURIComponent(email) + "&limit=1");
  if (found.data && found.data.length) return found.data[0];
  return stripeCall("POST", "/v1/customers", { email, name });
}

function publicRecord(rec) {
  return {
    id: rec.id, number: rec.number || null, status: rec.status,
    amount: rec.amount != null ? rec.amount : 10000, currency: rec.currency || "usd",
    test: !!rec.test, auto: !!rec.auto, renewalDate: rec.renewalDate, dueDate: rec.dueDate,
    createdAt: rec.createdAt, sentAt: rec.sentAt || null,
    hostedUrl: rec.hostedUrl || null, pdfUrl: rec.pdfUrl || null,
    attachmentName: rec.attachmentName || null, recipient: rec.recipient || null,
  };
}

async function refreshRecord(rec) {
  if (["paid", "void", "uncollectible", "deleted"].includes(rec.status)) return rec;
  try {
    const inv = await stripeCall("GET", "/v1/invoices/" + rec.id);
    rec.status = inv.status === "void" ? "void" : inv.status;
    rec.number = inv.number || rec.number;
    rec.amount = inv.amount_due != null ? inv.amount_due : rec.amount;
    rec.hostedUrl = inv.hosted_invoice_url || rec.hostedUrl;
    rec.pdfUrl = inv.invoice_pdf || rec.pdfUrl;
  } catch (e) { /* keep stored state */ }
  return rec;
}

// attachment bytes live next to the data file so companion/copy emails can
// re-attach them after a restart; kept out of sites.json (size).
function attachDir() {
  const dir = path.join(path.dirname(DATA_FILE), "invoice-attachments");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function saveAttachment(invId, att) {
  if (!att || !att.dataBase64) return null;
  const safe = String(att.filename || "attachment.pdf").replace(/[^\w.\-]+/g, "_").slice(0, 80);
  const file = path.join(attachDir(), invId + "__" + safe);
  fs.writeFileSync(file, Buffer.from(att.dataBase64, "base64"));
  return { filename: safe, file };
}
function readAttachment(rec) {
  if (!rec.attachmentFile) return null;
  try {
    return { filename: rec.attachmentName || "attachment.pdf", content: fs.readFileSync(rec.attachmentFile) };
  } catch { return null; }
}

async function emailCopyToRyan(site, rec, inv) {
  const atts = [];
  if (inv && inv.invoice_pdf) {
    try { atts.push({ filename: "Invoice-" + (inv.number || rec.id) + ".pdf", content: await fetchBuffer(inv.invoice_pdf) }); }
    catch (e) { /* link still in body */ }
  }
  const extra = readAttachment(rec);
  if (extra) atts.push(extra);
  await sendMail({
    to: COPY_EMAIL,
    subject: "Copy — Invoice " + (rec.number || "") + " sent to " + rec.recipient + " (" + site.name + ") — $100 due " + fmtDate(rec.dueDate),
    text:
      "Apex King Digital invoice sent.\n\n" +
      "Client: " + site.name + " (" + domainOf(site) + ")\n" +
      "Sent to: " + rec.recipient + (rec.test ? "  [TEST]" : "") + "\n" +
      "Invoice: " + (rec.number || rec.id) + "\n" +
      "Amount: $100.00   Due: " + fmtDate(rec.dueDate) + "   Renewal: " + fmtDate(rec.renewalDate) + "\n" +
      "View / pay: " + (rec.hostedUrl || "(link pending)") + "\n" +
      (rec.attachmentName ? "Attachment sent to client: " + rec.attachmentName + "\n" : "") +
      "\nThe invoice PDF is attached to this copy for your records.\n",
    attachments: atts,
  });
}

async function emailCompanionToClient(site, rec, inv) {
  const att = readAttachment(rec);
  if (!att) return;
  const first = (site.contactName || "").trim();
  await sendMail({
    to: rec.recipient,
    subject: "Your website performance & SEO review — " + site.name,
    text:
      (first ? "Hi " + first + ",\n\n" : "Hi,\n\n") +
      "Attached is the website performance & SEO review we prepared for " + site.name + " (" + domainOf(site) + ") — how the site performed this year and the improvements we recommend next.\n\n" +
      "Your annual website renewal invoice " + (rec.number || "") + " ($100, due " + fmtDate(rec.dueDate) + ") is coming in a separate email from Stripe. You can also view and pay it here:\n" + (rec.hostedUrl || "") + "\n\n" +
      "Questions? Just reply to this email or write us at hello@apexkingdigital.com.\n\n" +
      "Thank you for your business!\n— Ryan Sizemore, Apex King Digital\n",
    attachments: [att],
  });
}

async function createRenewalInvoice(site, opts) {
  // opts: { mode: "draft"|"send"|"test", dueIso, attachment: {filename, dataBase64}|null, auto }
  const mode = opts.mode || "draft";
  const renewalIso = earliestRenewal(site);
  if (!renewalIso) throw new Error("no_renewal_date");
  const dueIso = opts.dueIso || renewalIso;
  const isTest = mode === "test";
  const recipient = isTest ? COPY_EMAIL : (site.clientEmail || "").trim();
  if (!recipient) throw new Error("no_client_email");
  const customer = await findOrCreateCustomer(recipient, isTest ? "TEST — " + site.name : site.name);
  const daysDue = Math.max(0, daysUntil(dueIso) || 0);
  let inv;
  try {
    inv = await stripeCall("POST", "/v1/invoices", {
      customer: customer.id,
      collection_method: "send_invoice",
      days_until_due: daysDue,
      auto_advance: false,
      pending_invoice_items_behavior: "exclude",
      description: memoFor(site, renewalIso),
      metadata: {
        apex_site_id: site.id, renewal_date: renewalIso, kind: "annual_renewal",
        test: isTest ? "1" : "", auto: opts.auto ? "1" : "",
      },
    });
  } catch (e) { throw new Error("create_invoice: " + e.message); }
  try {
    await stripeCall("POST", "/v1/invoiceitems", {
      customer: customer.id, invoice: inv.id,
      pricing: { price: RENEWAL_PRICE }, description: lineFor(site, renewalIso),
    });
    const check = await stripeCall("GET", "/v1/invoices/" + inv.id);
    if (!check.total) throw new Error("line item did not attach (invoice total is 0)");
  } catch (e) { throw new Error("add_item: " + e.message); }
  const rec = {
    id: inv.id, number: null, status: "draft", amount: 10000, currency: "usd",
    test: isTest, auto: !!opts.auto, renewalDate: renewalIso, dueDate: dueIso,
    createdAt: new Date().toISOString(), sentAt: null,
    hostedUrl: null, pdfUrl: null, recipient,
    attachmentName: null, attachmentFile: null,
  };
  if (opts.attachment) {
    const saved = saveAttachment(inv.id, opts.attachment);
    if (saved) { rec.attachmentName = saved.filename; rec.attachmentFile = saved.file; }
  }
  site.invoices = site.invoices || [];
  site.invoices.unshift(rec);
  if (mode === "send" || isTest) {
    await finalizeSend(site, rec);
  }
  return rec;
}

async function finalizeSend(site, rec) {
  try { await stripeCall("POST", "/v1/invoices/" + rec.id + "/finalize"); }
  catch (e) { throw new Error("finalize: " + e.message); }
  let sent;
  try { sent = await stripeCall("POST", "/v1/invoices/" + rec.id + "/send"); }
  catch (e) { throw new Error("send: " + e.message); }
  rec.status = sent.status;
  rec.number = sent.number || rec.number;
  rec.hostedUrl = sent.hosted_invoice_url || rec.hostedUrl;
  rec.pdfUrl = sent.invoice_pdf || rec.pdfUrl;
  rec.sentAt = new Date().toISOString();
  // Companion (with the client's attachment) goes to whoever the recipient
  // is — for tests that's Ryan, so he sees exactly what the client gets.
  await emailCompanionToClient(site, rec, sent);
  await emailCopyToRyan(site, rec, sent);
  return rec;
}

// ---------- renewal review gate ----------
async function runGate() {
  const sites = loadSites();
  const summary = { drafted: [], sent: [], errors: [] };
  let dirty = false;
  for (const site of sites) {
    if (site.invoiceGateHold) { (summary.held = summary.held || []).push(site.name); continue; }
    if (!(site.clientEmail || "").trim()) continue;
    const renewalIso = earliestRenewal(site);
    if (!renewalIso) continue;
    const days = daysUntil(renewalIso);
    if (days === null || days > 45 || days < -7) continue;
    const year = renewalIso.slice(0, 4);
    site.invoices = site.invoices || [];
    const existing = site.invoices.filter(r => !r.test && r.renewalDate && r.renewalDate.slice(0, 4) === year && r.status !== "deleted");
    try {
      if (!existing.length && days <= 45 && days > 30) {
        const rec = await createRenewalInvoice(site, { mode: "draft", auto: true });
        dirty = true;
        summary.drafted.push({ site: site.name, id: rec.id, renewal: renewalIso });
        await sendMail({
          to: COPY_EMAIL,
          subject: "Renewal invoice draft ready — " + site.name + " (renews " + fmtDate(renewalIso) + ")",
          text: "A draft $100 renewal invoice for " + site.name + " (" + domainOf(site) + ") was created in the dashboard.\n\nReview or edit it any time — if it's untouched, it sends itself at 30 days out (" + fmtDate(renewalIso) + " renewal, due on the renewal date).\n\nDashboard: https://dashboard.apexkingdigital.com\n",
        });
      } else if (days <= 30) {
        const draft = existing.find(r => r.status === "draft");
        if (draft) {
          await finalizeSend(site, draft);
          dirty = true;
          summary.sent.push({ site: site.name, id: draft.id, key: "invoice:" + site.id + ":" + year });
        } else if (!existing.length) {
          // Late entry: site first seen inside the 30-day window — create and send now.
          const rec = await createRenewalInvoice(site, { mode: "send", auto: true });
          dirty = true;
          summary.sent.push({ site: site.name, id: rec.id, key: "invoice:" + site.id + ":" + year });
        } else if (existing.some(r => ["open", "paid", "uncollectible"].includes(r.status))) {
          summary.sent.push({ site: site.name, id: existing[0].id, key: "invoice:" + site.id + ":" + year, already: true });
        }
      }
    } catch (e) {
      summary.errors.push({ site: site.name, error: String(e.message || e).slice(0, 200) });
    }
  }
  if (dirty) saveSites(sites);
  return summary;
}

// ---------- HTTP ----------
function mountInvoices(app, authRequired) {
  app.post("/api/sites/:id/invoices", authRequired, async (req, res) => {
    const sites = loadSites();
    const site = sites.find(s => s.id === req.params.id);
    if (!site) return res.status(404).json({ error: "not found" });
    try {
      const rec = await createRenewalInvoice(site, {
        mode: (req.body && req.body.mode) || "draft",
        dueIso: (req.body && req.body.dueDate) || null,
        attachment: (req.body && req.body.attachment) || null,
      });
      saveSites(sites);
      res.json(publicRecord(rec));
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });

  app.get("/api/sites/:id/invoices", authRequired, async (req, res) => {
    const sites = loadSites();
    const site = sites.find(s => s.id === req.params.id);
    if (!site) return res.status(404).json({ error: "not found" });
    site.invoices = site.invoices || [];
    for (const rec of site.invoices) await refreshRecord(rec);
    saveSites(sites);
    res.json(site.invoices.map(publicRecord));
  });

  app.post("/api/sites/:id/invoices/:invId/send", authRequired, async (req, res) => {
    const sites = loadSites();
    const site = sites.find(s => s.id === req.params.id);
    if (!site) return res.status(404).json({ error: "not found" });
    const rec = (site.invoices || []).find(r => r.id === req.params.invId);
    if (!rec) return res.status(404).json({ error: "invoice not found" });
    if (rec.status !== "draft") return res.status(400).json({ error: "only drafts can be sent" });
    try {
      await finalizeSend(site, rec);
      saveSites(sites);
      res.json(publicRecord(rec));
    } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
  });

  app.post("/api/sites/:id/invoices/:invId/void", authRequired, async (req, res) => {
    const sites = loadSites();
    const site = sites.find(s => s.id === req.params.id);
    if (!site) return res.status(404).json({ error: "not found" });
    const rec = (site.invoices || []).find(r => r.id === req.params.invId);
    if (!rec) return res.status(404).json({ error: "invoice not found" });
    try {
      if (rec.status === "draft") {
        await stripeCall("DELETE", "/v1/invoices/" + rec.id);
        rec.status = "deleted";
      } else if (rec.status === "open") {
        const v = await stripeCall("POST", "/v1/invoices/" + rec.id + "/void");
        rec.status = v.status === "void" ? "void" : v.status;
      } else {
        return res.status(400).json({ error: "cannot void a " + rec.status + " invoice" });
      }
      saveSites(sites);
      res.json(publicRecord(rec));
    } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
  });

  app.post("/api/invoice-gate/run", authRequired, async (req, res) => {
    try { res.json(await runGate()); }
    catch (e) { res.status(500).json({ error: String(e.message || e) }); }
  });
}

module.exports = { mountInvoices, runGate };
