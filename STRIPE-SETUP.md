# Setting up Stripe billing

Nothing changes in the app until you add `STRIPE_SECRET_KEY` on Render. Do this in **test mode** first
(the "Test mode" switch in the Stripe dashboard), then repeat with live keys.

## 1. In the Stripe dashboard
1. **Product**: Product catalogue -> Add product -> "Open Shift Rail" -> price **$100.00 CAD**, **Recurring, Monthly**.
   Set "Tax behaviour" to **Exclusive** (tax is added on top). Copy the price id (`price_...`).
2. **Tax** (pick one):
   - *Manual, simplest*: Product catalogue -> Tax rates -> create **GST 5%** and **QST 9.975%** (both "Exclusive").
     Copy both ids (`txr_...`). Only register for QST/GST numbers you actually hold.
   - *Automatic*: turn on Stripe Tax, add your registrations, then set `STRIPE_AUTOMATIC_TAX=1` instead.
3. **Customer portal** (lets restaurants update their card, see invoices, cancel): Settings -> Billing -> Customer portal -> turn on.
4. **Emails**: Settings -> Customer emails -> turn on "Successful payments" receipts and failed-payment emails.
5. **Retries**: Settings -> Billing -> Subscriptions and emails -> set what happens when all retries fail to *Cancel the subscription*.
6. **Webhook**: Developers -> Webhooks -> Add endpoint -> `https://www.openshiftrail.com/api/stripe/webhook`.
   Events to send: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. Copy the signing secret (`whsec_...`).
7. **API key**: Developers -> API keys -> copy the secret key (`sk_test_...` while testing).

## 2. On Render (Environment)
`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`, and either `STRIPE_TAX_RATE_IDS` (comma-separated)
or `STRIPE_AUTOMATIC_TAX=1`. Make sure `PUBLIC_URL` is `https://www.openshiftrail.com`. Never put these in git.

## 3. Test it (test mode)
Sign up a throwaway restaurant on the site, pay with card `4242 4242 4242 4242` (any future date, any CVC).
You should land back in the app within a few seconds. Then check in Stripe that the subscription and the webhook delivery succeeded.
A declined card to try: `4000 0000 0000 0341` (attaches, then fails on the first charge).

## 4. Existing restaurants
Every restaurant that existed before billing is **Exempt** (never charged, never held). In the platform dashboard, the
**Billing** column lets you set a restaurant to *Exempt* or *Free until a date*. With "Free until", the restaurant sees a
bar 14 days before the date asking for a card; if it adds one, Stripe takes the first payment on that date. After the
date, a restaurant without a card is held at the payment screen.

## 5. Going live
Repeat steps 1-2 with live mode (new product/price, tax rates, webhook, keys), update the Render variables, redeploy.
To switch billing off again, remove `STRIPE_SECRET_KEY`; new sign-ups then open straight away, as before.
