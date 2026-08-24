# Sixth 14th Booking Prototype

This is the first local replacement slice for Lodgify: a booking page, quote calculator, host-approved reservation workflow, admin view, and Stripe-ready payment hooks.

## Run locally

```bash
node server.mjs
```

Then open:

- Booking page: `http://localhost:4173`
- Admin page: `http://localhost:4173/admin.html`

No package install is required.
If you want to run against Postgres locally, run `npm install` first and set `DATABASE_URL`.

## Import existing Lodgify bookings

To block the new calendar using upcoming Lodgify reservations, run:

```bash
export LODGIFY_API_KEY=...
# Optional fallback when the API cannot read reservations:
export LODGIFY_ICAL_URL=...
node scripts/import-lodgify-blocks.mjs
```

The import stores redacted booking blocks only. It does not copy guest names, emails, or phone numbers.
It also syncs Lodgify's availability calendar for the next 12 months, which catches in-progress stays and prep days that Lodgify may not return in the upcoming-reservations list.
If Lodgify returns `403` for booking records, add the Lodgify calendar export/iCal URL as `LODGIFY_ICAL_URL` and the sync can still block unavailable dates.
The sync is one-way only: it imports future Lodgify blocks into the new calendar and never writes anything back to Lodgify.

## Current behavior

- Enforces the Lodgify-derived rules: 2-night minimum, 1-day preparation buffer, 2-day advance notice, all-day check-in/check-out availability.
- Calculates nightly, weekly, monthly, cleaning fee, deposit, and balance totals.
- Creates booking requests first; the host approves or declines them from Admin.
- Creates Stripe deposit links only after host approval.
- Prepares a deposit-link email from `Stay@Sixth14th.com` after host approval.
- Creates Stripe balance links from Admin after the deposit has secured the booking.
- Prepares a balance-payment email draft from `Stay@Sixth14th.com`.
- Uses `data/reservations.json` for local storage, or Postgres when `DATABASE_URL` is set.
- Shows reservations and manual date blocks in the admin page.
- Generates a preview-only guest message schedule from the Lodgify-style templates.
- Lets staging admins preview message copy and manually mark messages as sent.
- Keeps operational secrets out of the checked-in settings.
- Can expose only the guest booking page while keeping Admin and admin APIs password protected.

## Stripe test mode

Copy `.env.example` to `.env` and export the values into your shell before starting the server:

```bash
export STRIPE_SECRET_KEY=rk_test_...
export STRIPE_WEBHOOK_SECRET=whsec_...
export PUBLIC_BASE_URL=http://localhost:4173
node server.mjs
```

When `STRIPE_SECRET_KEY` is present, approving a booking request in Admin creates a Stripe Checkout Session for the 50% deposit. After the deposit is paid, Admin can create a second Stripe Checkout Session for the remaining balance. The `/api/stripe/webhook` endpoint marks the reservation booked after the deposit is paid and paid-in-full after the balance is paid.

Live Stripe keys are blocked by default. To use live mode after staging approval, set `ALLOW_LIVE_STRIPE=true` along with the live key.

See [STAGING_AND_STRIPE_CHECKLIST.md](./STAGING_AND_STRIPE_CHECKLIST.md) before connecting this to the public Squarespace site.

For private staging deployment, see [PRIVATE_STAGING_DEPLOYMENT.md](./PRIVATE_STAGING_DEPLOYMENT.md).

## Public booking, private admin

By default, setting `STAGING_PASSWORD` protects the whole app. When you are ready to test the guest flow from Squarespace or share the booking page, set:

```bash
PUBLIC_BOOKING_ENABLED=true
```

With that flag enabled, guests can open the booking page, calculate quotes, and submit booking requests without a password. Admin pages, admin scripts, and every `/api/admin/...` endpoint still require the staging username and password.

## Database storage

Set `DATABASE_URL` to move reservation holds, booked reservations, manual blocks, and Lodgify availability blocks into Postgres.

The app stores the booking state in Postgres and uses a database row lock while creating or updating reservations, so two guests cannot grab the same dates at the same time. If `DATABASE_URL` is not set, the app keeps using the local JSON file for development.

## Guest email

The intended guest-facing sender is:

```text
Stay at Sixth & 14th <Stay@Sixth14th.com>
```

For staging, leave `EMAIL_SEND_ENABLED=false`. The app will create deposit and balance email drafts and show **Compose email** links in Admin, but it will not send automatically. The Message schedule section can also check due guest messages, but it will leave them queued until sending is configured.
While the sender domain is being sorted out, Admin can run in manual email mode: preview a scheduled guest message, open **Compose email**, send it from the current mailbox, then mark the message sent.

For production transactional sending from Gmail, use the Gmail API with an OAuth refresh token for the `stay@sixth14th.com` mailbox. Store all OAuth values as Render environment variables:

```bash
EMAIL_FROM="Stay at Sixth & 14th <stay@sixth14th.com>"
EMAIL_REPLY_TO=stay@sixth14th.com
EMAIL_SEND_ENABLED=true
GMAIL_OAUTH_CLIENT_ID=...
GMAIL_OAUTH_CLIENT_SECRET=...
GMAIL_OAUTH_REFRESH_TOKEN=...
GMAIL_OAUTH_USER=stay@sixth14th.com
GOOGLE_CALENDAR_SYNC_ENABLED=true
GOOGLE_CALENDAR_ID=primary
GOOGLE_CALENDAR_ATTENDEE=stay@sixth14th.com
CRON_SECRET=choose-a-long-random-secret
OWNER_NOTIFY_ENABLED=true
OWNER_NOTIFY_EMAIL=marc@lucasand.co
```

The Google OAuth client must be allowed to send mail and manage booking calendar events for `stay@sixth14th.com` with these scopes:

```text
https://www.googleapis.com/auth/gmail.send
https://www.googleapis.com/auth/calendar.events
```

When Gmail OAuth variables are present, Gmail is used before Resend or SMTP. When Calendar sync is enabled, booked reservations create or update Google Calendar events and invite `GOOGLE_CALENDAR_ATTENDEE`.

While `sixth14th.com` email is being sorted out, use a working Google Workspace sender such as `stay@lucasand.co`. In Google Workspace, create the mailbox or alias, enable SMTP/app-password access for that sender, then add these Render environment variables:

```bash
EMAIL_FROM="Stay at Sixth & 14th <stay@lucasand.co>"
EMAIL_REPLY_TO=stay@lucasand.co
EMAIL_SEND_ENABLED=true
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=stay@lucasand.co
SMTP_PASS=your-google-app-password
CRON_SECRET=choose-a-long-random-secret
OWNER_NOTIFY_ENABLED=true
OWNER_NOTIFY_EMAIL=marc@lucasand.co
```

When ready for the final sender, create or alias the `Stay@Sixth14th.com` mailbox in the domain email provider, verify the sending domain with the transactional email provider if using one, and add the required SPF/DKIM records in Squarespace DNS. A transactional sender can use:

```bash
EMAIL_FROM="Stay at Sixth & 14th <Stay@Sixth14th.com>"
EMAIL_REPLY_TO=Stay@Sixth14th.com
EMAIL_SEND_ENABLED=true
RESEND_API_KEY=re_...
CRON_SECRET=choose-a-long-random-secret
OWNER_NOTIFY_ENABLED=true
OWNER_NOTIFY_EMAIL=marc@lucasand.co
```

## Safety tools

Owner alerts are controlled by:

```bash
OWNER_NOTIFY_ENABLED=true
OWNER_NOTIFY_EMAIL=marc@lucasand.co
```

When enabled, the app sends owner notifications for new booking requests, approvals, paid deposits/balances, cancellations, and failed guest emails. Admin also includes an audit log and a **Download backup** button that exports settings, reservations, message queue, and recent audit events as JSON.

## Automated message sending

The Admin **Message schedule** still lets you preview and manually send due guest messages. For hands-off sending, this build also includes a private automation endpoint and runner script.

1. In the Render web service, set `CRON_SECRET` to a long random value.
2. Confirm the web service has `PUBLIC_BASE_URL` set to the live booking app URL.
3. In Render, create a new Cron Job from the same repository/environment.
4. Use an hourly schedule, for example `0 * * * *`.
5. Use this command:

```bash
npm run send:due
```

6. Give the Cron Job the same `PUBLIC_BASE_URL` and `CRON_SECRET` values as the web service.

The cron runner calls `POST /api/cron/send-due-messages` and sends messages whose scheduled time is due. It is protected by `CRON_SECRET` and does not require the Admin password.

## Google Ads conversion tracking

The booking engine loads the Google Ads tag on the booking, admin, payment notice, and success pages with this Ads ID:

```bash
GOOGLE_ADS_ID=AW-994349610
```

The Google Ads conversion event is not fired on page load, date searches, quote refreshes, form validation errors, or failed booking submissions. It fires only after `/api/bookings` returns a successful booking-request response.

The booking form also preserves these attribution fields from the landing URL through the booking request: `gclid`, `gbraid`, `wbraid`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, and `utm_content`.

Once Google Ads gives you the conversion snippet, find the `send_to` value. It will look like:

```js
send_to: "AW-994349610/abcDEFghiJKL123"
```

In Render, open the booking app web service, then go to **Environment** and paste only the part after the slash into:

```bash
GOOGLE_ADS_CONVERSION_LABEL=abcDEFghiJKL123
```

Save the environment variable and redeploy the web service. Leave `TRACKING_DEBUG=false` in production; set it to `true` temporarily if you want browser console messages confirming that the tag loaded or that a booking-request conversion fired.

## Next build steps

1. Add a hidden Squarespace staging page that links to the Render booking page. See [SQUARESPACE_STAGING_INSTALL.md](./SQUARESPACE_STAGING_INSTALL.md).
2. Test the Squarespace staging path from desktop and phone while the live Lodgify widget stays in place.
3. Create the production Render service/environment only after the Squarespace staging path is approved.
4. Add production Stripe restricted key and live webhook in the production environment.
5. Run a final Lodgify iCal sync and compare the next 12 months before switching public traffic.
6. Replace the public Squarespace booking button/link with the production booking URL and keep Lodgify available for rollback.
7. Finish the email sender/domain work before turning on automatic email sending.
