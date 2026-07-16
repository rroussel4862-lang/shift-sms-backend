# Shift SMS Backend

Sends a real text to every staff member the moment a manager posts an open
shift, and lets staff claim it by texting back — no app required on the
staff side, just SMS.

## How it works

1. Manager posts a shift → `POST /api/shifts` → only staff whose `role` matches the shift's `role` get a text like:
   > Open shift: Line Cook — 5pm–close. Jordan called out sick. Can cover it? Reply YES 4F2A to claim.
2. A staffer texts back `YES 4F2A` → they're recorded as a responder for that shift.
3. Manager assigns the shift → `POST /api/shifts/:id/assign` → the winner gets a confirmation text, everyone else who replied gets a "covered" text.

## 1. Get a Twilio number

1. Create a free account at [twilio.com](https://www.twilio.com).
2. Buy a phone number with SMS capability (trial accounts get one free number, but can only text *verified* numbers until you upgrade — fine for testing, not for real staff).
3. From the [console dashboard](https://console.twilio.com), copy your **Account SID** and **Auth Token**.

## 2. Run it locally

```bash
npm install
cp .env.example .env
# edit .env and fill in TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
npm start
```

Server runs on `http://localhost:3000`. Try it:

```bash
curl -X POST http://localhost:3000/api/staff \
  -H "Content-Type: application/json" \
  -d '{"name":"Alex Rivera","phone":"+15551234567","role":"Line Cook"}'

curl -X POST http://localhost:3000/api/shifts \
  -H "Content-Type: application/json" \
  -d '{"role":"Line Cook","time":"5pm-close","note":"Jordan called out sick"}'
```

Alex should get a text within a few seconds. Only staff whose `role` matches the shift's `role` get texted — a Server posting won't page your line cooks.

## 3. Deploy it somewhere public

Twilio needs to reach this server over the internet for inbound replies to
work, so it has to be deployed. Any Node host works; **Render** is the
simplest free option:

1. Push this folder to a GitHub repo.
2. On [render.com](https://render.com), New → Web Service → connect the repo.
3. Build command: `npm install`. Start command: `npm start`.
4. Add your `.env` values under Environment.
5. Deploy. Render gives you a URL like `https://your-app.onrender.com`.

(Railway and Fly.io work the same way if you prefer those.)

## 4. Wire up the inbound webhook

In the [Twilio console](https://console.twilio.com) → Phone Numbers → your
number → **Messaging** section → "A message comes in":

- Set it to **Webhook**
- URL: `https://your-app.onrender.com/api/sms/inbound`
- Method: `HTTP POST`

Now staff replies actually get processed instead of just landing in Twilio.

## API reference

| Method | Path | Body | Does |
|---|---|---|---|
| GET | `/api/staff` | — | list staff |
| POST | `/api/staff` | `{name, phone, role}` | add staff, texts must reach this number |
| DELETE | `/api/staff/:id` | — | remove staff |
| GET | `/api/shifts` | — | list shifts |
| POST | `/api/shifts` | `{role, time, note}` | create shift + broadcast SMS |
| POST | `/api/shifts/:id/assign` | `{staffId}` | assign + send confirm/covered texts |
| DELETE | `/api/shifts/:id` | — | remove a shift |
| POST | `/api/sms/inbound` | (Twilio form data) | webhook Twilio calls on incoming texts |

## Connecting this to the Open Shift Rail app

The web app you've been using stores its data in the browser artifact's own
storage, which this standalone server can't read from or write to — they're
two separate systems right now. To make posting a shift in that app trigger
real texts, the app's "post shift" and "assign" actions would need to call
this server's API instead (or in addition). That's a follow-up integration
step — happy to wire it up once this backend is deployed and you have a
public URL.

## Going to production

- **Storage**: shifts/staff are saved to `data.json` on disk. Most hosts (Render's free tier included) wipe local disk on redeploy or restart. Fine for testing; swap in a real database (Postgres, SQLite on a persistent volume, etc.) before relying on this day to day.
- **Webhook security**: the inbound endpoint currently trusts any POST to `/api/sms/inbound`. Before going live, verify requests are actually from Twilio using [`twilio.validateExpressRequest`](https://www.twilio.com/docs/usage/webhooks/webhooks-security) with your auth token.
- **Trial account limits**: a Twilio trial account can only text numbers you've manually verified in the console, and prepends "Sent from a Twilio trial account" to every message. Upgrade to a paid account to text your actual staff.
- **Costs**: each text costs a small amount (roughly $0.0079/segment in the US at time of writing) — check [Twilio's pricing](https://www.twilio.com/en-us/sms/pricing/us) for current rates.
