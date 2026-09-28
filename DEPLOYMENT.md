# Deployment source and configuration

The production Render hostname observed on 2026-09-28 is `https://sixth14th-booking-production.onrender.com`; the staging hostname is `https://sixth14th-booking-staging.onrender.com`. Both returned a healthy `/api/health`. The production booking page matched `public/index.html` at this checkout byte for byte. These observations do not prove the deployed server commit or the Render dashboard settings.

The intended production custom URL in the earlier cutover checklist is `https://book.sixth14th.com`. It and `https://book-staging.sixth14th.com` were unreachable from the inspection environment (HTTP 502); verify DNS and Render custom domains in the dashboard before using them as canonical URLs. Do not change `PUBLIC_BASE_URL` on a running service based only on the checklist.

Render runs the root `Dockerfile`, which installs the root `package.json`, copies `server.mjs`, `public/`, selected `data/` seeds, and `scripts/`, and starts `node server.mjs`. The server serves static files only from `public/`. Production data is held in Render storage or Postgres as configured there; the repository's local reservation JSON is not a backup of live bookings.

No active Render Blueprint is maintained in this repository. The previous root `render.yaml` described a staging service and staging URL despite this repository's production name; it has been removed along with the package copies. Treat the existing Render service dashboard as the authority for branch, root directory, Dockerfile path, disk/database, environment variables, custom domains, and deploy settings. In particular, verify `PUBLIC_BASE_URL` and `DATA_DIR` there before changing them. If a Blueprint is attached to this repository, detach or update its configuration in Render before trying to sync: the old staging manifest is no longer present.

For a rollback of these repository files, use Git history at `eee477bd08a9756bbd26f053375e44cb67d4762c` or an earlier commit. A code rollback does not restore production reservation storage or environment variables; use the Render database/disk backup procedure for those.
