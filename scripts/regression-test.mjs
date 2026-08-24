import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncLodgifyData } from "./lodgify-sync.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const serverPath = path.join(rootDir, "server.mjs");
const webhookSecret = "whsec_regression_secret";
const auth = `Basic ${Buffer.from("qa:qa-pass").toString("base64")}`;
const results = [];

let app;

try {
  app = await startApp();
  await runChecks(app);
  await assertLiveStripeGuard();
} finally {
  if (app) await app.stop();
}

const failures = results.filter((result) => !result.ok);
for (const result of results) {
  console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}${result.detail ? ` - ${result.detail}` : ""}`);
}

if (failures.length) {
  process.exit(1);
}

async function runChecks(context) {
  await check("health is public", async () => {
    const response = await request(context, "GET", "/api/health", null, { auth: false });
    assert(response.status === 200, `expected 200, got ${response.status}`);
    assert(response.body.ok === true, "health payload was not ok");
  });

  await check("private staging gate protects pages", async () => {
    const response = await request(context, "GET", "/", null, { auth: false, parseJson: false });
    assert(response.status === 401, `expected 401, got ${response.status}`);
  });

  await check("public booking mode keeps admin private", async () => {
    const publicApp = await startApp({ PUBLIC_BOOKING_ENABLED: "true" });
    try {
      const bookingPage = await request(publicApp, "GET", "/", null, { auth: false, parseJson: false });
      assert(bookingPage.status === 200, `expected public booking page 200, got ${bookingPage.status}`);

      const config = await request(publicApp, "GET", "/api/config", null, { auth: false });
      assert(config.status === 200, `expected public config 200, got ${config.status}`);
      assert(config.body.staging.publicBookingEnabled === true, "expected public booking flag in config");

      const quoteResponse = await request(publicApp, "POST", "/api/quote", {
        arrival: nextWeekdayIso(0, 80),
        departure: addDaysIso(nextWeekdayIso(0, 80), 2),
        guests: 2
      }, { auth: false });
      assert(quoteResponse.status === 200, `expected public quote 200, got ${quoteResponse.status}`);

      const adminPage = await request(publicApp, "GET", "/admin.html", null, { auth: false, parseJson: false });
      assert(adminPage.status === 401, `expected admin page 401, got ${adminPage.status}`);

      const adminScript = await request(publicApp, "GET", "/admin.js", null, { auth: false, parseJson: false });
      assert(adminScript.status === 401, `expected admin script 401, got ${adminScript.status}`);

      const adminApi = await request(publicApp, "GET", "/api/admin/reservations", null, { auth: false });
      assert(adminApi.status === 401, `expected admin API 401, got ${adminApi.status}`);

      const storePath = path.join(publicApp.dataDir, "reservations.json");
      const store = JSON.parse(await readFile(storePath, "utf8"));
      store.reservations.push({
        id: "short-payment-link",
        arrival: nextWeekdayIso(0, 80),
        departure: addDaysIso(nextWeekdayIso(0, 80), 2),
        status: "pending_payment",
        paymentStatus: "deposit_due",
        holdExpiresAt: "2099-01-01T00:00:00.000Z",
        guest: { name: "Short Link", email: "short@example.com", phone: "5551230000", guests: 2 },
        quote: { total: 690, depositDue: 345, balanceDue: 345, currency: "USD" },
        stripeCheckoutUrl: "https://checkout.stripe.com/c/pay/short-payment-link",
        depositPaymentToken: "deposit-token",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      }, {
        id: "balance-payment-link",
        arrival: nextWeekdayIso(1, 88),
        departure: addDaysIso(nextWeekdayIso(1, 88), 2),
        status: "booked",
        paymentStatus: "balance_due",
        guest: { name: "Balance Link", email: "balance@example.com", phone: "5551239999", guests: 2 },
        quote: { total: 690, depositDue: 345, balanceDue: 345, currency: "USD" },
        amountPaid: 345,
        balanceCheckoutUrl: "https://checkout.stripe.com/c/pay/balance-payment-link",
        balancePaymentToken: "balance-token",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z"
      });
      await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`);

      const paymentLink = await fetch(`${publicApp.baseUrl}/pay/deposit/short-payment-link`, { redirect: "manual" });
      assert(paymentLink.status === 303, `expected short payment link redirect 303, got ${paymentLink.status}`);
      assert(
        paymentLink.headers.get("location") === "https://checkout.stripe.com/c/pay/short-payment-link",
        "expected short payment link to redirect to Stripe checkout"
      );

      const tokenPaymentLink = await fetch(`${publicApp.baseUrl}/pay/deposit/deposit-token`, { redirect: "manual" });
      assert(tokenPaymentLink.status === 303, `expected token payment link redirect 303, got ${tokenPaymentLink.status}`);
      assert(
        tokenPaymentLink.headers.get("location") === "https://checkout.stripe.com/c/pay/short-payment-link",
        "expected token payment link to redirect to Stripe checkout"
      );

      const balancePaymentLink = await fetch(`${publicApp.baseUrl}/pay/balance/balance-token`, { redirect: "manual" });
      assert(balancePaymentLink.status === 303, `expected balance payment link redirect 303, got ${balancePaymentLink.status}`);
      assert(
        balancePaymentLink.headers.get("location") === "https://checkout.stripe.com/c/pay/balance-payment-link",
        "expected balance payment link to redirect to Stripe checkout"
      );
    } finally {
      await publicApp.stop();
    }
  });

  await check("private staging allows authenticated API reads", async () => {
    const response = await request(context, "GET", "/api/staging/status");
    assert(response.status === 200, `expected 200, got ${response.status}`);
    assert(response.body.privateAccessEnabled === true, "private access is not enabled");
    assert(response.body.publicBookingEnabled === false, "public booking should be disabled by default in regression");
    assert(response.body.stripeWebhookConfigured === true, "webhook secret should be configured in regression");
    assert(response.body.liveStripeUnlocked === false, "live Stripe should remain locked");
    assert(response.body.googleAdsDeliveryConfigured === false, "Google Ads delivery should not be configured in regression");
  });

  await check("SMTP email can be configured while sending stays off", async () => {
    const smtpApp = await startApp({
      EMAIL_FROM: "Stay at Sixth & 14th <stay@example.test>",
      EMAIL_REPLY_TO: "stay@example.test",
      EMAIL_SEND_ENABLED: "",
      SMTP_HOST: "smtp.example.test",
      SMTP_PORT: "465",
      SMTP_SECURE: "true",
      SMTP_USER: "stay@example.test",
      SMTP_PASS: "secret"
    });
    try {
      const response = await request(smtpApp, "GET", "/api/staging/status");
      assert(response.status === 200, `expected 200, got ${response.status}`);
      assert(response.body.emailConfigured === true, "expected SMTP email to be configured");
      assert(response.body.emailSendingEnabled === false, "expected email sending to stay off");
      assert(response.body.emailProvider === "smtp", `expected smtp provider, got ${response.body.emailProvider}`);
      assert(response.body.emailFrom.includes("stay@example.test"), "expected SMTP sender to appear in status");
    } finally {
      await smtpApp.stop();
    }
  });

  await check("Gmail OAuth email provider takes precedence", async () => {
    const gmailApp = await startApp({
      EMAIL_FROM: "Stay at Sixth & 14th <stay@sixth14th.com>",
      EMAIL_REPLY_TO: "stay@sixth14th.com",
      EMAIL_SEND_ENABLED: "",
      GMAIL_OAUTH_CLIENT_ID: "client-id",
      GMAIL_OAUTH_CLIENT_SECRET: "client-secret",
      GMAIL_OAUTH_REFRESH_TOKEN: "refresh-token",
      GMAIL_OAUTH_USER: "stay@sixth14th.com",
      RESEND_API_KEY: "fallback-resend-key",
      SMTP_HOST: "smtp.example.test",
      SMTP_USER: "stay@example.test",
      SMTP_PASS: "secret"
    });
    try {
      const response = await request(gmailApp, "GET", "/api/staging/status");
      assert(response.status === 200, `expected 200, got ${response.status}`);
      assert(response.body.emailConfigured === true, "expected Gmail OAuth email to be configured");
      assert(response.body.emailSendingEnabled === false, "expected email sending to stay off");
      assert(response.body.emailProvider === "gmail", `expected gmail provider, got ${response.body.emailProvider}`);
      assert(response.body.emailFrom.includes("stay@sixth14th.com"), "expected Gmail sender to appear in status");
      assert(response.body.googleCalendarConfigured === true, "expected Google Calendar to be configured from OAuth");
      assert(response.body.googleCalendarSyncEnabled === true, "expected Google Calendar sync to be enabled");
      assert(response.body.googleCalendarAttendee === "stay@sixth14th.com", "expected stay calendar attendee");
    } finally {
      await gmailApp.stop();
    }
  });

  await check("balance reminders use tidy public payment links", async () => {
    const serverSource = await readFile(serverPath, "utf8");
    assert(
      serverSource.includes('return publicPaymentUrl(reservation, "balance")'),
      "balance reminders should prefer the app-owned payment redirect"
    );
    assert(
      serverSource.includes('label = "Pay the remaining balance"'),
      "balance reminder HTML should render the payment URL as a button"
    );
  });

  await check("calendar only highlights selected dates in their real month", async () => {
    const appSource = await readFile(path.join(rootDir, "public", "app.js"), "utf8");
    assert(
      appSource.includes("isCurrentMonth && (iso === state.arrival || iso === state.departure)"),
      "selected date styling should be scoped to the current month"
    );
    assert(
      appSource.includes("isCurrentMonth && state.arrival && state.departure && iso > state.arrival && iso < state.departure"),
      "range styling should be scoped to the current month"
    );
  });

  await check("Google Ads delivery is disabled while attribution remains capture-only", async () => {
    const trackingSource = await readFile(path.join(rootDir, "public", "tracking.js"), "utf8");
    assert(!trackingSource.includes("googletagmanager.com/gtag/js"), "tracking should not load Google scripts yet");
    assert(trackingSource.includes("attribution is capture-only"), "tracking should explicitly stay capture-only");
  });

  await check("Squarespace booking button preserves attribution query fields", async () => {
    const buttonSource = await readFile(path.join(rootDir, "SQUARESPACE_BOOKING_BUTTON.html"), "utf8");
    for (const key of ["gclid", "gbraid", "wbraid", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"]) {
      assert(buttonSource.includes(`"${key}"`), `expected Squarespace button to preserve ${key}`);
    }
    assert(buttonSource.includes("target.searchParams.set(key, value)"), "expected preserved fields to be appended to booking URL");
  });

  await check("Stripe checkout metadata includes booking and safe attribution fields", async () => {
    const serverSource = await readFile(serverPath, "utf8");
    assert(serverSource.includes('body.set("metadata[booking_id]", reservation.id)'), "expected Stripe session booking_id metadata");
    assert(serverSource.includes('body.set("payment_intent_data[metadata][booking_id]", reservation.id)'), "expected Stripe payment intent booking_id metadata");
    assert(serverSource.includes("stripeAttributionMetadata(reservation, paymentType)"), "expected Stripe attribution metadata helper");
    assert(serverSource.includes("safeAttributionFields(reservation.attribution)"), "expected safe attribution fields in metadata");
  });

  await check("Google Ads delivery endpoint and cron script are wired without making Google calls", async () => {
    const [serverSource, packageSource, scriptSource] = await Promise.all([
      readFile(serverPath, "utf8"),
      readFile(path.join(rootDir, "package.json"), "utf8"),
      readFile(path.join(rootDir, "scripts", "send-google-ads-conversions.mjs"), "utf8")
    ]);
    assert(serverSource.includes("/api/cron/send-google-ads-conversions"), "expected protected Google Ads delivery cron endpoint");
    assert(serverSource.includes("uploadClickConversions"), "expected Google Ads uploadClickConversions API path");
    assert(serverSource.includes("partialFailure: true"), "expected partial failure mode for conversion uploads");
    assert(packageSource.includes("send:google-ads-conversions"), "expected npm script for Google Ads conversion delivery");
    assert(scriptSource.includes("/api/cron/send-google-ads-conversions"), "expected cron script to call Google Ads delivery endpoint");
  });

  await check("booking activity archive and delete controls remain available for terminal rows", async () => {
    const adminSource = await readFile(path.join(rootDir, "public", "admin.js"), "utf8");
    assert(
      adminSource.includes('return activityActions ? `<span class="row-actions">${activityActions}</span>` : "-"'),
      "canceled or declined local rows should still expose archive/delete actions"
    );
  });

  const sixNightArrival = nextWeekdayIso(0, 45);
  const sixNightDeparture = addDaysIso(sixNightArrival, 6);
  const sixNightQuote = await check("six-night quote matches Lodgify pricing", async () => {
    const response = await quote(context, sixNightArrival, sixNightDeparture);
    assert(response.status === 200, `expected 200, got ${response.status}`);
    assert(response.body.total === 1900, `expected total 1900, got ${response.body.total}`);
    assert(response.body.depositDue === 950, `expected deposit 950, got ${response.body.depositDue}`);
    return response.body;
  });

  await check("weekly quote uses weekly stay price", async () => {
    const response = await quote(context, nextWeekdayIso(0, 60), addDaysIso(nextWeekdayIso(0, 60), 7));
    assert(response.status === 200, `expected 200, got ${response.status}`);
    assert(response.body.total === 2100, `expected total 2100, got ${response.body.total}`);
    assert(response.body.depositDue === 1050, `expected deposit 1050, got ${response.body.depositDue}`);
  });

  await check("minimum stay is enforced", async () => {
    const arrival = nextWeekdayIso(1, 60);
    const response = await quote(context, arrival, addDaysIso(arrival, 1));
    assert(response.status === 400, `expected 400, got ${response.status}`);
  });

  await check("maximum occupancy is enforced", async () => {
    const response = await request(context, "POST", "/api/quote", {
      arrival: nextWeekdayIso(0, 70),
      departure: addDaysIso(nextWeekdayIso(0, 70), 2),
      guests: 4
    });
    assert(response.status === 400, `expected 400, got ${response.status}`);
    assert(response.body.error.includes("between 1 and 3"), "expected maximum guest message");
  });

  await check("manual blocks prevent quoting", async () => {
    const start = nextWeekdayIso(2, 75);
    const end = addDaysIso(start, 2);
    const block = await request(context, "POST", "/api/admin/blocks", { start, end, reason: "Regression block" });
    assert(block.status === 201, `expected block 201, got ${block.status}`);
    const response = await quote(context, start, end);
    assert(response.status === 400, `expected blocked quote 400, got ${response.status}`);

    const updatedStart = addDaysIso(start, 5);
    const updatedEnd = addDaysIso(updatedStart, 2);
    const updatedBlock = await request(context, "PATCH", `/api/admin/blocks/${encodeURIComponent(block.body.id)}`, {
      start: updatedStart,
      end: updatedEnd,
      reason: "Updated regression block"
    });
    assert(updatedBlock.status === 200, `expected block update 200, got ${updatedBlock.status}`);
    assert(updatedBlock.body.reason === "Updated regression block", "expected block reason to update");
    const released = await quote(context, start, end);
    assert(released.status === 200, `expected edited block to release old dates, got ${released.status}`);
    const archivedBlock = await request(context, "PATCH", `/api/admin/blocks/${encodeURIComponent(block.body.id)}`, {
      archived: true,
      archiveReason: "Regression archive"
    });
    assert(archivedBlock.status === 200, `expected block archive 200, got ${archivedBlock.status}`);
    assert(archivedBlock.body.archivedAt, "expected block archivedAt to be set");
    const unarchivedBlock = await request(context, "PATCH", `/api/admin/blocks/${encodeURIComponent(block.body.id)}`, {
      archived: false
    });
    assert(unarchivedBlock.status === 200, `expected block unarchive 200, got ${unarchivedBlock.status}`);
    assert(!unarchivedBlock.body.archivedAt, "expected block archivedAt to be cleared");
    const deletedBlock = await request(context, "DELETE", `/api/admin/blocks/${encodeURIComponent(block.body.id)}`);
    assert(deletedBlock.status === 200, `expected block delete 200, got ${deletedBlock.status}`);
    const available = await quote(context, updatedStart, updatedEnd);
    assert(available.status === 200, `expected deleted block to release dates, got ${available.status}`);
  });

  await check("Lodgify sync keeps bookings if availability details fail", async () => {
    const result = await syncLodgifyData({ reservations: [], manualBlocks: [], availabilityBlocks: [] }, {
      apiKey: "unit-test-key",
      now: new Date("2026-05-16T12:00:00.000Z"),
      months: 1,
      fetchImpl: async (url) => {
        if (String(url).includes("/reservations/bookings")) {
          return jsonResponse(200, {
            items: [
              {
                id: "partial-sync-booking",
                status: "booked",
                arrival: "2026-06-14",
                departure: "2026-06-20",
                currency_code: "USD",
                total_amount: 1900,
                amount_due: 0,
                amount_paid: 1900,
                rooms: [{ people: 2 }]
              }
            ]
          });
        }
        return jsonResponse(404, { message: "Availability endpoint not available in this account." });
      }
    });
    assert(result.importedBookings === 1, `expected booking import to continue, got ${result.importedBookings}`);
    assert(result.availabilityBlocks === 0, `expected no availability blocks, got ${result.availabilityBlocks}`);
    assert(result.warnings.length === 1, "expected one availability warning");
  });

  await check("Lodgify iCal fallback imports blocks when API is forbidden", async () => {
    const result = await syncLodgifyData({ reservations: [], manualBlocks: [], availabilityBlocks: [] }, {
      apiKey: "forbidden-api-key",
      iCalUrl: "https://ical.example.test/calendar.ics",
      now: new Date("2026-05-16T12:00:00.000Z"),
      months: 12,
      fetchImpl: async (url) => {
        if (String(url).includes("calendar.ics")) {
          return textResponse(200, [
            "BEGIN:VCALENDAR",
            "BEGIN:VEVENT",
            "SUMMARY:Past booking",
            "DTSTART;VALUE=DATE:20250501",
            "DTEND;VALUE=DATE:20250505",
            "END:VEVENT",
            "BEGIN:VEVENT",
            "SUMMARY:Reserved",
            "DTSTART;VALUE=DATE:20260614",
            "DTEND;VALUE=DATE:20260620",
            "END:VEVENT",
            "BEGIN:VEVENT",
            "SUMMARY:Too far out",
            "DTSTART;VALUE=DATE:20270614",
            "DTEND;VALUE=DATE:20270620",
            "END:VEVENT",
            "END:VCALENDAR"
          ].join("\n"));
        }
        return jsonResponse(403, { message: "Forbidden" });
      }
    });
    assert(result.importedBookings === 0, `expected no booking import, got ${result.importedBookings}`);
    assert(result.availabilityBlocks === 1, `expected one iCal block, got ${result.availabilityBlocks}`);
    assert(result.store.availabilityBlocks[0].start === "2026-06-14", "expected iCal start date to sync");
    assert(result.store.availabilityBlocks[0].end === "2026-06-20", "expected iCal end date to stay checkout-exclusive");
    assert(result.store.availabilityBlocks[0].reason === "Imported Lodgify booking", "expected iCal summary to be redacted");
  });

  await check("admin can sync Lodgify availability", async () => {
    const response = await request(context, "POST", "/api/admin/sync-lodgify", {});
    assert(response.status === 200, `expected sync 200, got ${response.status}`);
    assert(response.body.importedBookings === 1, `expected 1 booking, got ${response.body.importedBookings}`);
    assert(response.body.availabilityBlocks >= 1, `expected synced availability blocks, got ${response.body.availabilityBlocks}`);

    const reservations = await request(context, "GET", "/api/admin/reservations");
    assert(
      reservations.body.reservations.some((reservation) => reservation.source === "lodgify" && reservation.externalId === context.lodgify.bookingId),
      "expected synced Lodgify reservation in admin data"
    );

    const blockedQuote = await quote(context, context.lodgify.arrival, context.lodgify.departure);
    assert(blockedQuote.status === 400, `expected Lodgify synced dates to be blocked, got ${blockedQuote.status}`);
  });

  let booking;
  await check("booking request blocks duplicate dates", async () => {
    const response = await request(context, "POST", "/api/bookings", {
      arrival: sixNightArrival,
      departure: sixNightDeparture,
      guests: 2,
      name: "QA Guest",
      email: "qa@example.com",
      phone: "5551234567",
      notes: "Regression test",
      attribution: {
        gclid: "test-gclid",
        gbraid: "test-gbraid",
        wbraid: "test-wbraid",
        utm_source: "google",
        utm_medium: "cpc",
        utm_campaign: "brand",
        utm_term: "park slope rental",
        utm_content: "booking-button",
        landingPage: "/",
        capturedAt: "2026-06-04T00:00:00.000Z",
        ignored: "do-not-store"
      }
    });
    assert(response.status === 201, `expected 201, got ${response.status}`);
    assert(!response.body.checkoutUrl, "guest request should not create Stripe checkout before host approval");
    booking = response.body.reservation;
    assert(booking.status === "pending_host_approval", `expected pending_host_approval, got ${booking.status}`);
    assert(booking.paymentStatus === "awaiting_host_approval", `expected awaiting_host_approval, got ${booking.paymentStatus}`);
    assert(booking.attribution.gclid === "test-gclid", "expected gclid attribution to be stored");
    assert(booking.attribution.utm_campaign === "brand", "expected UTM attribution to be stored");
    assert(!booking.attribution.ignored, "unexpected attribution field was stored");

    const duplicate = await quote(context, sixNightArrival, sixNightDeparture);
    assert(duplicate.status === 400, `expected duplicate quote 400, got ${duplicate.status}`);

    const availability = await request(context, "GET", `/api/availability?start=${sixNightArrival}&end=${addDaysIso(sixNightArrival, 1)}`);
    assert(availability.status === 200, `expected availability 200, got ${availability.status}`);
    assert(availability.body.days[0].available === false, "arrival day should be unavailable after hold");
  });

  await check("message queue waits for host approval", async () => {
    const response = await request(context, "GET", "/api/admin/message-queue");
    assert(response.status === 200, `expected message queue 200, got ${response.status}`);
    const deliveries = response.body.queue.filter((item) => item.reservationId === booking.id);
    assert(deliveries.length === 0, `expected no scheduled messages before approval, got ${deliveries.length}`);
  });

  await check("webhook rejects bad signatures", async () => {
    const response = await request(context, "POST", "/api/stripe/webhook", { type: "checkout.session.completed" }, {
      auth: false,
      headers: { "stripe-signature": "t=1,v1=bad" }
    });
    assert(response.status === 400, `expected 400, got ${response.status}`);
  });

  await check("admin approval creates a payment step", async () => {
    const response = await request(context, "POST", `/api/admin/reservations/${encodeURIComponent(booking.id)}/approve`, {});
    assert(response.status === 200, `expected approve 200, got ${response.status}`);
    assert(response.body.demoMode === true, "local regression should approve without Stripe checkout");
    assert(!response.body.checkoutUrl, "local regression should not create Stripe checkout");
    assert(response.body.reservation.status === "demo_hold", `expected demo_hold, got ${response.body.reservation.status}`);
    assert(response.body.reservation.paymentStatus === "demo_no_payment", `expected demo_no_payment, got ${response.body.reservation.paymentStatus}`);
  });

  await check("valid Stripe webhook marks booking paid", async () => {
    const event = {
      id: "evt_regression",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_regression",
          payment_intent: "pi_test_regression",
          amount_total: Math.round(sixNightQuote.depositDue * 100),
          metadata: { booking_id: booking.id }
        }
      }
    };
    const raw = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", webhookSecret).update(`${timestamp}.${raw}`).digest("hex");
    const response = await rawRequest(context, "POST", "/api/stripe/webhook", raw, {
      "content-type": "application/json",
      "stripe-signature": `t=${timestamp},v1=${signature}`
    });
    assert(response.status === 200, `expected 200, got ${response.status}`);

    const reservations = await request(context, "GET", "/api/admin/reservations");
    const updated = reservations.body.reservations.find((item) => item.id === booking.id);
    assert(updated.status === "booked", `expected booked, got ${updated.status}`);
    assert(updated.paymentStatus === "deposit_paid", `expected deposit_paid, got ${updated.paymentStatus}`);
    assert(updated.amountPaid === sixNightQuote.depositDue, `expected amountPaid ${sixNightQuote.depositDue}, got ${updated.amountPaid}`);
    const conversions = reservations.body.googleAdsPurchaseConversions || [];
    const conversion = conversions.find((item) => item.bookingId === booking.id);
    assert(conversion, "expected deposit webhook to prepare a purchase conversion record");
    assert(conversion.orderId === booking.id, "expected booking ID as unique order ID");
    assert(conversion.value === sixNightQuote.total, `expected full booking value ${sixNightQuote.total}, got ${conversion.value}`);
    assert(conversion.currency === "USD", `expected USD currency, got ${conversion.currency}`);
    assert(conversion.googleClickId === "test-gclid", "expected available Google click ID to be stored");
    assert(conversion.googleClickIdType === "gclid", "expected click ID type to be stored");
    assert(conversion.deliveryStatus === "pending_delivery", `expected pending_delivery, got ${conversion.deliveryStatus}`);
    assert(conversion.conversionTimestamp, "expected conversion timestamp");

    const retry = await rawRequest(context, "POST", "/api/stripe/webhook", raw, {
      "content-type": "application/json",
      "stripe-signature": `t=${timestamp},v1=${signature}`
    });
    assert(retry.status === 200, `expected retry 200, got ${retry.status}`);
    const afterRetry = await request(context, "GET", "/api/admin/reservations");
    const duplicateCount = (afterRetry.body.googleAdsPurchaseConversions || []).filter((item) => item.bookingId === booking.id).length;
    assert(duplicateCount === 1, `expected one conversion after retry, got ${duplicateCount}`);
  });

  await check("Google Ads delivery stays queued when credentials are missing", async () => {
    const response = await rawRequest(context, "POST", "/api/cron/send-google-ads-conversions", undefined, {
      "x-cron-secret": webhookSecret
    });
    assert(response.status === 200, `expected delivery endpoint 200, got ${response.status}`);
    assert(response.body.configured === false, "expected delivery to report unconfigured");
    assert(response.body.pending >= 1, "expected prepared conversion to remain pending");
    assert(response.body.sent === 0, `expected no sent conversions, got ${response.body.sent}`);
  });

  await check("deposit webhook records skipped conversion when click ID is missing", async () => {
    const arrival = nextWeekdayIso(1, 108);
    const departure = addDaysIso(arrival, 2);
    const response = await request(context, "POST", "/api/bookings", {
      arrival,
      departure,
      guests: 2,
      name: "Organic Guest",
      email: "organic@example.com",
      phone: "5554443333",
      attribution: { utm_source: "newsletter", utm_campaign: "summer" }
    });
    assert(response.status === 201, `expected request 201, got ${response.status}`);
    const organicBooking = response.body.reservation;
    const approve = await request(context, "POST", `/api/admin/reservations/${encodeURIComponent(organicBooking.id)}/approve`, {});
    assert(approve.status === 200, `expected approve 200, got ${approve.status}`);

    const event = {
      id: "evt_no_click_regression",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_no_click_regression",
          payment_intent: "pi_test_no_click_regression",
          amount_total: Math.round(response.body.reservation.quote.depositDue * 100),
          metadata: { booking_id: organicBooking.id, payment_type: "deposit" }
        }
      }
    };
    const raw = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", webhookSecret).update(`${timestamp}.${raw}`).digest("hex");
    const paid = await rawRequest(context, "POST", "/api/stripe/webhook", raw, {
      "content-type": "application/json",
      "stripe-signature": `t=${timestamp},v1=${signature}`
    });
    assert(paid.status === 200, `expected webhook 200, got ${paid.status}`);

    const reservations = await request(context, "GET", "/api/admin/reservations");
    const conversion = (reservations.body.googleAdsPurchaseConversions || []).find((item) => item.bookingId === organicBooking.id);
    assert(conversion, "expected skipped purchase conversion record");
    assert(conversion.deliveryStatus === "skipped_no_click_id", `expected skipped_no_click_id, got ${conversion.deliveryStatus}`);
    assert(conversion.googleClickId === null, "expected missing Google click ID to be null");
    assert(conversion.attribution.utm_source === "newsletter", "expected safe UTM attribution to remain available");
  });

  await check("message queue previews booked guest cadence", async () => {
    const response = await request(context, "GET", "/api/admin/message-queue");
    assert(response.status === 200, `expected message queue 200, got ${response.status}`);
    const deliveries = response.body.queue.filter((item) => item.reservationId === booking.id);
    assert(deliveries.length >= 5, `expected at least 5 scheduled messages, got ${deliveries.length}`);
    const accepted = deliveries.find((item) => item.messageId === "booking-confirmation");
    assert(accepted, "expected booking accepted message to be scheduled");
    assert(accepted.body.includes("QA"), "expected guest first name to render in preview");
    assert(accepted.body.includes("Booking details:"), "expected booking confirmation to include booking details");
    assert(accepted.body.includes("Dates:"), "expected booking confirmation to include stay dates");
    assert(accepted.body.includes("Total:"), "expected booking confirmation to include total");
    assert(accepted.body.match(/Booking details:/g).length === 1, "expected exactly one booking details footer");

    const templateSave = await request(context, "PATCH", "/api/admin/messages/booking-confirmation", {
      enabled: true,
      subject: "",
      body: "Hi {{guestFirstName}}\n\nBooking details:\n{{bookingDetails}}"
    });
    assert(templateSave.status === 200, `expected template save 200, got ${templateSave.status}`);
    assert(templateSave.body.message.subject === "Booking confirmation", "blank subject should fall back to the template name");

    const sendDue = await request(context, "POST", "/api/admin/message-queue/send-due", {});
    assert(sendDue.status === 200, `expected send due 200, got ${sendDue.status}`);
    assert(sendDue.body.sent === 0, `email-disabled staging should not send messages, sent ${sendDue.body.sent}`);
    assert(sendDue.body.ready >= 1, "expected due messages to remain queued when email is disabled");
    const stillDue = sendDue.body.queue.find((item) => item.id === accepted.id);
    assert(stillDue.status === "due", `expected due message to stay due, got ${stillDue.status}`);

    const markSent = await request(context, "PATCH", `/api/admin/message-queue/${encodeURIComponent(accepted.id)}`, {
      status: "sent"
    });
    assert(markSent.status === 200, `expected mark sent 200, got ${markSent.status}`);
    assert(markSent.body.status === "sent", `expected sent status, got ${markSent.body.status}`);
    assert(markSent.body.sentAt, "expected sentAt timestamp");
  });

  await check("balance link creation is staged until Stripe is configured", async () => {
    const response = await request(context, "POST", `/api/admin/reservations/${encodeURIComponent(booking.id)}/balance`, {});
    assert(response.status === 200, `expected balance link 200, got ${response.status}`);
    assert(response.body.demoMode === true, "local regression should not create a real balance checkout");
    assert(!response.body.checkoutUrl, "local regression should not create a Stripe balance link");
  });

  await check("balance webhook marks booking paid in full", async () => {
    const event = {
      id: "evt_balance_regression",
      type: "checkout.session.completed",
      data: {
        object: {
          id: "cs_test_balance_regression",
          payment_intent: "pi_test_balance_regression",
          amount_total: Math.round(sixNightQuote.balanceDue * 100),
          metadata: { booking_id: booking.id, payment_type: "balance" }
        }
      }
    };
    const raw = JSON.stringify(event);
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", webhookSecret).update(`${timestamp}.${raw}`).digest("hex");
    const response = await rawRequest(context, "POST", "/api/stripe/webhook", raw, {
      "content-type": "application/json",
      "stripe-signature": `t=${timestamp},v1=${signature}`
    });
    assert(response.status === 200, `expected 200, got ${response.status}`);

    const reservations = await request(context, "GET", "/api/admin/reservations");
    const updated = reservations.body.reservations.find((item) => item.id === booking.id);
    assert(updated.status === "booked", `expected booked, got ${updated.status}`);
    assert(updated.paymentStatus === "paid_in_full", `expected paid_in_full, got ${updated.paymentStatus}`);
    assert(updated.amountPaid === sixNightQuote.total, `expected amountPaid ${sixNightQuote.total}, got ${updated.amountPaid}`);
    assert(updated.balanceStripePaymentIntentId === "pi_test_balance_regression", "expected balance payment intent to be stored");
  });

  await check("paid-in-full bookings drop balance reminders", async () => {
    const response = await request(context, "GET", "/api/admin/message-queue");
    assert(response.status === 200, `expected message queue 200, got ${response.status}`);
    const deliveries = response.body.queue.filter((item) => item.reservationId === booking.id);
    assert(!deliveries.some((item) => item.messageId === "balance-reminder"), "balance reminder should be removed after full payment");
  });

  await check("admin can cancel a booked test reservation and release dates", async () => {
    const canceled = await request(context, "PATCH", `/api/admin/reservations/${booking.id}`, {
      status: "canceled",
      paymentStatus: "canceled"
    });
    assert(canceled.status === 200, `expected cancel booked 200, got ${canceled.status}`);

    const available = await quote(context, sixNightArrival, sixNightDeparture);
    assert(available.status === 200, `expected booked test cancellation to release dates, got ${available.status}`);
  });

  await check("admin can decline a booking request and release dates", async () => {
    const arrival = nextWeekdayIso(4, 88);
    const departure = addDaysIso(arrival, 2);
    const response = await request(context, "POST", "/api/bookings", {
      arrival,
      departure,
      guests: 2,
      name: "Declined Request",
      email: "decline@example.com",
      phone: "5559991111"
    });
    assert(response.status === 201, `expected request 201, got ${response.status}`);
    const requestBooking = response.body.reservation;

    const blocked = await quote(context, arrival, departure);
    assert(blocked.status === 400, `expected pending request to block dates, got ${blocked.status}`);

    const declined = await request(context, "POST", `/api/admin/reservations/${encodeURIComponent(requestBooking.id)}/decline`, {});
    assert(declined.status === 200, `expected decline 200, got ${declined.status}`);
    assert(declined.body.reservation.status === "declined", `expected declined, got ${declined.body.reservation.status}`);

    const available = await quote(context, arrival, departure);
    assert(available.status === 200, `expected declined request to release dates, got ${available.status}`);
  });

  await check("admin can cancel a pending request and release dates", async () => {
    const arrival = nextWeekdayIso(5, 90);
    const departure = addDaysIso(arrival, 2);
    const response = await request(context, "POST", "/api/bookings", {
      arrival,
      departure,
      guests: 2,
      name: "Canceled Hold",
      email: "cancel@example.com",
      phone: "5559990000"
    });
    assert(response.status === 201, `expected request 201, got ${response.status}`);
    const booking = response.body.reservation;

    const blocked = await quote(context, arrival, departure);
    assert(blocked.status === 400, `expected pending request to block dates, got ${blocked.status}`);

    const canceled = await request(context, "PATCH", `/api/admin/reservations/${booking.id}`, {
      status: "canceled",
      paymentStatus: "canceled"
    });
    assert(canceled.status === 200, `expected cancel 200, got ${canceled.status}`);
    assert(canceled.body.status === "canceled", `expected canceled, got ${canceled.body.status}`);

    const available = await quote(context, arrival, departure);
    assert(available.status === 200, `expected canceled request to release dates, got ${available.status}`);
  });

  await check("admin can archive and delete local booking activity", async () => {
    const arrival = nextWeekdayIso(4, 118);
    const departure = addDaysIso(arrival, 2);
    const response = await request(context, "POST", "/api/bookings", {
      arrival,
      departure,
      guests: 2,
      name: "Archive Delete",
      email: "archive-delete@example.com",
      phone: "5551112222"
    });
    assert(response.status === 201, `expected request 201, got ${response.status}`);
    const booking = response.body.reservation;

    const archived = await request(context, "PATCH", `/api/admin/reservations/${encodeURIComponent(booking.id)}`, {
      archived: true,
      archiveReason: "Regression archive"
    });
    assert(archived.status === 200, `expected archive 200, got ${archived.status}`);
    assert(archived.body.archivedAt, "expected archivedAt to be set");

    const deleted = await request(context, "DELETE", `/api/admin/reservations/${encodeURIComponent(booking.id)}`);
    assert(deleted.status === 200, `expected delete 200, got ${deleted.status}`);
    const reservations = await request(context, "GET", "/api/admin/reservations");
    assert(!reservations.body.reservations.some((item) => item.id === booking.id), "expected deleted reservation to be removed");
    const available = await quote(context, arrival, departure);
    assert(available.status === 200, `expected deleted reservation to release dates, got ${available.status}`);
  });

  await check("expired payment holds do not block future quotes", async () => {
    const arrival = nextWeekdayIso(3, 95);
    const departure = addDaysIso(arrival, 2);
    const storePath = path.join(context.dataDir, "reservations.json");
    const store = JSON.parse(await readFile(storePath, "utf8"));
    store.reservations.push({
      id: "expired-hold",
      arrival,
      departure,
      status: "pending_payment",
      paymentStatus: "deposit_due",
      holdExpiresAt: "2000-01-01T00:00:00.000Z",
      guest: { name: "Expired Hold", email: "expired@example.com", phone: "5550000000", guests: 2 },
      quote: { total: 690, currency: "USD" },
      createdAt: "2000-01-01T00:00:00.000Z",
      updatedAt: "2000-01-01T00:00:00.000Z"
    });
    await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`);

    const response = await quote(context, arrival, departure);
    assert(response.status === 200, `expected expired hold to be ignored, got ${response.status}`);
  });
}

async function assertLiveStripeGuard() {
  await check("live Stripe keys are blocked by default", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "sixth14th-live-guard-"));
    const port = await getOpenPort();
    const child = spawn(process.execPath, [serverPath], {
      cwd: rootDir,
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        HOST: "127.0.0.1",
        PORT: String(port),
        STRIPE_SECRET_KEY: "sk_live_regression_not_a_real_key",
        ALLOW_LIVE_STRIPE: ""
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    const code = await waitForExit(child, 3000);
    await rm(dataDir, { recursive: true, force: true });
    assert(code !== 0, "server should exit when a live key is configured without unlock");
    assert(output.includes("Live Stripe keys are disabled"), "live key guard message was not emitted");
  });
}

async function startApp(envOverrides = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "sixth14th-regression-"));
  const port = await getOpenPort();
  const lodgify = await startLodgifyMock();
  const child = spawn(process.execPath, [serverPath], {
    cwd: rootDir,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      HOST: "127.0.0.1",
      PORT: String(port),
      STAGING_USERNAME: "qa",
      STAGING_PASSWORD: "qa-pass",
      STAGING_LABEL: "Regression staging",
      PUBLIC_BOOKING_ENABLED: "",
      EMAIL_SEND_ENABLED: "",
      EMAIL_FROM: "",
      EMAIL_REPLY_TO: "",
      RESEND_API_KEY: "",
      SMTP_HOST: "",
      SMTP_PORT: "",
      SMTP_SECURE: "",
      SMTP_USER: "",
      SMTP_PASS: "",
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: webhookSecret,
      CRON_SECRET: webhookSecret,
      LODGIFY_API_KEY: lodgify.apiKey,
      LODGIFY_API_BASE_URL: lodgify.baseUrl,
      LODGIFY_SYNC_MONTHS: "6",
      PAYMENT_HOLD_MINUTES: "30",
      DATABASE_URL: "",
      ...envOverrides
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForHealth(baseUrl, child, () => output);
  } catch (error) {
    await lodgify.stop();
    throw error;
  }
  return {
    baseUrl,
    dataDir,
    lodgify,
    async stop() {
      child.kill("SIGTERM");
      await waitForExit(child, 3000).catch(() => {});
      await lodgify.stop();
      await rm(dataDir, { recursive: true, force: true });
    }
  };
}

async function startLodgifyMock() {
  const apiKey = "lodgify-regression-key";
  const bookingId = "lodgify-regression-booking";
  const arrival = nextWeekdayIso(2, 120);
  const departure = addDaysIso(arrival, 3);
  const lastNight = addDaysIso(departure, -1);
  const port = await getOpenPort();
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.headers["x-apikey"] !== apiKey) {
      sendMockJson(res, 401, { error: "Invalid Lodgify API key" });
      return;
    }

    if (url.pathname === "/v2/reservations/bookings") {
      sendMockJson(res, 200, {
        items: [
          {
            id: bookingId,
            status: "booked",
            arrival,
            departure,
            currency_code: "USD",
            total_amount: 690,
            amount_due: 0,
            amount_paid: 690,
            guest: { name: "Synced Lodgify Guest" },
            rooms: [{ people: 2 }],
            created_at: "2026-01-01T00:00:00.000Z",
            check_in: { time: "15:00" },
            check_out: { time: "11:00" }
          }
        ]
      });
      return;
    }

    if (
      url.pathname === "/v2/availability" ||
      url.pathname === "/v2/properties/507939/availability" ||
      url.pathname === "/v2/properties/507939/room-types/574322/availability" ||
      url.pathname === "/v2/properties/507939/rooms/574322/availability"
    ) {
      const rangeStart = url.searchParams.get("start");
      const rangeEnd = url.searchParams.get("end");
      const overlaps = parseDate(rangeStart) <= parseDate(lastNight) && parseDate(arrival) <= parseDate(rangeEnd);
      sendMockJson(res, 200, [
        {
          rental_id: 507939,
          periods: overlaps
            ? [
                {
                  start: arrival,
                  end: lastNight,
                  available: 0,
                  bookings: [{ id: bookingId }]
                }
              ]
            : []
        }
      ]);
      return;
    }

    sendMockJson(res, 404, { error: "Not found" });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  return {
    apiKey,
    baseUrl: `http://127.0.0.1:${port}/v2`,
    bookingId,
    arrival,
    departure,
    stop: () => new Promise((resolve) => server.close(resolve))
  };
}

function sendMockJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function jsonResponse(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function textResponse(status, payload) {
  return new Response(payload, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" }
  });
}

async function quote(context, arrival, departure) {
  return request(context, "POST", "/api/quote", { arrival, departure, guests: 2 });
}

async function request(context, method, pathname, body, options = {}) {
  const headers = {
    ...(options.auth === false ? {} : { authorization: auth }),
    ...(body ? { "content-type": "application/json" } : {}),
    ...(options.headers || {})
  };
  return rawRequest(context, method, pathname, body ? JSON.stringify(body) : undefined, headers, options.parseJson);
}

async function rawRequest(context, method, pathname, body, headers = {}, parseJson = true) {
  const response = await fetch(`${context.baseUrl}${pathname}`, { method, headers, body });
  const text = await response.text();
  let parsed = text;
  if (parseJson !== false && text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

async function check(name, fn) {
  try {
    const value = await fn();
    results.push({ name, ok: true });
    return value;
  } catch (error) {
    results.push({ name, ok: false, detail: error.message });
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function waitForHealth(baseUrl, child, getOutput) {
  const started = Date.now();
  while (Date.now() - started < 8000) {
    if (child.exitCode !== null) {
      throw new Error(`server exited before health check: ${getOutput()}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {
      await delay(100);
    }
  }
  throw new Error(`server did not become healthy: ${getOutput()}`);
}

async function getOpenPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("process did not exit before timeout"));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function nextWeekdayIso(weekday, minimumDaysAway) {
  let date = addDays(startOfUtcDay(new Date()), minimumDaysAway);
  while (date.getUTCDay() !== weekday) {
    date = addDays(date, 1);
  }
  return dateToIso(date);
}

function addDaysIso(iso, days) {
  return dateToIso(addDays(parseDate(iso), days));
}

function parseDate(iso) {
  return new Date(`${iso}T00:00:00.000Z`);
}

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function dateToIso(date) {
  return date.toISOString().slice(0, 10);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
