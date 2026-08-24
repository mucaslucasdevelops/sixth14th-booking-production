# Sixth 14th Booking Prototype

This is the first local replacement slice for Lodgify: a booking page, quote calculator, reservation hold workflow, admin view, and Stripe-ready payment hooks.

## Run locally

```bash
node server.mjs
```

Then open:

- Booking page: `http://localhost:4173`
- Admin page: `http://localhost:4173/admin.html`

No package install is required.

## Import existing Lodgify bookings

To block the new calendar using upcoming Lodgify reservations, run:

```bash
export LODGIFY_API_KEY=...
node scripts/import-lodgify-blocks.mjs
```

The import stores redacted booking blocks only. It does not copy guest names, emails, or phone numbers.
It also syncs Lodgify's availability calendar for the next 12 months, which catches in-progress stays and prep days that Lodgify may not return in the upcoming-reservations list.

## Current behavior

- Enforces the Lodgify-derived rules: 2-night minimum, 1-day preparation buffer, 2-day advance notice, all-day check-in/check-out availability.
- Calculates nightly, weekly, monthly, cleaning fee, deposit, and balance totals.
- Creates local demo holds when Stripe is not configured.
- Uses `data/reservations.json` for local storage.
- Shows reservations and manual date blocks in the admin page.
- Keeps operational secrets out of the checked-in settings.

## Stripe test mode

Copy `.env.example` to `.env` and export the values into your shell before starting the server:

```bash
export STRIPE_SECRET_KEY=rk_test_...
export STRIPE_WEBHOOK_SECRET=whsec_...
export PUBLIC_BASE_URL=http://localhost:4173
node server.mjs
```

When `STRIPE_SECRET_KEY` is present, the booking form creates a Stripe Checkout Session for the 50% deposit. The `/api/stripe/webhook` endpoint marks the reservation booked after `checkout.session.completed`.

Live Stripe keys are blocked by default. To use live mode after staging approval, set `ALLOW_LIVE_STRIPE=true` along with the live key.

See [STAGING_AND_STRIPE_CHECKLIST.md](./STAGING_AND_STRIPE_CHECKLIST.md) before connecting this to the public Squarespace site.

For private staging deployment, see [PRIVATE_STAGING_DEPLOYMENT.md](./PRIVATE_STAGING_DEPLOYMENT.md).

## Next build steps

1. Import existing Lodgify reservations as unavailable blocks.
2. Add authentication to the admin page.
3. Add editable rates, rules, and message templates.
4. Add scheduled transactional email sending.
5. Move storage from local JSON to a hosted database.
6. Deploy to a hosted URL and replace the Lodgify button/link in Squarespace.
