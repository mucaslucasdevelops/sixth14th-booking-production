# Squarespace Staging Install

Use this to test the replacement booking flow from sixth14th.com before making it the public booking path. Lodgify is treated as the source for existing calendar blocks only; the guest booking flow is being replaced.

## Current staging links

- Guest booking page: https://sixth14th-booking-staging.onrender.com/
- Private admin page: https://sixth14th-booking-staging.onrender.com/admin.html

Do not place the admin link on Squarespace.

## Safety rules

- Do not send public guests to staging or Stripe test mode.
- Use a hidden or unlinked Squarespace page for the final smoke test.
- Keep Stripe in sandbox/test mode on staging.
- Keep automatic email sending off until the sender/domain path is finished.
- Use the manual Compose email fallback for guest payment links while email delivery is still being finished.

## Create the private Squarespace test page

1. In Squarespace, open Pages.
2. Under Not Linked, create a blank page.
3. Name it Booking Test.
4. Set the page URL slug to /booking-test.
5. Add a Button block.
6. Set the button text to Request your stay.
7. Link the button to https://sixth14th-booking-staging.onrender.com/.
8. Save the page and keep it out of navigation.

## Optional code block button

If a Squarespace Button block is awkward, add a Code block and paste the contents of SQUARESPACE_BOOKING_BUTTON.html.

## Test path

1. Open the private Squarespace test page.
2. Click Request your stay.
3. Pick dates and submit a booking request.
4. Open the private admin page.
5. Approve or decline the request.
6. If approved, open the deposit link or use Compose deposit email.
7. Pay with a Stripe sandbox card.
8. Confirm the reservation becomes booked and the dates are blocked.

## Before public cutover

- Private Squarespace test page works on desktop and phone.
- Lodgify blocks match the staging calendar.
- Approval, decline, deposit payment, balance link, cancellation, and manual blocks work.
- Production Render service and production Postgres are created separately from staging.
- Live Stripe restricted key and live webhook are configured only in production.
- Email sending is configured, or manual email sending is intentionally accepted for launch.
- Rollback is ready: hide the new booking link and temporarily route guests to a manual request/contact path while issues are fixed. Only restore the Lodgify entry point if it is still useful enough for triage.

## Final cutover later

When staging is approved, create the production deployment, run a final Lodgify iCal sync, compare calendars, and replace the broken public Lodgify booking entry point with the production booking URL.
