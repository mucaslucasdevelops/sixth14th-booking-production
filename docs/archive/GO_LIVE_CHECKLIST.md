# Sixth 14th Booking Go-Live Checklist

This is the launch checklist for replacing Lodgify booking, calendar, payments, and guest messaging while keeping Squarespace as the public site and Stripe as the payment provider.

## Current status

- Private Render staging is live at `https://sixth14th-booking-staging.onrender.com`.
- Staging is password protected with Render environment variables.
- Stripe sandbox checkout is connected.
- Stripe webhook support is wired through `/api/stripe/webhook`.
- Lodgify pricing, availability rules, and message templates have been copied into `data/settings.json`.
- Lodgify availability sync support exists in Admin and `scripts/import-lodgify-blocks.mjs`.
- Production/live Stripe keys are blocked unless `ALLOW_LIVE_STRIPE=true` is deliberately set.

## Hard go-live gates

Do not install this on the public Squarespace site until every item in this section is complete.

- [ ] Staging regression script passes locally: `npm run test:regression`.
- [ ] Staging health endpoint returns OK: `https://sixth14th-booking-staging.onrender.com/api/health`.
- [ ] Staging admin shows `Stripe: test`.
- [ ] Staging admin shows `Stripe webhook: configured`.
- [ ] A guest booking request appears in Admin as `pending_host_approval`.
- [ ] Host approval creates a Stripe sandbox deposit link.
- [ ] After deposit payment, Admin creates a Stripe sandbox balance link.
- [ ] Host decline releases the requested dates.
- [ ] A Stripe sandbox payment creates a booked reservation in staging admin.
- [ ] A Stripe sandbox balance payment marks the reservation paid-in-full.
- [ ] Stripe sandbox webhook delivery for `checkout.session.completed` shows `200 OK`.
- [ ] A failed Stripe test card does not create a booked reservation.
- [ ] A canceled Stripe checkout leaves only a temporary hold or no confirmed booking.
- [ ] Pending holds show their expiration time in Admin.
- [ ] Pending holds can be canceled from Admin and immediately release the dates.
- [ ] Public booking mode lets guests load the booking page without a password.
- [ ] Admin page and `/api/admin/...` still require a password when public booking mode is enabled.
- [ ] Admin `Sync Lodgify` completes successfully before calendar comparison.
- [ ] A second guest cannot book the same dates after a hold or booking exists.
- [ ] The current in-progress Lodgify stay is blocked in the new calendar.
- [ ] Lodgify future reservations and owner blocks match the staging calendar.
- [ ] The 1-day preparation buffer blocks adjacent nights as expected.
- [ ] Pricing matches Lodgify for weekday, weekend, 7-night, 30-night, cleaning fee, deposit, and balance.
- [ ] Mobile booking flow works on a phone-width screen.
- [ ] Admin page works on desktop and mobile enough for emergency use.
- [ ] No live Stripe keys are present in staging.
- [ ] No guest PII or secret keys are committed to GitHub.

## Payment test matrix

- [ ] Successful deposit: use Stripe sandbox card `4242 4242 4242 4242`.
- [ ] Declined card: use Stripe sandbox card `4000 0000 0000 0002`.
- [ ] Authentication required: use Stripe sandbox card `4000 0025 0000 3155`.
- [ ] Canceled checkout: start checkout, return without paying, verify dates are not permanently booked.
- [ ] Duplicate booking: try the same dates from a fresh browser after a hold is created.
- [ ] Webhook retry: resend a Stripe webhook delivery and confirm the booking stays correct.
- [ ] Amount check: deposit charged equals 50% of total.
- [ ] Statement mode check: all testing remains in Stripe sandbox until final production cutover.

## Calendar and availability test matrix

- [ ] Minimum stay rejects 1-night booking.
- [ ] Maximum stay rejects over-limit booking.
- [ ] Advance notice rejects too-soon arrival.
- [ ] Manual admin block prevents booking.
- [ ] Lodgify synced block prevents booking.
- [ ] Existing booked reservation prevents overlap.
- [ ] Pending payment hold prevents overlap until expiry.
- [ ] Expired payment hold no longer blocks dates.
- [ ] Preparation day before arrival is blocked.
- [ ] Preparation day after departure is blocked.
- [ ] Calendar date colors match actual availability.

## Messaging launch requirements

The current staging app displays message templates, but automated outbound email is not production-ready yet.

- [ ] Choose email provider and sender domain.
- [ ] Add DNS records for the sender domain.
- [ ] Add email provider API key to Render.
- [ ] Send booking confirmation after Stripe deposit is paid.
- [ ] Send balance reminder 7 days before arrival.
- [ ] Send check-in instructions 2 days before arrival.
- [ ] Send welcome message on arrival day.
- [ ] Send checkout reminder on checkout day.
- [ ] Decide whether review request remains disabled.
- [ ] Add owner notification for every new booking.
- [x] Add controlled send queue in admin before relying on automation.
- [x] Add manual compose fallback while the sender domain is unresolved.

## Squarespace cutover plan

- [ ] Keep the existing Lodgify widget/button in place during staging.
- [ ] Add a private Squarespace test page or hidden button that points to staging.
- [ ] Follow [SQUARESPACE_STAGING_INSTALL.md](./SQUARESPACE_STAGING_INSTALL.md) for the hidden page/button setup.
- [ ] Test the link from desktop and mobile.
- [ ] Create production Render service or production environment.
- [ ] Add production Stripe restricted key and live webhook.
- [ ] Run final Lodgify sync in Admin immediately before switching public traffic.
- [ ] Compare Lodgify calendar and new calendar date-by-date for the next 12 months.
- [ ] Replace the Squarespace booking button with the new production booking link.
- [ ] Leave Lodgify account active during the rollback window.

## Rollback plan

If anything behaves incorrectly after launch:

- [ ] Restore the Squarespace Lodgify button/widget.
- [ ] Disable or hide the new booking link.
- [ ] Pause live Stripe webhook endpoint for the custom app.
- [ ] Review Render logs and Stripe events before trying another cutover.
- [ ] Keep a record of any affected guest, date range, Stripe payment, and booking ID.

## Final launch sign-off

- [ ] Marc confirms staging booking flow.
- [ ] Marc confirms Stripe sandbox payments and webhook deliveries.
- [ ] Marc confirms staging calendar matches Lodgify.
- [ ] Marc confirms message cadence wording.
- [ ] Marc confirms Squarespace test page.
- [ ] Live Stripe keys created with least privilege.
- [ ] Production payment test completed with a real low-risk transaction or controlled internal booking.
- [ ] Public Squarespace booking link switched.
