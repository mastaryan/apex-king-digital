#!/usr/bin/env python3
"""Daily renewal reminders for the Apex dashboard.

Reads sites from the dashboard API, and for any domain/hosting renewal
30/15/7/1 days out, emails a reminder (to the client if clientEmail is set,
otherwise to Ryan). State file prevents duplicate sends.

Env: DASHBOARD_URL, DASHBOARD_TOKEN
"""
import json
import os
import sys
import urllib.request
from datetime import date, datetime

BASE = os.environ.get("DASHBOARD_URL", "").rstrip("/")
TOKEN = os.environ.get("DASHBOARD_TOKEN", "")
STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hidden_files", "reminders-sent.json")
RYAN_EMAIL = "info@helixkinglabs.com"
FROM = "Apex King Digital <updates@helixkinglabs.com>"
WINDOWS = [30, 15, 7, 1]

SEND_SCRIPT = os.path.expanduser("~/workspace/custom-connectors/custom.legacy-resend/bin/send_email.py")


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
        return json.load(r)


def send_email(to, subject, text):
    import subprocess
    p = subprocess.run(
        [sys.executable, SEND_SCRIPT, "--to", to, "--subject", subject,
         "--text", text, "--from", FROM],
        capture_output=True, text=True, timeout=60,
    )
    print(p.stdout.strip() or p.stderr.strip()[-300:])


def main():
    if not BASE or not TOKEN:
        print("DASHBOARD_URL / DASHBOARD_TOKEN not set")
        return 1
    sites = get_sites()
    today = date.today()
    state = load_state()
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
            if days not in WINDOWS:
                continue
            key = f"{s['id']}:{kind}:{days}:{ds}"
            if state.get(key):
                continue
            to = s.get("clientEmail") or RYAN_EMAIL
            when = due.strftime("%b %d, %Y")
            subject = f"[Apex] {s['name']} {label} renewal in {days} day{'s' if days != 1 else ''} — {when}"
            text = (
                f"Hi,\n\nThis is a friendly reminder from Apex King Digital.\n\n"
                f"Site: {s['name']} ({s.get('url','')})\n"
                f"{label.capitalize()} renewal due: {when} ({days} day{'s' if days != 1 else ''} from now)\n\n"
                + ("Please arrange payment for the renewal so there is no interruption.\n\n" if s.get("clientEmail") else "Nudge the client about this renewal.\n\n")
                + "— Apex King Digital\n"
            )
            send_email(to, subject, text)
            state[key] = {"sent": today.isoformat(), "to": to}
            sent += 1
    save_state(state)
    print(f"reminders sent: {sent}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
