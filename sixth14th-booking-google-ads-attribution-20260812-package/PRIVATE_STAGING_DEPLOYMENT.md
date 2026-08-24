# Private Staging Deployment

You do not need Squarespace access to create private staging. Squarespace only becomes relevant when we add a hidden test link or replace the public Lodgify booking button.

## Recommended Staging Shape

- Public website remains unchanged on Squarespace.
- Private booking app runs at a separate URL, for example `https://book-staging.sixth14th.com`.
- The staging app is password protected.
- When ready, the guest booking page can be made public while Admin remains password protected.
- Stripe is test mode only.
- Stripe webhook is reachable without the staging password, but it still requires the Stripe webhook signature.
- Staging storage uses Postgres for reservation state. The persistent disk remains only as a local fallback.

## What I Need From You

For staging deployment:

- Preferred hosting provider, or permission/access to set one up.
- A staging username and password.
- Stripe restricted test key: `rk_test_...`
- Stripe test webhook signing secret: `whsec_...`
- Optional: DNS access if you want `book-staging.sixth14th.com`.

Not needed yet:

- Squarespace login
- Stripe live keys
- Live credit card testing

## Environment Variables

```bash
PORT=4173
HOST=0.0.0.0
DATA_DIR=/app/storage
DATABASE_URL=postgres://...
PUBLIC_BASE_URL=https://book-staging.sixth14th.com
STAGING_USERNAME=marc
STAGING_PASSWORD=choose-a-long-password
STAGING_LABEL=Sixth 14th private staging
PUBLIC_BOOKING_ENABLED=false
STRIPE_SECRET_KEY=rk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
LODGIFY_API_KEY=...
LODGIFY_ICAL_URL=...
LODGIFY_PROPERTY_ID=507939
LODGIFY_ROOM_TYPE_ID=574322
PAYMENT_HOLD_MINUTES=30
CRON_SECRET=choose-a-long-random-secret
OWNER_NOTIFY_ENABLED=true
OWNER_NOTIFY_EMAIL=marc@lucasand.co
```

Do not set `ALLOW_LIVE_STRIPE` in staging.

## Render Deployment Path

The repository includes `render.yaml`, `Dockerfile`, and a health check endpoint, so Render can deploy it as a Docker web service.

1. Put this folder in a private GitHub repository.
2. In Render, choose **New → Blueprint**.
3. Connect the private repository.
4. Render will detect `render.yaml`.
5. When prompted, enter the secret values:
   - `STAGING_PASSWORD`
   - `STRIPE_SECRET_KEY`
   - `STRIPE_WEBHOOK_SECRET`, after creating the Stripe webhook
   - `LODGIFY_API_KEY`
   - `LODGIFY_ICAL_URL`, if Lodgify API access returns `403` for reservations
6. Deploy.
7. Confirm the Render URL loads and asks for the staging username/password.

When you are ready to share the booking page without sharing the admin password, change:

```bash
PUBLIC_BOOKING_ENABLED=true
```

After that change, `/` is public for guests, but `/admin.html`, `/admin.js`, and `/api/admin/...` remain password protected.

Render can still create a persistent disk mounted at `/app/storage`, but the safer setup is Postgres. The app will use Postgres automatically when `DATABASE_URL` is present and will fall back to the disk-backed JSON file only if `DATABASE_URL` is missing.

## Render Postgres Setup

Create the database before switching the booking app over:

1. In Render, choose **New → Postgres**.
2. Name it `sixth14th-booking-staging-db`.
3. Keep it in the same project and region as the booking web service.
4. Use the lowest paid/starter database tier that keeps data persistently.
5. After Render creates it, copy the **Internal Database URL**.
6. Open the booking web service → **Environment**.
7. Add or update:
   - `DATABASE_URL` = the internal database URL
8. Click **Save, rebuild, and deploy**.
9. Open `/admin.html`; the system status tile should change from `local-json` to `postgres`.

If Render only gives you an external database URL, also add `DATABASE_SSL=true`.

## Safety Settings

Set these on the booking web service to receive owner alerts:

```bash
OWNER_NOTIFY_ENABLED=true
OWNER_NOTIFY_EMAIL=marc@lucasand.co
```

The Admin page includes an audit log and a **Download backup** button for exporting current app data as JSON. Keep Render Postgres backups/snapshots enabled as the primary backup system.

## Automated Message Cron

After email sending works from Admin, create a Render Cron Job:

1. In Render, choose **New → Cron Job**.
2. Use the same repository as the booking app.
3. Set the schedule to hourly: `0 * * * *`.
4. Set the command to:

```bash
npm run send:due
```

5. Add these environment variables to the Cron Job:
   - `PUBLIC_BASE_URL` = the booking app URL, such as `https://book.sixth14th.com`
   - `CRON_SECRET` = the same secret used by the web service

The web service must also have the same `CRON_SECRET`. The Cron Job calls the private `/api/cron/send-due-messages` endpoint and sends any due queued messages.

## Custom Domain

After the Render service is live:

1. Open the service in Render.
2. Add custom domain: `book-staging.sixth14th.com`.
3. Render will show the DNS target to add.
4. In the DNS manager for `sixth14th.com`, add a CNAME:
   - Host/name: `book-staging`
   - Value/points to: the Render target
5. Wait for DNS and TLS certificate provisioning.

## Stripe Setup

In Stripe test mode, add this webhook endpoint:

```text
https://book-staging.sixth14th.com/api/stripe/webhook
```

Subscribe to:

```text
checkout.session.completed
```

The app confirms the booking from this webhook, not from the browser success page.

## Squarespace Staging Link

After the private app is deployed and tested, add a non-public/test button in Squarespace:

```html
<a href="https://book-staging.sixth14th.com" class="sqs-block-button-element--medium sqs-button-element--primary">
  Test private booking
</a>
```

Do not replace the public Lodgify button until the test checklist passes.

## Smoke Test

After deployment:

```bash
SMOKE_BASE_URL=https://book-staging.sixth14th.com \
SMOKE_USERNAME=marc \
SMOKE_PASSWORD=choose-a-long-password \
node scripts/smoke-test.mjs
```

The smoke test checks:

- health endpoint
- app config
- staging status
- available-date quote
- blocked-date rejection

## Squarespace Access Answer

No, I do not need Squarespace access to build or test private staging.

I only need Squarespace access later if you want me to personally add the staging button/link, inspect the existing Lodgify widget placement, or perform the final cutover.
