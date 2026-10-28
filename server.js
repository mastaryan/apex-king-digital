const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'sites.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const API_TOKEN = process.env.API_TOKEN || '';
const RENDER_API_KEY = process.env.RENDER_API_KEY || '';

app.use(express.json({ limit: '6mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

// ---------- tiny session auth ----------
const sessions = new Set();
function getSessionToken(req) {
  const cookies = (req.headers.cookie || '').split(';').map(c => c.trim());
  const hit = cookies.find(c => c.startsWith('sess='));
  return hit ? hit.slice(5) : null;
}
function authRequired(req, res, next) {
  const t = getSessionToken(req);
  if (t && sessions.has(t)) return next();
  const auth = req.headers.authorization || '';
  if (API_TOKEN && auth === 'Bearer ' + API_TOKEN) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

app.post('/api/login', (req, res) => {
  if (ADMIN_PASSWORD && req.body && req.body.password === ADMIN_PASSWORD) {
    const t = crypto.randomBytes(24).toString('hex');
    sessions.add(t);
    res.setHeader('Set-Cookie', `sess=${t}; HttpOnly; Path=/; SameSite=Lax; Max-Age=2592000`);
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'bad password' });
});

app.post('/api/logout', (req, res) => {
  const t = getSessionToken(req);
  if (t) sessions.delete(t);
  res.setHeader('Set-Cookie', 'sess=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const t = getSessionToken(req);
  res.json({ authed: !!(t && sessions.has(t)) });
});

// ---------- TEMPORARY Postgres admin endpoints (Phase 1) ----------
// TODO(phase1): REMOVE /api/admin/migrate and /api/admin/compare at cutover.
// Admin-only (same auth as /api/sites). The migration runs ON the Render
// service because this box cannot open direct DB connections.
app.post('/api/admin/migrate', authRequired, async (req, res) => {
  try {
    const { getPool } = require('./db/pg');
    const { migrateSnapshot } = require('./db/migrate');
    const pool = getPool();
    // Schema first (idempotent), then the snapshot load.
    const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
    await pool.query(schema);
    const snap = req.body || {};
    const report = await migrateSnapshot(pool, {
      sites: snap.sites || [], approvals: snap.approvals || {},
      reminderState: snap.reminderState || {}, attachments: snap.attachments || [],
      cronReminderState: snap.cronReminderState || {},
    });
    res.json({ ok: true, report });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 500) });
  }
});

app.get('/api/admin/compare', authRequired, async (req, res) => {
  try {
    const { compareState } = require('./db/compare');
    res.json(await compareState());
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 500) });
  }
});

// ---------- TEMPORARY Postgres admin endpoint (card home) ----------
// TODO(phase1): REMOVE /api/admin/schema at cutover, with migrate/compare.
// Applies db/schema.sql ONLY (idempotent CREATE/ALTER/seed) — it never
// loads a snapshot, so it cannot wipe newer PG data the way re-running
// /api/admin/migrate would. Used to create the card-home tables on Render.
app.post('/api/admin/schema', authRequired, async (req, res) => {
  try {
    const { getPool } = require('./db/pg');
    const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
    await getPool().query(schema);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 500) });
  }
});

// ---------- sites store (centralized: db/store.js) ----------
// Files are the source of truth during dual-write; the PG mirror updates
// after every file write when USE_POSTGRES=1 (see db/store.js).
const store = require("./db/store");
const loadSites = store.loadSites;
const saveSites = store.saveSites;
function newId(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' +
    crypto.randomBytes(3).toString('hex');
}

app.get('/api/sites', authRequired, (req, res) => {
  res.json(loadSites());
});

app.post('/api/sites', authRequired, async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.url) return res.status(400).json({ error: 'name and url required' });
  const sites = loadSites();
  const site = {
    id: newId(b.name),
    name: String(b.name).slice(0, 80),
    url: String(b.url).slice(0, 200),
    renderServiceId: String(b.renderServiceId || '').slice(0, 40),
    domainRenewal: b.domainRenewal || null,
    hostingRenewal: b.hostingRenewal || null,
    clientEmail: String(b.clientEmail || '').slice(0, 120),
    contactName: String(b.contactName || '').slice(0, 60),
    notes: String(b.notes || '').slice(0, 500),
  };
  sites.push(site);
  await saveSites(sites);
  res.json(site);
});

app.put('/api/sites/:id', authRequired, async (req, res) => {
  const sites = loadSites();
  const i = sites.findIndex(s => s.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  for (const k of ['name', 'url', 'renderServiceId', 'domainRenewal', 'hostingRenewal', 'clientEmail', 'contactName', 'notes', 'invoiceGateHold']) {
    if (b[k] !== undefined) sites[i][k] = b[k] === '' ? (k === 'domainRenewal' || k === 'hostingRenewal' ? null : '') : b[k];
  }
  await saveSites(sites);
  res.json(sites[i]);
});

app.delete('/api/sites/:id', authRequired, async (req, res) => {
  const sites = loadSites();
  const kept = sites.filter(s => s.id !== req.params.id);
  if (kept.length === sites.length) return res.status(404).json({ error: 'not found' });
  await saveSites(kept);
  res.json({ ok: true });
});

// ---------- live Render status ----------
function renderGet(apiPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.render.com',
      path: apiPath,
      method: 'GET',
      headers: { 'Authorization': 'Bearer ' + RENDER_API_KEY, 'Accept': 'application/json' },
    }, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

app.get('/api/status', authRequired, async (req, res) => {
  if (!RENDER_API_KEY) return res.json({ configured: false, services: {} });
  const sites = loadSites();
  const ids = [...new Set(sites.map(s => s.renderServiceId).filter(Boolean))];
  const out = {};
  await Promise.all(ids.map(async (id) => {
    try {
      const svc = await renderGet('/v1/services/' + encodeURIComponent(id));
      const s = (svc.data && svc.data.service) || {};
      let deployStatus = null, finishedAt = null;
      try {
        const dep = await renderGet('/v1/services/' + encodeURIComponent(id) + '/deploys?limit=1');
        const list = Array.isArray(dep.data) ? dep.data : (dep.data.deploys || []);
        const d = (list[0] && list[0].deploy) || {};
        deployStatus = d.status || null;
        finishedAt = d.finishedAt || d.createdAt || null;
      } catch (e) { /* leave null */ }
      const suspended = s.suspended && s.suspended !== 'not_suspended';
      out[id] = {
        ok: !suspended && deployStatus === 'live',
        suspended: !!suspended,
        deployStatus, finishedAt,
        serviceName: s.name || null,
      };
    } catch (e) {
      out[id] = { ok: false, error: String(e.message || e).slice(0, 120) };
    }
  }));
  res.json({ configured: true, services: out });
});

// Stripe bridge (checkout sessions + webhook for storefront orders)
try { require('./stripe-bridge').mountStripeBridge(app); } catch (e) { console.error('stripe bridge mount', e.message); }

// Invoicing (renewal invoices, copy-to-Ryan email, review gate)
try { require('./invoices').mountInvoices(app, authRequired); } catch (e) { console.error('invoices mount', e.message); }

// Upcoming / To-Do panel (approval-gated scheduled actions)
try { require('./upcoming').mountUpcoming(app, authRequired); } catch (e) { console.error('upcoming mount', e.message); }

// Audits money flows (Phase 2): purchases, report/guide delivery (pay
// first, then send), fix quotes, re-audit, add-a-site, masked export,
// order flow. Mounted BEFORE mountAudits on purpose: GET
// /api/audits/orders must register before GET /api/audits/:id, or the
// orders list would be swallowed as id="orders".
try { require('./db/audit-billing').mountAuditBilling(app, authRequired); } catch (e) { console.error('audit billing mount', e.message); }

// Audits (Phase 2, Tracking Health Score) — PG-backed, behind login
try { require('./db/audits').mountAudits(app, authRequired); } catch (e) { console.error('audits mount', e.message); }

// Card home (2026-10-28): 9 cards, one per backend piece
try { require('./db/home').mountHome(app, authRequired); } catch (e) { console.error('home mount', e.message); }

app.listen(PORT, () => console.log('apex-dashboard listening on ' + PORT));
