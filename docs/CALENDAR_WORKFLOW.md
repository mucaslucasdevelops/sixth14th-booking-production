# Calendar and availability workflow

Dates are reserved only by an active booking with a recorded positive payment,
or an active manual block created by the host. A $1 friends-and-family payment
counts. Requests, approvals, unpaid payment links and demo approvals do not
reserve dates or schedule confirmed-stay messages.

`public/calendar-policy.js` is shared by the host calendar and server availability
checks. Google Calendar synchronization also uses this policy for direct bookings.
Stripe checkout events must report `payment_status: paid` and a positive amount;
unpaid completions and zero-dollar sessions do not confirm bookings. Delayed
payments are accepted through `checkout.session.async_payment_succeeded`.

Lodgify availability-only imports are retained as historical data, but do not
reserve dates: they do not establish that payment was received or that the host
created a block. Imported booked reservations with a recorded positive payment
continue to reserve dates. Any other dates the host wants to keep unavailable
must be entered as manual blocks.

Deploying this policy makes existing unpaid requests stop reserving availability
without deleting their records. It does not bulk-delete previously created
Google Calendar events. Cancel an obsolete request in Admin to remove its linked
Google event, if present. A cancellation preserves the booking activity record.

Validation: `npm run test:regression` covers unpaid requests and checkouts, paid
deposits, manual blocks, cancellations, and the shared calendar policy.
