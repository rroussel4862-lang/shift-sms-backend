# Open Shift Rail — Security & Recovery Notes

Plain-language notes for whoever looks after the system (you today, an IT person later). Keep this file up to date.
It never contains passwords or secret values — only *where* things live and *what to do*.

---

## 1. What runs where

| Piece | Where | What it holds / does | Who can log in |
|---|---|---|---|
| Code | GitHub (`shift-sms-backend`) | The app's source | you (+ future IT person) |
| App server | Render | Runs the website and API; redeploys when you push to GitHub | you |
| Database | Neon (Postgres) | **All customer data**: restaurants, staff, schedules, sales, hours | you |
| Texting | Twilio | Sends/receives the SMS | you |
| AI | Anthropic API | The AI scheduler / agent | you |
| Domain / DNS | (your registrar) | openshiftrail.com | you |

**Write down (somewhere safe, not in the repo):** who owns each account, which email it uses, and where the two-step codes go.
If only one person can get into an account, that person is a single point of failure — add a second trusted admin where the service allows it.

## 2. Settings the server needs (names only)

Set in Render → the service → **Environment**. Never put values in GitHub.

| Name | Purpose | Notes |
|---|---|---|
| `DATABASE_URL` | Connection to Neon | Secret. Rotate by changing the Neon password, then updating here. |
| `JWT_SECRET` | Signs login sessions | Secret. **At least 32 random characters.** Changing it logs everyone out (useful after an incident). |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER` | Texting | The auth token is secret. It is also what proves a reply really came from Twilio. |
| `PUBLIC_URL` | The site's address, e.g. `https://openshiftrail.com` | Needed so incoming-text checks and login links use the right address. |
| `ANTHROPIC_API_KEY` | AI features | Secret. Set a monthly spend limit in the Anthropic console. |
| `PLATFORM_SETUP_KEY` | Lets someone create a platform-admin account | **Remove it from Render once your admin accounts exist.** Without it nobody can create one. Add it back only when you need to create another. |
| `ALLOWED_ORIGINS` | Other websites allowed to call the API | **Leave unset.** The app and API share one address, so none are needed. |
| `SMS_DAILY_CAP` | Max texts per restaurant per 24 h | Optional, default 300. Raise it when a restaurant legitimately needs more. |
| `TWILIO_VALIDATE_SIGNATURE` | Emergency switch | Leave unset. Setting it to `false` turns the incoming-text check off (see section 6). |

## 3. Backups

**What can go wrong:** a bad change wipes data, someone deletes things by mistake, the database provider has an outage, an attacker damages data.

1. **Neon's own history.** In Neon → your project → *Backup & restore* (wording may differ), check how far back you can restore on your plan, and note it here: `________`.
   This is the fastest way to undo a recent mistake. It is *not* a copy outside Neon.
2. **Your own copy, outside Neon (do this weekly until automated).** From your Mac, with the connection string kept in an environment variable (do not paste it into chat, files or commands you share):

   ```
   pg_dump "$DATABASE_URL" -Fc -f osr-backup-$(date +%F).dump
   ```

   Keep the file somewhere private and encrypted (not in the repo, not in a shared folder). Keep a few weeks of them.
   It contains customer data — treat it like the database itself.
3. **Practise a restore once** (this is the step people skip, and a backup you have never restored is only a hope):
   create a *separate, empty* Neon project, run `pg_restore` into it, point a local copy of the app at it, and check that you can log in and see data.
   Write the date you did it here: `________`.
4. **Later (IT person):** automate step 2 on a schedule to storage in a different provider, encrypted, with an alert if a backup fails.

## 4. Watching for trouble

- **Uptime alert (free, 10 minutes to set up):** create a monitor (for example UptimeRobot or Better Stack) that checks `https://openshiftrail.com/api/health` every 5 minutes and emails/texts you if it fails.
- **Platform dashboard:** look daily at *errors* and *failed texts*. Every unexpected error now has a code like `E-7K3F9A`; search the activity log for the code.
- **Warning signs in the activity log:** many `login_failed` for one account, `sms_inbound_rejected` (someone posting fake replies), `sms_blocked` (a restaurant hit its daily text cap), `platform_login_failed`.
- **Run `npm audit`** in the project every month and update packages that have fixes. Do it on a branch, run `npm test`, then deploy.

## 5. Weekly 10-minute check

1. Platform dashboard: any new errors? Any failed texts? Any `sms_blocked`?
2. Uptime monitor: any downtime this week?
3. Make the weekly backup copy (section 3, step 2).
4. Ask the managers if anything felt slow, wrong or confusing.

## 6. If something breaks

**The site is down or acting strangely**
1. Render → the service → *Events/Logs*. Is a deploy failing? If a recent push caused it: Render → *Deploys* → pick the last good one → **Rollback**.
2. Still down: check Neon (is the database up? did it run out of connections or storage?) and Render's status page.

**Staff replies to open-shift texts stopped working** (they text "YES 4F2A" and nothing happens)
- The incoming-text check compares Twilio's signature to your site address. In Twilio the webhook must be exactly `PUBLIC_URL` + `/api/sms/inbound` (for example `https://openshiftrail.com/api/sms/inbound`), method POST.
- Look for `sms_inbound_rejected` in the activity log. If real replies are being rejected and you can't fix the address quickly, set `TWILIO_VALIDATE_SIGNATURE=false` in Render as a **temporary** measure, fix the address, then remove that setting.

**Texts aren't going out**
- Look for `sms_failed` (Twilio refused or is down — the message says why) and `sms_blocked` (daily cap reached).
- Staff can still see their schedule in the portal; managers can phone people for urgent shifts until texting is back.

**You think someone got in (suspicious logins, data changed, a lost laptop/phone)**
1. Change `JWT_SECRET` in Render (this logs everyone out).
2. Change the Neon password and update `DATABASE_URL`; rotate the Twilio auth token and the Anthropic key; change passwords of the affected accounts.
3. Look through the activity log for what happened and when. Save a copy (CSV download) before anything is cleaned up.
4. Write down: what happened, what data may be involved, when you found out, what you did.
5. **Legal:** Quebec's privacy law (Law 25) has rules about recording and reporting "confidentiality incidents" and notifying the people affected. Talk to your lawyer *before* you need to, so you know the steps and the deadlines.

## 7. What is already protected (so you know what you have)

- Passwords are stored hashed, never as text. Login sessions last 30 days and travel in secure cookies.
- Login guessing is slowed per address **and** per account.
- Every restaurant's data is separated by restaurant in every query (and covered by automated tests).
- Incoming Twilio texts are checked to really come from Twilio.
- Other websites cannot call the API from a visitor's browser; pages can't be shown inside other sites' frames; standard security headers are on every response.
- Texts are capped per restaurant per day; setup links expire after 14 days.
- Unexpected errors don't leak internals; they show a reference code and are logged.
- Uploaded files are limited to an allow-list of types and are always downloaded, never displayed from our address.

## 8. Not done yet (in priority order)

1. **Independent security test** by a professional before the second paying client.
2. **Two-step login** (authenticator app) for platform-admin and owner/manager accounts — the platform dashboard can see every restaurant, so it needs the strongest protection.
3. **Sign out everywhere / revoke sessions** (today a stolen login stays valid until it expires or `JWT_SECRET` changes).
4. **Automated, monitored backups** to a second provider.
5. Limit what a manager can do versus an owner (roles and permissions), and an audit trail of who changed what.
6. Review the AI features for what customer data is sent to the AI provider (waiting on your decision after the client meeting).
7. Written privacy policy, terms and incident-response plan from your lawyer.
