# Guest source tracking

## Confirmed failure (2026-11-07)

The live Squarespace footer forwards only campaign parameters in the current page URL. A real browser test landed on `/?utm_source=tracking-audit&utm_medium=test&utm_campaign=diagnostic`, navigated to Hosts, then clicked Book. The booking URL contained a Google `_gl` linker value but none of the original UTM fields. No booking or payment was submitted in this test.

Three booking links on the homepage also share the same ID. Their individual inline scripts call `getElementById`, which decorates only the first matching button. The existing footer click handler mitigates ordinary clicks while campaign parameters are still present, but does not retain them through navigation, return visits, or all ways of opening a link.

The booking app previously stored campaign data only when a recognized query parameter existed, used session storage only, and did not capture referrers or ask guests how they found us. Admin did not display attribution. Missing saved attribution does not establish whether browser Ads conversions fired.

## Installation order

1. Deploy this branch to the production booking service. This adds a public shared tracking script, booking source capture, an optional guest question, and source details in admin.
2. In Squarespace Settings → Advanced → Code Injection, replace ONLY the old footer script that starts with `var bookingUrl` and installs the tracking click handler. Use this instead:

```html
<script defer src="https://sixth14th-booking-production.onrender.com/source-attribution.js"></script>
```

Keep unrelated footer content and Google tags. The old per-button inline scripts can be removed when editing those blocks, but all existing buttons are decorated by the new script regardless of their duplicate IDs. Do not keep the old footer click handler: it can open a different URL and discard the new source context.

The snippet must run on every marketing page, including landing pages. This repository cannot itself change the separate Squarespace site's code injection.

## Recorded information and limits

- Capture explicit campaign parameters and original external referrer hostname; never infer organic versus paid from a Google hostname alone. A click ID identifies the Google paid channel; UTM fields remain explicit campaign labels.
- Retain first tracked source and latest tagged/external source in this browser for 90 days after the latest captured source; untagged internal navigation and direct return visits do not replace a known source. First source is the first within that retained browser history, not a claim about the guest's lifetime discovery.
- Pass that source context in booking links. Preserve existing booking query parameters and Google linker values. Do not send guest names, contact information, referrer query strings, or landing-page query strings in source context.
- Store the guest's optional answer separately as `guest.discoverySource`; it is self-reported, never proof of an ad click, and is not used to manufacture click IDs or Ads conversions.
- Show tracked source, campaign, first source, capture time, and guest answer in admin. Old reservations remain unknown; no invented backfill.
- Blocked storage still permits immediate handoff; persistence across pages/visits requires available browser storage. Different browsers/devices, stripped tags, untagged email/social links, and missing referrers remain limits. Marketing links should carry UTM parameters.
- Existing Stripe metadata and server-side conversion creation retain the sanitized source fields. Ads delivery still requires a real saved click ID; this patch does not change conversion actions, count rules, or delivery credentials.

## Verification

Run `npm run test:regression`. The focused source tests exercise all homepage buttons, tagged landing → Hosts → booking, isolated marketing/booking storage, first/latest sources, no unrelated click-ID carryover, expiry, blocked storage, referrer privacy, unknown sources, and existing link parameters. Server tests check attribution and guest answer persistence plus public script access with admin protection.

After both deployment and Squarespace installation, verify tagged landing → Hosts → booking and direct booking. Use a clearly marked test campaign, without a fabricated Google click ID. Inspect the booking link's UTM/source fields before submitting anything. A full saved-booking verification should use a local/staging test, or an explicitly approved production QA booking; do not send guest emails or charge a card merely to test tracking.
