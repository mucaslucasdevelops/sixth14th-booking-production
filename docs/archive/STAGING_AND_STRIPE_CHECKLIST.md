# Staging, Squarespace, And Stripe Checklist

This project should go live in phases. The goal is to prove the booking flow in staging before any live card transaction is possible.

## Current Safety Position

- Local demo mode works without Stripe credentials.
- Guests submit a booking request first; the host approves or declines it in Admin.
- Stripe Checkout is created only after host approval and only when a Stripe secret key is set.
- Live Stripe keys are blocked unless `ALLOW_LIVE_STRIPE=true` is explicitly set.
- Pending Stripe payment holds expire after 30 minutes by default.
- Reservations are marked booked by the Stripe webhook, not by the success page.
- Card data is never collected or stored by this app.
- Guest messages are preview-only until an email provider is connected.
- Deposit-link emails are drafted from `Stay@Sixth14th.com`; automatic sending stays off until DNS/provider verification is complete.

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
LODGIFY_ICAL_URL=...
PAYMENT_HOLD_MINUTES=30
EMAIL_FROM="Stay at Sixth & 14th <Stay@Sixth14th.com>"
EMAIL_REPLY_TO=Stay@Sixth14th.com
EMAIL_SEND_ENABLED=false
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
- Host approval creates a secure deposit link
- Host approval creates a deposit email draft with the secure link
- Admin creates a secure balance payment link after the deposit is paid
- Admin creates a balance email draft with the secure link
- Successful balance payment marks the booking paid-in-full
- Card decline
- 3D Secure/authentication flow
- Guest cancels before paying
- Guest opens checkout but never pays
- Two guests try overlapping dates
- Lodgify-synced blocked dates cannot be quoted
- Balance due calculation is correct
- Admin shows payment state correctly
- Admin previews message cadence for the confirmed booking

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
4. Create or alias `Stay@Sixth14th.com` in the domain email provider.
5. Verify the sending domain by adding SPF/DKIM records in Squarespace DNS.
6. Add email provider credentials and set `EMAIL_SEND_ENABLED=true`.
7. Add Stripe live webhook endpoint.
8. Replace Stripe test keys with live keys.
9. Set `ALLOW_LIVE_STRIPE=true`.
10. Replace the Lodgify button/link in Squarespace.
11. Keep Lodgify available internally until the first real booking is reconciled.

## Message Preview Pass

- Open the staging admin page.
- Confirm the message cadence section lists the expected enabled templates.
- Confirm the message schedule section shows rows for booked test reservations.
- Click **Preview** on each scheduled message type.
- Confirm guest name, property name, dates, and payment placeholders render safely.
- Use **Mark sent** only for staging tests; no real email is sent yet.

## Go/No-Go Criteria

Do not go live until all are true:

- Admin page is password protected.
- Data is stored in a hosted database, not local JSON.
- Stripe test payments and webhook confirmations pass.
- Failed/canceled checkout does not create a confirmed booking.
- Overlapping date attempts are rejected.
- Lodgify availability sync is correct for current and future stays.
- Guest message previews are correct and logged before live sending is enabled.
- `Stay@Sixth14th.com` can receive replies, and automated sender DNS is verified.
- Balance payment workflow is tested.
- Refund/cancel process is documented.
- You have completed at least one end-to-end test from Squarespace staging link to Stripe test payment to admin confirmation.
