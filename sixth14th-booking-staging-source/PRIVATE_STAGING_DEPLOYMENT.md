# Private Staging Deployment

You do not need Squarespace access to create private staging. Squarespace only becomes relevant when we add a hidden test link or replace the public Lodgify booking button.

## Recommended Staging Shape

- Public website remains unchanged on Squarespace.
- Private booking app runs at a separate URL, for example `https://book-staging.sixth14th.com`.
- The staging app is password protected.
- Stripe is test mode only.
- Stripe webhook is reachable without the staging password, but it still requires the Stripe webhook signature.
- Staging storage uses a persistent disk at `/app/storage`.

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
PUBLIC_BASE_URL=https://book-staging.sixth14th.com
STAGING_USERNAME=marc
STAGING_PASSWORD=choose-a-long-password
STAGING_LABEL=Sixth 14th private staging
STRIPE_SECRET_KEY=rk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
LODGIFY_API_KEY=...
PAYMENT_HOLD_MINUTES=30
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
6. Deploy.
7. Confirm the Render URL loads and asks for the staging username/password.

Render will create a persistent disk mounted at `/app/storage`. That matters because pending Stripe checkout holds need to survive restarts while we are staging.

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
