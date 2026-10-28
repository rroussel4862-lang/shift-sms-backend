# Connecting Veloce (POS)

What this does today: lets you save each restaurant's Veloce login + licence number, test the connection, and read one day's net sales to compare with the POS.
It does NOT write anything into the app's sales yet — that comes after the numbers have been checked.

## One-time setup
1. In Terminal run: `openssl rand -hex 32` — it prints 64 characters. Copy them.
2. In Render > Environment add `POS_SECRET_KEY` = those 64 characters. Save and wait for the deploy.
   - Never put this in chat, git or a screenshot. If it is lost, passwords must be re-entered.

## Per restaurant
1. Platform dashboard > the restaurant's row > **POS…**.
2. Licence number, Veloce login email, Veloce password > **Save** (the password is encrypted and never shown again).
3. **Test connection** — it should say Connected and show the restaurant's name.
4. **Read net sales** — shows yesterday's net sales so you can compare with Veloce's own report. Nothing is saved in the app.

## If a test fails
- "refused the email or password": re-enter the login, or Veloce may need to enable API access for that user.
- "can't see a location with that licence number": the login belongs to a different account/licence.
- "could not reach Veloce" / timeout: try again in a minute.
The Activity log in the dashboard records each test (never the password).
