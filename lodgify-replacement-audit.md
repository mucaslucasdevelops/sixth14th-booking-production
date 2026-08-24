# Lodgify Replacement Audit

This captures the current Lodgify behavior for the Sixth 14th guest suite and translates it into requirements for a custom booking and automated messaging system. Sensitive operational values, such as Wi-Fi credentials, should live in a private configuration store rather than in source code or public admin screens.

## Current Stack

- Public website: `sixth14th.com`, built in Squarespace
- Current booking engine: Lodgify widget and button link
- Payment processor: Stripe
- Property: A Gorgeous Garden Suite in Park Slope
- Internal name: 531 Sixth
- Lodgify property ID: `507939`
- Lodgify room type ID: `574322`

## Booking Policy

Primary policy:

- Deposit: 50% due at time of booking
- Balance: remaining 50% due 7 days before arrival
- Cancellation: all paid prepayments are non-refundable
- Security deposit: none
- Quote expiry: 48 hours

Secondary policy present in Lodgify:

- Deposit: 50% due at time of booking
- Balance: remaining 50% due 3 days before arrival
- Cancellation: 50% refundable if canceled 7 days before arrival or earlier; 0% refundable after
- Security deposit: USD 500 pre-authorization
- Quote expiry: 48 hours

Implementation note: confirm whether only the primary policy is active for direct bookings before build/cutover.

## Availability Rules

- Minimum stay: 2 nights
- Maximum stay: 1125 nights
- Preparation buffer: 1 day between reservations
- Booking window: no explicit limit captured
- Advance notice: latest reservation is 2 days before arrival
- Check-in days: all days available
- Check-out days: all days available
- Check-in time: 3:00 PM
- Check-out time: 11:00 AM

## Pricing

Nightly base rates:

- Sunday: $295
- Monday: $295
- Tuesday: $295
- Wednesday: $295
- Thursday: $295
- Friday: $325
- Saturday: $325

Length-of-stay prices:

- Weekly stay, 7 nights or more: $2,000
- Monthly stay, 30 nights or more: $4,500

Fees:

- Cleaning & Stocking: $100, single charge per stay

Not currently configured in the captured screens:

- Extra guest charge
- Short-stay price increase
- Taxes
- Promotions
- Add-ons

Open item: verify whether separate season rates are configured on the Lodgify Season rates screen.

## Guest Messaging

### Enabled Messages Captured

Booking accepted:

- Trigger: booking confirmed
- Channels: Lodgify
- Rentals: all rentals
- Purpose: confirmation note, booking details, contact instructions

Check-in instructions:

- Trigger: 2 days before arrival
- Channels: Lodgify
- Rentals: all rentals
- Purpose: arrival instructions and keypad access guidance

Welcome message:

- Trigger: welcome/during stay
- Channels: Lodgify, Airbnb, Booking.com, Expedia, Vrbo
- Rentals: all rentals
- Purpose: arrival welcome, local guide, support contact

Notify guest when host sends invoice:

- Trigger: host sends invoice
- Status: enabled

Check-out reminder:

- Trigger: check-out reminder
- Status: enabled

### Disabled Messages Captured

Review request:

- Trigger: 2 days after departure
- Status: disabled
- Channels: none selected

### Hidden Messages Not Captured

The scheduled messages screen shows hidden messages under:

- Before arrival: show more 11
- During stay: show more 2
- After departure: show more 1

Implementation note: these may be Lodgify defaults or unused templates. Before final cutover, expand these sections and confirm whether any are enabled and relevant.

## Messaging Placeholders And Operational Notes

Captured placeholders/content categories:

- Check-in instructions
- Check-out instructions
- Rental directions
- Door instructions
- Wi-Fi information
- Emergency contact
- Rental rules, currently blank
- Local guide, currently blank

Important implementation notes:

- Door access uses a keypad code derived from the last four digits of the guest phone number.
- Wi-Fi network and password should be stored as private operational settings, not hard-coded.
- Emergency contact should be stored as an admin setting and inserted into guest messages.
- The local guide is referenced by the welcome message but appears blank in the placeholder screen.

## Replacement System Requirements

### Guest-Facing Booking Flow

- Embedded calendar or booking page linked from Squarespace
- Date selection with unavailable dates blocked
- Minimum stay and buffer-day enforcement
- 2-day advance notice enforcement
- Guest form with name, email, phone, party size, and optional notes
- Quote summary before payment
- Stripe checkout for 50% deposit
- Automatic reservation confirmation after successful payment
- Balance payment link/reminder due 7 days before arrival

### Admin Workflow

- Calendar view of bookings, holds, and blocked dates
- Manual block/unblock dates
- Manual reservation creation
- Booking status management: inquiry/open, tentative, booked, canceled, declined
- Guest record view
- Payment status view: deposit paid, balance due, paid in full, refunded
- Message log per reservation
- Editable message templates
- Editable pricing, fee, and policy settings

### Automation Workflow

- On booking confirmed: send booking accepted email
- Two days before arrival: send check-in instructions
- During stay or day of arrival: send welcome message
- On invoice/balance event: send payment-related notice
- Before check-out or on check-out morning: send check-out reminder
- Optional after departure: review request, currently disabled

### Stripe Integration

- Use Stripe Checkout or Payment Links for deposit and balance collection
- Store Stripe customer, checkout session, payment intent, and invoice/payment link IDs
- Use Stripe webhooks as the source of truth for payment success/failure
- Do not store card data

### Squarespace Integration

- Replace Lodgify widget with one of:
  - embedded custom booking widget
  - button/link to hosted booking page
  - hybrid: small availability widget plus full booking page

Recommendation: start with a hosted booking page and a Squarespace button/link, then add an embedded widget once the booking flow is stable.

## MVP Build Sequence

1. Model property, rates, fees, policies, reservations, guests, payments, and messages.
2. Build public date picker and quote calculator.
3. Enforce availability, minimum stay, buffer day, and advance notice rules.
4. Connect Stripe deposit checkout.
5. Persist successful reservations via Stripe webhook.
6. Add admin calendar and manual blocks.
7. Add message templates and scheduled send jobs.
8. Add balance-due payment automation.
9. Run in parallel with Lodgify while validating real reservations.
10. Replace Lodgify widget/button on Squarespace.

## Open Questions Before Build

- Are season rates configured separately in Lodgify?
- Are any hidden scheduled messages enabled and important?
- Should bookings be instant-confirmed after deposit payment, or should you manually approve before payment?
- Should the custom system support Airbnb/VRBO/iCal synchronization, or only direct bookings from `sixth14th.com`?
- Should the local guide be built into the new system as a guest page?
- Should review requests remain disabled?
