// Apex dashboard — Fix guide draft generator (Phase 2 money flows).
// Builds a first-draft fix guide from an audit's own findings: one section
// per finding, each with concrete fix steps matched to the finding's theme.
// The draft is a STARTING POINT — Ryan reviews and edits it in the
// dashboard before it is ever marked ready or sent. Guide text is never
// auto-sent. Platform is detected from the findings/trackers where the
// audit names one; otherwise it says so and the steps name the platform
// variants (Shopify / WordPress / custom).
//
// Effort notes come from the 55-audit analysis (2026-10-27): banner +
// gating the stack is 1–3h on Shopify/WooCommerce, 3–6h on a custom build;
// single-issue fixes (hardcoded grant, prechecked box, enhanced
// conversions, policy wording) are 30–60 min each once access is had.
"use strict";

// Theme matchers, most specific first. Each theme: title + fix steps.
// Steps are written for the person doing the fix (the site owner or us).
const THEMES = [
  {
    name: "server-side relay",
    test: (t) => /railway|server-side relay|first-party prox|CAPI mirror|__lmLead|bridge domain|cloak -> bridge|mirrors every event|mirrored server-side/i.test(t),
    title: "Tear down the server-side tracking relay",
    steps: [
      "This is not a settings tweak — the site routes tracking through a first-party server relay that mirrors events to Meta, TikTok, Whop and Google server-side, past ad blockers and past consent. Decide first whether that architecture stays: keeping it means consent can never be honestly enforced.",
      "Remove the relay endpoints and the __lmLead fan-out from the backend (the Railway proxy and any /api/meta/event-style forwarders). Point the site at the platforms' normal browser pixels instead.",
      "Retire the bridge/cloak domains — they exist only to feed the relay. Redirect them to the real store or let them lapse.",
      "Once the relay is gone, work through the banner + gating steps below for the normal pixels. Expect this to be the biggest job in this guide — budget a half day or more, and quote it case by case, not from a menu.",
    ],
    effort: "Half a day or more — quote case by case (teardown, not a routine fix).",
  },
  {
    name: "no consent banner",
    test: (t) => /no (cookie\/)?consent banner|no banner|no cookie consent|no consent banner exists|no consent choice|no user-facing consent control/i.test(t),
    title: "Install a consent banner and gate everything behind it",
    steps: [
      "Pick a consent tool that fits the stack. Shopify: the Customer Privacy API with a consent app (or Shopify's built-in privacy settings). WordPress/WooCommerce: CookieYes or Complianz. Custom site: CookieYes, OneTrust, or a small custom banner wired to consent state.",
      "Set consent defaults to DENIED for every category (analytics, advertising, functional, personalization) in every region before the visitor chooses. No category may default to granted.",
      "Give the visitor a real choice: Accept and Decline buttons at minimum, plus a preferences view if the tool offers one. Decline must actually stop tracking — test it in a fresh browser session and watch the network tab: no pixel requests before Accept.",
      "Wire the banner into the checkout too, not just the storefront — consent given (or refused) on the shop must carry through to cart and checkout.",
      "Do not ship the banner and call it done: load the site with tracking blocked, accept, then decline in a fresh session, and confirm each pixel only fires after Accept.",
    ],
    effort: "1–3 hours on Shopify/WooCommerce; 3–6 hours on a custom build.",
  },
  {
    name: "hardcoded consent",
    test: (t) => /marketingConsent|hardcoded|unconditionally returns|can never say no|advertisingConsent|consent.*grant.*hardcod|resolves consent to tracked/i.test(t),
    title: "Remove the hardcoded consent grant",
    steps: [
      "Find the hardcoded grant in the code (search the checkout bundle / theme for marketingConsent, advertisingConsent, fbq('consent', 'grant') or the consent-state function that returns 'granted' without reading any visitor input).",
      "Delete the hardcode. Consent must come from one place only: the visitor's actual choice in the banner (or a real opt-in checkbox at checkout).",
      "If the site uses Shopify's consent-tracking API, let it resolve from the stored consent record — when no record exists, the answer is 'not tracked', never 'tracked'.",
      "Verify in a fresh browser session: with no choice made, the checkout must not submit marketing consent as true, and no pixel may fire with a granted consent signal.",
    ],
    effort: "30–60 minutes once access is had — the hard part is finding it, not fixing it.",
  },
  {
    name: "prechecked consent",
    test: (t) => /prechecked|pre-checked|checked by default|checked by default/i.test(t),
    title: "Uncheck the consent boxes — prechecked marketing consent is a TCPA risk",
    steps: [
      "Uncheck every marketing opt-in at checkout (email and SMS). Both must start UNCHECKED; the customer opts in by ticking the box.",
      "SMS is the urgent one: marketing texts need prior express WRITTEN consent, and a prechecked box does not provide it. Uncheck the SMS box first, before anything else in this guide.",
      "Make sure the unchecked state actually flows through: place a test order leaving the boxes unchecked and confirm no marketing consent is recorded and no welcome SMS/email series starts.",
      "If the checkout is a third-party app or theme section, the checkbox may be a theme setting rather than code — check the theme/customizer first before digging into the bundle.",
    ],
    effort: "30–60 minutes (often a theme setting, not code).",
  },
  {
    name: "enhanced conversions / PII",
    test: (t) => /enhanced conversions|auto-collect|raw IP|stores the visitor's.*IP|personal data from form/i.test(t),
    title: "Stop auto-collecting personal data",
    steps: [
      "In GA4, turn OFF Enhanced Conversions auto-detection (or remove the enhanced-conversions configuration entirely) so email, phone and address are never scraped from form fields.",
      "Remove any custom code that stores the visitor's raw IP address (or any identifier) in a cookie or localStorage. IPs are personal data — they do not belong in client-side storage.",
      "If hashed first-party data is genuinely needed for measurement, collect it only after consent, hash it at collection time, and document what is collected and why.",
      "Re-check the network tab after the change: no form-field values and no raw IPs should leave the browser before consent.",
    ],
    effort: "30–60 minutes.",
  },
  {
    name: "pre-consent firing",
    test: (t) => /pre-consent|before consent|without consent|no consent gate|no consent check|ungated|fires on every page|fires on first load|loads pre-consent|loads immediately|no consent-mode|defaults to granted/i.test(t),
    title: "Gate the pixel behind consent",
    steps: [
      "Set consent-mode defaults to denied for ad_storage, analytics_storage, ad_user_data and ad_personalization before any tag loads — this is the single change that stops the pre-consent firing.",
      "Load each pixel (Meta, TikTok, GA4, GTM, Clarity, Snapchat, Reddit, X) only after consent, or gate it through Google Tag Manager's built-in consent checks. A pixel that loads 'just in case' is still firing.",
      "Check for pixels loaded by apps, themes or third-party scripts that bypass your tag manager — search the rendered page for fbq, ttq, gtag and snaptr calls and trace each one to its loader.",
      "Verify per platform in a fresh session: decline (or make no choice) and confirm zero pixel requests; accept and confirm each fires exactly once.",
    ],
    effort: "1–3 hours on Shopify/WooCommerce with GTM; 3–6 hours on a custom build with hardcoded pixels.",
  },
  {
    name: "policy mismatch",
    test: (t) => /privacy policy|policy claims|policy promises|policy says|policy tells/i.test(t),
    title: "Make the privacy policy match reality",
    steps: [
      "Rewrite the policy lines that contradict the site: name every tracker that actually loads (Meta, TikTok, GA4, etc.), say what each collects, and remove any claim the site does not live up to ('no third-party trackers', 'banner lets you manage preferences' when no banner exists).",
      "If the policy promises a cookie banner or a preferences tool, either build that tool (see the banner steps above) or remove the promise — a promise to a tool that does not exist is worse than silence.",
      "Keep the policy short and specific to this site. A copied template that names tools the site never installed is how these contradictions happen.",
      "Have the site owner read the rewritten policy before it goes live — they are the one it speaks for.",
    ],
    effort: "30–60 minutes of copy work, plus the owner's read-through.",
  },
  {
    name: "duplicate tags",
    test: (t) => /duplicate|two .* IDs|leftover|consolidate to one/i.test(t),
    title: "Consolidate duplicate tags",
    steps: [
      "List every ID installed per platform (check GTM, the theme, apps and hardcoded snippets — duplicates usually come from two of those at once).",
      "Keep one ID per platform and remove the others from every loader, then confirm in the network tab that each platform fires once per page, not twice.",
      "If the extra ID belonged to an old ad account, remove it from that account's side too so it cannot be re-added by an app sync.",
    ],
    effort: "30–60 minutes.",
  },
];

function fallbackTheme() {
  return {
    title: "Gate the tracker behind consent and verify",
    steps: [
      "Confirm the tracker only loads after the visitor accepts the relevant consent category, and that declining (or making no choice) keeps it unloaded.",
      "Trace the tracker to its loader (theme, app, tag manager or hardcoded snippet) and move the consent check to that loader — fixing the symptom in one place while another loader fires it achieves nothing.",
      "Verify in a fresh browser session with the network tab open: no requests to the platform before Accept, exactly one set of requests after.",
    ],
    effort: "30–60 minutes to a few hours, depending on how the tracker is loaded.",
  };
}

function detectPlatform(audit) {
  const hay = JSON.stringify(audit).toLowerCase();
  if (hay.includes("shopify")) return "Shopify";
  if (hay.includes("woocommerce") || hay.includes("wordpress") || hay.includes("jetpack")) return "WordPress / WooCommerce";
  if (/\bwix\b/.test(hay)) return "Wix";
  if (hay.includes("squarespace")) return "Squarespace";
  if (hay.includes("next.js") || hay.includes("vite") || hay.includes("react spa") || hay.includes("supabase")) return "Custom (JS app)";
  return "Unknown — confirm with the site owner";
}

function themeFor(text) {
  for (const th of THEMES) if (th.test(text)) return th;
  return fallbackTheme();
}

// Build a first-draft guide from an audit record (the shape returned by
// db/audits getAudit: domain, maskedDomain, date, score, label, counts,
// issues[{severity, text}], trackers[{name, status}]).
function buildGuideDraft(audit) {
  const platform = detectPlatform(audit);
  const issues = (audit.issues || []).filter(i => i.severity === "critical" || i.severity === "warning");
  const lines = [];
  lines.push("# Tracking Fix Guide — " + (audit.maskedDomain || audit.domain));
  lines.push("");
  lines.push("Score " + (audit.score === null ? "— (limited audit)" : audit.score + "/100 (" + audit.label + ")") +
    " · audited " + (audit.date || "—") + " · platform: " + platform + ".");
  lines.push("");
  lines.push("This guide fixes every finding in the audit, one by one. The steps are written for the person doing the work — the site owner, or us. Work through them in order: the banner and gating steps come first because most of the other findings are consequences of them.");
  lines.push("");
  if (!issues.length) {
    lines.push("No critical or warning findings — nothing to fix. If the score still bothers you, the info notes in the full report are the remaining polish.");
  }
  issues.forEach((iss, i) => {
    const th = themeFor(iss.text);
    lines.push("## " + (i + 1) + ". [" + iss.severity + "] " + th.title);
    lines.push("");
    lines.push("Finding (verbatim from the audit): " + iss.text);
    lines.push("");
    lines.push("How to fix it:");
    th.steps.forEach((s, j) => lines.push((j + 1) + ". " + s));
    lines.push("");
    lines.push("Typical time: " + th.effort);
    lines.push("");
  });
  lines.push("---");
  lines.push("");
  lines.push("Want us to do it? Done-for-you fixes are $100/hour, $200 minimum, estimate first — email hello@apexkingdigital.com with this report and we will scope it from the platform and access above. Railway-network sites (server-side relays) are quoted case by case.");
  lines.push("");
  lines.push("— Apex King Digital · Tracking Health Score");
  return { platform, body: lines.join("\n") };
}

module.exports = { buildGuideDraft, detectPlatform, themeFor };
