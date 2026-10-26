#!/usr/bin/env python3
"""Daily renewal reminders for the Apex dashboard.

Reads sites from the dashboard API, and for any domain/hosting renewal
30/15/7/1 days out, emails a reminder (to the client if clientEmail is set,
otherwise to Ryan). State file prevents duplicate sends.

APPROVAL RULE (2026-10-26): nothing client-facing fires without approval.
A reminder sends only when its Upcoming row is approved — on its scheduled
date, or at once on the next run if approved late (using the ACTUAL days
remaining in the subject/body, not the window number). Unapproved rows never
send; cleared rows are recorded as suppressed and never send. After each run
the full state is POSTed to /api/reminders-state so the panel stays true.

Env: DASHBOARD_URL, DASHBOARD_TOKEN
"""
import http.client
import json
import os
import sys
import time
import urllib.request
from datetime import date, datetime

BASE = os.environ.get("DASHBOARD_URL", "").rstrip("/")
TOKEN = os.environ.get("DASHBOARD_TOKEN", "")


def load_local_secrets():
    """Cron runs may not carry env vars; read the local secrets file."""
    global TOKEN
    if TOKEN:
        return
    try:
        here = os.path.dirname(os.path.abspath(__file__))
        for line in open(os.path.join(here, ".secrets.env")):
            line = line.strip()
            if line.startswith("API_TOKEN="):
                TOKEN = line.split("=", 1)[1]
    except Exception:
        pass
STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hidden_files", "reminders-sent.json")
RYAN_EMAIL = "info@helixkinglabs.com"
FROM = "Apex King Digital <updates@helixkinglabs.com>"
WINDOWS = [30, 15, 7, 1]

SEND_SCRIPT = os.path.expanduser("~/workspace/custom-connectors/custom.legacy-resend/bin/send_email.py")

from invoice import process_invoices  # noqa: E402  (local module)



def load_state():
    try:
        return json.load(open(STATE_FILE))
    except Exception:
        return {}


def save_state(state):
    os.makedirs(os.path.dirname(STATE_FILE), exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    json.dump(state, open(tmp, "w"), indent=2)
    os.rename(tmp, STATE_FILE)


def get_sites():
    req = urllib.request.Request(
        BASE + "/api/sites", headers={"Authorization": "Bearer " + TOKEN}
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        try:
            return json.load(r)
        except http.client.IncompleteRead as e:
            # The dashboard's /api/sites response consistently arrives without
            # the final chunk terminator (egress proxy closes the stream);
            # the bytes themselves are complete. Use the partial body.
            return json.loads(e.partial.decode())


def send_email(to, subject, text):
    import subprocess
    p = subprocess.run(
        [sys.executable, SEND_SCRIPT, "--to", to, "--subject", subject,
         "--text", text, "--from", FROM],
        capture_output=True, text=True, timeout=60,
    )
    print(p.stdout.strip() or p.stderr.strip()[-300:])


def get_invoices(site_id):
    """Fresh invoice records for a site (the dashboard refreshes each
    record from Stripe on this read). Retries the dashboard's flaky
    responses; returns None if it stays unreachable."""
    for attempt in range(3):
        try:
            req = urllib.request.Request(
                BASE + "/api/sites/" + site_id + "/invoices",
                headers={"Authorization": "Bearer " + TOKEN},
            )
            with urllib.request.urlopen(req, timeout=30) as r:
                try:
                    return json.load(r)
                except http.client.IncompleteRead as e:
                    return json.loads(e.partial.decode())
        except Exception as e:
            print(f"invoices fetch failed (attempt {attempt + 1}): {type(e).__name__}")
            time.sleep(5)
    return None


def invoice_paid_for(site_id, due):
    """True only when a real (non-test) invoice for this renewal is paid
    in Stripe. None/unreachable fails OPEN (returns False) so a dashboard
    blip never silently drops a reminder — the next run re-checks."""
    invs = get_invoices(site_id)
    if invs is None:
        return False
    return any(
        (not r.get("test")) and r.get("status") == "paid" and r.get("renewalDate") == due
        for r in invs
    )


def get_approvals():
    """Approvals map from the dashboard. Returns (map, ok)."""
    try:
        req = urllib.request.Request(
            BASE + "/api/approvals", headers={"Authorization": "Bearer " + TOKEN}
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            try:
                return json.load(r), True
            except http.client.IncompleteRead as e:
                return json.loads(e.partial.decode()), True
    except Exception as e:
        print(f"approvals fetch failed: {type(e).__name__}: {e}")
        return {}, False


def post_reminders_state(state):
    """Sync the full state to the dashboard so /api/upcoming stays true."""
    try:
        req = urllib.request.Request(
            BASE + "/api/reminders-state",
            data=json.dumps(state).encode(),
            method="POST",
            headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"},
        )
        with urllib.request.urlopen(req, timeout=30) as r:
            json.load(r)
        print("reminders state synced to dashboard")
    except Exception as e:
        print(f"reminders state sync failed (local state file is still the source of truth): {type(e).__name__}: {e}")


def send_reminder(s, kind, label, due, ds, days_actual, key, state, invoiced, today):
    """Send one reminder using the ACTUAL days remaining (not the window
    number) and record it in state."""
    to = s.get("clientEmail") or RYAN_EMAIL
    when = due.strftime("%b %d, %Y")
    subject = f"[Apex] {s['name']} {label} renewal in {days_actual} day{'s' if days_actual != 1 else ''} — {when}"
    inv_key = f"invoice:{s['id']}:{due.year}"
    paid_note = ""
    if days_actual == 30 and inv_key in invoiced:
        paid_note = "A renewal invoice for $100 has been sent from Stripe — pay it at the link in that invoice email before the due date.\n\n"
    text = (
        f"Hi,\n\nThis is a friendly reminder from Apex King Digital.\n\n"
        f"Site: {s['name']} ({s.get('url','')})\n"
        f"{label.capitalize()} renewal due: {when} ({days_actual} day{'s' if days_actual != 1 else ''} from now)\n\n"
        + paid_note
        + ("Please arrange payment for the renewal so there is no interruption.\n\n" if s.get("clientEmail") else "Nudge the client about this renewal.\n\n")
        + "— Apex King Digital\n"
    )
    send_email(to, subject, text)
    state[key] = {"sent": today.isoformat(), "to": to}


def main():
    load_local_secrets()
    if not BASE or not TOKEN:
        print("DASHBOARD_URL / DASHBOARD_TOKEN not set")
        return 1
    sites = get_sites()
    today = date.today()
    state = load_state()
    invoiced = {n["key"] for n in process_invoices(sites, state)}
    approvals, approvals_ok = get_approvals()
    if not approvals_ok:
        print("approvals unavailable — sending NO reminders this run (fail closed: nothing fires without approval)")
    sent = 0
    for s in sites:
        for kind, label in (("domainRenewal", "domain"), ("hostingRenewal", "hosting")):
            ds = s.get(kind)
            if not ds:
                continue
            try:
                due = datetime.strptime(ds, "%Y-%m-%d").date()
            except ValueError:
                continue
            days = (due - today).days
            if days < 0 or days > 30:
                continue
            paid = invoice_paid_for(s["id"], ds)
            for w in WINDOWS:
                if days > w:
                    continue
                key = f"{s['id']}:{kind}:{w}:{ds}"
                if state.get(key):
                    continue
                if paid:
                    print(f"skip paid: {s['name']} {label} due {ds} — invoice already paid in Stripe")
                    state[key] = {"skipped_paid": today.isoformat(), "due": ds}
                    continue
                ap = (approvals.get(key) or {}).get("status")
                if ap == "cleared":
                    to = s.get("clientEmail") or RYAN_EMAIL
                    print(f"skip cleared: {s['name']} {label} {w}d row cleared from Upcoming panel — never sends")
                    state[key] = {"sent": today.isoformat(), "to": to, "suppressed_by_ryan": True,
                                  "note": "Cleared from Upcoming panel — never sends"}
                    continue
                if ap != "approved":
                    print(f"awaiting approval: {s['name']} {label} {w}d reminder (due {ds}) — not approved, not sending")
                    continue
                send_reminder(s, kind, label, due, ds, days, key, state, invoiced, today)
                sent += 1
    save_state(state)
    post_reminders_state(state)
    print(f"reminders sent: {sent}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
