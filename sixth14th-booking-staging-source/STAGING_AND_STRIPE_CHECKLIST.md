# Staging, Squarespace, And Stripe Checklist

This project should go live in phases. The goal is to prove the booking flow in staging before any live card transaction is possible.

## Current Safety Position

- Local demo mode works without Stripe credentials.
- Stripe Checkout is supported but inactive until a Stripe secret key is set.
- Live Stripe keys are blocked unless `ALLOW_LIVE_STRIPE=true` is explicitly set.
- Pending Stripe payment holds expire after 30 minutes by default.
- Reservations are marked booked by the Stripe webhook, not by the success page.
- Card data is never collected or stored by this app.

## Phase 1: Private Staging

Deploy the app to a staging URL such as:

- `https://book-staging.sixth14th.com`
- or a temporary host URL from the hosting provider

Required staging environment variables:

```bash
PUBLIC_BASE_URL=https://book-staging.sixth14th.com
STRIPE_SECRET_KEY=rk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
LODGIFY_API_KEY=...
PAYMENT_HOLD_MINUTES=30
```

Do not set `ALLOW_LIVE_STRIPE` in staging.

## Phase 2: Stripe Test Mode

Create a Stripe webhook endpoint for staging:

```text
https://book-staging.sixth14th.com/api/stripe/webhook
```

Listen for:

- `checkout.session.completed`

Test cases:

- Successful deposit payment
- Card decline
- 3D Secure/authentication flow
- Guest cancels before paying
- Guest opens checkout but never pays
- Two guests try overlapping dates
- Lodgify-synced blocked dates cannot be quoted
- Balance due calculation is correct
- Admin shows payment state correctly

Acceptance rule: a booking is not considered confirmed until the webhook marks it `booked`.

## Phase 3: Squarespace Staging Link

Add a temporary, private test link on Squarespace first. Do not replace the public Lodgify booking path yet.

Recommended first integration:

```html
<a href="https://book-staging.sixth14th.com" class="sqs-block-button-element--medium sqs-button-element--primary">
  Check availability
</a>
```

Use a button/link first. Avoid an iframe embed until the booking flow is proven, because payments and redirects are more reliable as a full page.

## Phase 4: Parallel Run

Run Lodgify and the custom system in parallel:

- Lodgify remains public.
- Custom staging is used only by you and test users.
- Sync Lodgify availability daily or before each staging test.
- Compare the custom calendar against Lodgify before accepting any test booking.

## Phase 5: Production Cutover

Only after test-mode acceptance:

1. Deploy production app to `https://book.sixth14th.com`.
2. Add production database/storage.
3. Add admin authentication.
4. Add email provider credentials.
5. Add Stripe live webhook endpoint.
6. Replace Stripe test keys with live keys.
7. Set `ALLOW_LIVE_STRIPE=true`.
8. Replace the Lodgify button/link in Squarespace.
9. Keep Lodgify available internally until the first real booking is reconciled.

## Go/No-Go Criteria

Do not go live until all are true:

- Admin page is password protected.
- Data is stored in a hosted database, not local JSON.
- Stripe test payments and webhook confirmations pass.
- Failed/canceled checkout does not create a confirmed booking.
- Overlapping date attempts are rejected.
- Lodgify availability sync is correct for current and future stays.
- Guest confirmation email is correct and logged.
- Balance payment workflow is tested.
- Refund/cancel process is documented.
- You have completed at least one end-to-end test from Squarespace staging link to Stripe test payment to admin confirmation.
