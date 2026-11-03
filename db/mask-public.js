// Apex dashboard — masked public-site builder (JS port).
//
// Faithful port of ~/workspace/tracking-health-score/mask_data.py +
// build_data.py (transform/enrichment). The Python pipeline remains the
// reference; this module must produce byte-equivalent masking semantics
// so the dashboard can publish the public tool without the Python box.
//
// What it does: takes raw audits (the /api/admin/audits/masked-export
// shape: id, domain, date, audit_scope, verdict, issues[{severity,text}],
// trackers[{name,status}]), scores + enriches each site, masks every
// domain to first-2-letters + ******, redacts tracker account IDs,
// emails and @handles from all text, and self-verifies that no real
// domain, email, handle or tracker ID survives in the output.
//
// The public tool gets ONLY the emitted audits.js — never a live query.
"use strict";

const ERROR_TRIGGERS = [
  "pre-consent", "unconditionally", "first load", "every page load",
  "every load", "no consent", "no gate", "ungated", "no opt-in",
  "before consent", "zero consent", "no consent gating",
  "no consent check", "mirrored server-side", "loads immediately",
  "loads pre-consent", "fires on every page",
];
const HEALTHY_TRIGGERS = [
  "gated on granted consent", "fires only post-purchase",
  "properly denied", "no script loaded",
];

function keywords(name) {
  const n = String(name || "").toLowerCase();
  if (n.includes("meta")) return ["meta"];
  if (n.includes("tiktok")) return ["tiktok"];
  if (n.includes("ga4") || n.includes("google analytics")) return ["ga4", "google analytics"];
  if (n.includes("google tag manager") || n.startsWith("gtm")) return ["gtm", "google tag manager"];
  if (n.includes("google ads")) return ["google ads"];
  if (n.includes("google /")) return ["google"];
  if (n.includes("clarity")) return ["clarity"];
  if (n.includes("omnisend")) return ["omnisend"];
  if (n.includes("klaviyo")) return ["klaviyo"];
  if (n.includes("snapchat")) return ["snapchat"];
  if (n.includes("reddit")) return ["reddit"];
  if (n.includes("bing")) return ["bing"];
  if (n.includes("pinterest")) return ["pinterest"];
  if (n.includes("privy")) return ["privy"];
  if (n.includes("mailchimp")) return ["mailchimp"];
  if (n.includes("hubspot")) return ["hubspot"];
  if (n.includes("reamaze")) return ["reamaze"];
  if (n.includes("recaptcha")) return ["recaptcha"];
  if (n.includes("cloudflare")) return ["cloudflare"];
  if (n.includes("jetpack")) return ["jetpack"];
  if (n.includes("rumble")) return ["rumble"];
  if (n.includes("zendesk")) return ["zendesk"];
  if (n.includes("lootly")) return ["lootly"];
  if (n.includes("gorgias")) return ["gorgias"];
  if (n.includes("cookieyes")) return ["cookieyes"];
  if (n.includes("whop")) return ["whop"];
  if (n.includes("newsbreak")) return ["newsbreak"];
  if (n.includes("trybe")) return ["trybe"];
  if (n.includes("tagada")) return ["tagada"];
  if (n.includes("goaffpro")) return ["goaffpro"];
  if (n.includes("x pixel") || n.includes("x ads") || n.includes("x conversion") || n.includes("x/twitter"))
    return ["x pixel", "x ads", "twitter"];
  if (n.includes("relay")) return ["relay", "server-side"];
  if (n.includes("affiliate")) return ["affiliate"];
  if (n.includes("support-chat")) return ["chat"];
  if (n.includes("first-party")) return ["first-party"];
  return [];
}

function instances(status) {
  const m = /(\d+)\s+(IDs|tags|containers)/.exec(String(status || ""));
  return m ? parseInt(m[1], 10) : 1;
}

function matching_issue(site, kws) {
  if (!kws || !kws.length) return null;
  const order = { critical: 0, warning: 1, info: 2 };
  const cands = [];
  for (const iss of site.issues || []) {
    const t = String(iss.text || "").toLowerCase();
    if (kws.some(k => t.includes(k))) cands.push(iss);
  }
  if (!cands.length) return null;
  cands.sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
  return cands[0];
}

function platform_rows(site) {
  const rows = [];
  for (const tr of site.trackers || []) {
    const name = tr.name, status = tr.status;
    const sl = String(status || "").toLowerCase();
    const kws = keywords(name);
    const match = matching_issue(site, kws);
    let st, issue;
    const details = status;
    if (sl.startsWith("absent")) {
      st = "Healthy"; issue = "Not installed — no loader found.";
    } else if (HEALTHY_TRIGGERS.some(t => sl.includes(t))) {
      st = "Healthy"; issue = match ? match.text : "Gated or correct — no pre-consent firing.";
    } else if (ERROR_TRIGGERS.some(t => sl.includes(t))) {
      st = "Error"; issue = match ? match.text : "Fires before consent — see findings below.";
    } else if (match && match.severity === "critical") {
      st = "Error"; issue = match.text;
    } else if (match) {
      st = "Warning"; issue = match.text;
    } else {
      st = "Warning"; issue = "Present — see findings below.";
    }
    rows.push({ name, status: st, issue, details });
  }
  return rows;
}

function transform_site(site) {
  const thin = String(site.verdict || "").startsWith("thin");
  const counts = { critical: 0, warning: 0, info: 0 };
  for (const iss of site.issues || []) {
    if (counts[iss.severity] !== undefined) counts[iss.severity]++;
  }
  const present = (site.trackers || []).filter(t => {
    const sl = String(t.status || "").toLowerCase();
    return sl.startsWith("present") && !sl.includes("no script loaded");
  });
  const active = present.reduce((n, t) => n + instances(t.status), 0);
  const dups = present.filter(t => instances(t.status) > 1).length;
  let score, label;
  if (thin) { score = null; label = "Limited audit"; }
  else {
    score = Math.max(0, 100 - 12 * counts.critical - 5 * counts.warning);
    label = score >= 85 ? "Healthy" : score >= 70 ? "Fair" : "Needs Attention";
  }
  return {
    ...site,
    thin, score, label,
    platforms: present.length,
    activeTrackers: active,
    duplicates: dups,
    counts,
    platformRows: platform_rows(site),
  };
}

// ---- masking ----

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const HANDLE_RE = /@[A-Za-z0-9_][A-Za-z0-9_.-]*/g;
// Mirrors the Python: "ID " + account-ID token (AW-…, G-…, 15-16 digits,
// or 5+ alnum chars containing a digit), case-insensitive.
const ID_WITH_PREFIX_RE = /\bID\s+(?:AW-\d+|G-[A-Z0-9]{6,}|\d{15,16}|(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9][A-Za-z0-9_-]{4,})\b/gi;
const BARE_ID_RE = /\b(?:AW-\d+|G-[A-Z0-9]{6,}|\d{15,16}|GTM-[A-Z0-9]+)\b/g;

function platform_label(name) {
  const n = String(name || "").toLowerCase();
  if (n.includes("meta")) return "Meta Pixel";
  if (n.includes("google ads")) return "Google Ads";
  if (n.includes("ga4") || n.includes("google analytics")) return "Google Analytics";
  return String(name || "tracker").trim() || "tracker";
}

function redact_ids(text, platform) {
  if (typeof text !== "string") return text;
  const label = platform ? platform_label(platform) : "tracker";
  let out = text.replace(ID_WITH_PREFIX_RE, "(" + label + ")");
  out = out.replace(BARE_ID_RE, "(" + label + ")");
  return out;
}

function mask_domain(domain) {
  const i = String(domain).lastIndexOf(".");
  const base = String(domain).slice(0, i), tld = String(domain).slice(i + 1);
  return base.slice(0, 2) + "******." + tld;
}

function buildMaskedMeta() {
  return {
    generated: new Date().toISOString().slice(0, 10),
    masked: true,
    source: "Apex King Digital website tracking audits. Findings are verbatim from the audits; scores are computed, not audit results. Domains are masked to their first two letters; contact details are stripped.",
    rubric: "Score = 100 − 12 per critical issue − 5 per warning (info = 0). 85+ Healthy, 70–84 Fair, below 70 Needs Attention. Limited-audit sites (network-level or legitimacy-only findings) carry no score.",
    billingUrl: "https://buy.stripe.com/7sY6oH9zd5nR9tz2gQ4Ni00",
    billingPrice: 25,
    guideUrl: "https://buy.stripe.com/14AaEX5iXdUn8pvbRq4Ni01",
    bundleUrl: "https://buy.stripe.com/00wdR99zdbMf49fbRq4Ni02",
  };
}

// data: array of {id, domain, date, audit_scope, verdict,
//                 issues:[{severity,text}], trackers:[{name,status}]}
// Returns {js, failures, sites} — failures is non-empty when the mask
// self-verification finds a leak; the caller must refuse to publish then.
function build_masked(data) {
  const domains = [...new Set(data.map(s => s.domain))].sort();
  const masked = {};
  for (const d of domains) masked[d] = mask_domain(d);
  // Longest first so no domain is a substring-match inside a longer one.
  const ordered = [...domains].sort((a, b) => b.length - a.length);

  function redact(text) {
    if (typeof text !== "string") return text;
    let out = text;
    for (const d of ordered) {
      if (out.includes(d)) out = out.split(d).join(masked[d]);
    }
    out = out.replace(EMAIL_RE, "[email redacted]");
    out = out.replace(HANDLE_RE, "[handle redacted]");
    return out;
  }

  const out = [];
  for (const site of data) {
    let s = transform_site(site);
    s = { ...s };
    s.id = site.id || s.id;
    s.domain = masked[s.domain];
    s.audit_scope = redact_ids(redact(s.audit_scope));
    s.verdict = s.verdict ? redact_ids(redact(s.verdict)) : null;
    s.issues = (s.issues || []).map(i => ({ ...i, text: redact_ids(redact(i.text)) }));
    s.trackers = (s.trackers || []).map(t => ({ ...t, status: redact_ids(redact(t.status), t.name) }));
    s.platformRows = (s.platformRows || []).map(r => ({
      ...r,
      issue: redact_ids(redact(r.issue), r.name),
      details: redact_ids(redact(r.details), r.name),
    }));
    out.push(s);
  }
  out.sort((a, b) =>
    (a.score === null) - (b.score === null) ||
    (a.score === null ? 0 : a.score) - (b.score === null ? 0 : b.score) ||
    (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));

  const meta = buildMaskedMeta();
  let js = "const META = " + JSON.stringify(meta, null, 2) + ";\n\nconst AUDITS = " + JSON.stringify(out, null, 2) + ";\n";

  // Safety net: no tracker account ID may survive anywhere in the output.
  const stray = js.match(BARE_ID_RE) || [];
  js = js.replace(BARE_ID_RE, "(tracker)");

  // ---- self-verification ----
  const failures = [];
  for (const d of domains) {
    if (js.includes(d)) failures.push("real domain leaked: " + d);
  }
  // fresh regexes (the /g/ ones above are stateful)
  const emailHit = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(js);
  if (emailHit) failures.push("email leaked: " + emailHit[0]);
  const handleHit = /@[A-Za-z0-9_][A-Za-z0-9_.-]*/.exec(js);
  if (handleHit) failures.push("handle leaked: " + handleHit[0]);
  const idHit = /\b(?:AW-\d+|G-[A-Z0-9]{6,}|\d{15,16}|GTM-[A-Z0-9]+)\b/.exec(js);
  if (idHit) failures.push("tracker id leaked: " + idHit[0]);
  if (stray.length) console.log("mask-public: safety net caught " + stray.length + " stray tracker id(s)");
  if (new Set(out.map(s => s.id)).size !== out.length) failures.push("duplicate ids");
  return { js, failures, sites: out };
}

module.exports = { build_masked, mask_domain, transform_site };
