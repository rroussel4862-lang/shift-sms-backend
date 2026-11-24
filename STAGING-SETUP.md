# Staging site: a private test copy of Open Shift Rail

Staging is a second copy of the app with its own empty database. A change goes there first, you look at it on screen, and only then do you merge it to `main` (the real site).

How it works day to day:
1. Claude pushes a change to a branch and opens a pull request.
2. Claude also copies that branch onto the `staging` branch. Render redeploys the staging site in a minute or two.
3. You look at it at the staging address, with fake data.
4. If it is good, you merge the pull request. Render deploys the real site.

The staging copy is safe by design:
- It has its **own empty database**. It never touches the real one.
- `SMS_DISABLED=true`: no text message is ever sent, whoever's number is in the data.
- `STAGING=true`: an orange bar at the top says STAGING.
- Stripe test keys only, so no real card is ever charged.

## One-time setup (about 20 minutes)

### 1. A new, empty database (Neon)
1. In Neon, click **New project**. Name it `osr-staging`. Same region as the real one.
2. Do NOT copy or branch the real database. Staging must start empty with fake data.
3. Copy the connection string. It goes into Render in step 2 (never into chat or git).

### 2. A new web service (Render)
1. **New → Web Service**, pick the same GitHub repo, set **Branch** to `staging`.
2. Same build and start commands as the real service (`npm install` / `npm start`).
3. Name it `osr-staging`. Under **Settings**, you can switch **Auto-Deploy** on (it should be on).
4. Add these environment variables:

| Name | Value |
|---|---|
| `DATABASE_URL` | the new Neon connection string from step 1 |
| `JWT_SECRET` | a NEW long random string (not the real one) |
| `STAGING` | `true` |
| `SMS_DISABLED` | `true` |
| `TWILIO_ACCOUNT_SID` | `ACstaging` (a placeholder; no text is ever sent) |
| `TWILIO_AUTH_TOKEN` | `staging` |
| `TWILIO_PHONE_NUMBER` | `+15145550000` |
| `PLATFORM_SETUP_KEY` | a NEW random string, used once to create your staging admin |
| `COOKIE_SECURE` | `true` |
| `PUBLIC_URL` | the staging address Render gives you (https://osr-staging.onrender.com or similar) |
| `ALLOWED_ORIGINS` | the same staging address |
| `STRIPE_SECRET_KEY` | optional: your Stripe TEST-mode key (starts with `sk_test_`), only if you want to try billing |

Do NOT add: the real Twilio keys, the real Stripe key, `POS_SECRET_KEY`, Veloce credentials, or the Anthropic key (leave it out and the AI features simply show "not configured").

### 3. First look
1. Open the staging address. It should show the orange STAGING bar.
2. Go to `/platform-dashboard.html`, sign up with the `PLATFORM_SETUP_KEY`, and create a test property and restaurant with made-up staff.
3. Never type real staff phone numbers or real customer data into staging.

## If something goes wrong
- The staging site sleeping or slow on its first visit is normal on cheaper Render plans.
- If the bar does not show, the `STAGING` variable is missing or not exactly `true`.
- Staging can be wiped any time: delete the Neon project and create a new one.
