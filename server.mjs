import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { syncLodgifyData } from "./scripts/lodgify-sync.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const seedDataDir = path.join(__dirname, "data");
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : seedDataDir;
const publicDir = path.join(__dirname, "public");
const settingsPath = path.join(dataDir, "settings.json");
const reservationsPath = path.join(dataDir, "reservations.json");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const paymentHoldMinutes = Number(process.env.PAYMENT_HOLD_MINUTES || 30);
const databaseUrl = process.env.DATABASE_URL || "";
const defaultEmailFrom = "Stay at Sixth & 14th <Stay@Sixth14th.com>";
const defaultEmailReplyTo = "Stay@Sixth14th.com";

let databasePool = null;
let jsonStoreQueue = Promise.resolve();
let settingsStoreQueue = Promise.resolve();

if (isLiveStripeKey(process.env.STRIPE_SECRET_KEY) && process.env.ALLOW_LIVE_STRIPE !== "true") {
  throw new Error("Live Stripe keys are disabled unless ALLOW_LIVE_STRIPE=true is set.");
}

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};
const publicBookingStaticPaths = new Set([
  "/",
  "/index.html",
  "/success.html",
  "/styles.css",
  "/app.js",
  "/tracking.js",
  "/park-slope-6av-14st.webp"
]);

await mkdir(dataDir, { recursive: true });
await ensureDataFile("settings.json", { business: {}, rules: {}, pricing: {}, messages: [] });
if (databaseUrl) {
  await initializeDatabaseStorage();
} else {
  await ensureDataFile("reservations.json", emptyReservationStore(), "reservations.seed.json");
  if (!existsSync(reservationsPath)) {
    await writeJson(reservationsPath, emptyReservationStore());
  }
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, getHealthPayload());
      return;
    }
    if (url.pathname === "/api/cron/send-due-messages") {
      await handleCronSendDueMessages(req, res, url);
      return;
    }
    if (url.pathname === "/api/cron/send-google-ads-conversions") {
      await handleCronSendGoogleAdsConversions(req, res, url);
      return;
    }
    if (requiresStagingAuth(req, url) && !isAuthorized(req)) {
      requestStagingAuth(res);
      return;
    }
    if (req.method === "GET" && paymentLinkParts(url.pathname)) {
      await handlePaymentLink(req, res, url);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      await routeApi(req, res, url);
      return;
    }
    await serveStatic(res, url.pathname);
  } catch (error) {
    if (!error.status) {
      console.error(error);
    }
    sendJson(res, error.status || 500, { error: error.status ? error.message : "Something went wrong." });
  }
}).listen(port, host, () => {
  const displayHost = host === "0.0.0.0" ? "localhost" : host;
  console.log(`Sixth 14th booking app running at http://${displayHost}:${port}`);
});

async function routeApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/config") {
    const settings = await readSettings();
    sendJson(res, 200, {
      business: publicBusiness(settings.business),
      rules: settings.rules,
      pricing: settings.pricing,
      stripeConfigured: Boolean(process.env.STRIPE_SECRET_KEY),
      tracking: publicTrackingConfig(),
      staging: publicStagingStatus()
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/staging/status") {
    sendJson(res, 200, getStagingStatus());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/availability") {
    const start = url.searchParams.get("start");
    const end = url.searchParams.get("end");
    const settings = await readSettings();
    const store = await readReservations();
    sendJson(res, 200, getAvailability(start, end, settings, store));
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/quote") {
    const payload = await readJsonBody(req);
    const settings = await readSettings();
    validateGuestCount(payload.guests, settings);
    const store = await readReservations();
    const quote = quoteStay(payload.arrival, payload.departure, settings, store);
    sendJson(res, 200, quote);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/bookings") {
    const payload = await readJsonBody(req);
    const booking = await createBooking(payload, req);
    sendJson(res, 201, booking);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/stripe/webhook") {
    await handleStripeWebhook(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/reservations") {
    const store = await readReservations();
    sendJson(res, 200, store);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/audit") {
    const store = await readReservations();
    sendJson(res, 200, { auditEvents: recentAuditEvents(store) });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/export") {
    await sendAdminExport(res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/messages") {
    const settings = await readSettings();
    sendJson(res, 200, settings.messages);
    return;
  }

  const messagePreviewParts = messageTemplateSubAction(url.pathname, "preview");
  if (req.method === "POST" && messagePreviewParts) {
    const payload = await readJsonBody(req);
    const preview = await previewMessageTemplate(messagePreviewParts, payload);
    sendJson(res, 200, preview);
    return;
  }

  const messageTestParts = messageTemplateSubAction(url.pathname, "test");
  if (req.method === "POST" && messageTestParts) {
    const payload = await readJsonBody(req);
    const result = await sendMessageTemplateTest(messageTestParts, payload);
    sendJson(res, 200, result);
    return;
  }

  const messageTemplateId = messageTemplateActionId(url.pathname);
  if (req.method === "PATCH" && messageTemplateId) {
    const payload = await readJsonBody(req);
    const message = await updateMessageTemplate(messageTemplateId, payload);
    const settings = await readSettings();
    const queue = await refreshMessageQueue(settings);
    sendJson(res, 200, { message, queue });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/admin/message-queue") {
    const settings = await readSettings();
    const queue = await refreshMessageQueue(settings);
    sendJson(res, 200, { queue });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/message-queue/send-due") {
    const result = await sendDueMessageQueue();
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/google-ads-conversions/send") {
    const result = await sendGoogleAdsPurchaseConversions({
      dryRun: url.searchParams.get("dryRun") === "true" || process.env.GOOGLE_ADS_DELIVERY_DRY_RUN === "true"
    });
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/sync-lodgify") {
    const result = await syncLodgify();
    sendJson(res, 200, result);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/admin/blocks") {
    const payload = await readJsonBody(req);
    const block = await createManualBlock(payload);
    sendJson(res, 201, block);
    return;
  }

  const blockId = manualBlockActionId(url.pathname);
  if (req.method === "PATCH" && blockId) {
    const payload = await readJsonBody(req);
    const block = await updateManualBlock(blockId, payload);
    sendJson(res, 200, block);
    return;
  }

  if (req.method === "DELETE" && blockId) {
    const block = await deleteManualBlock(blockId);
    sendJson(res, 200, { deleted: true, block });
    return;
  }

  const approveReservationId = reservationActionId(url.pathname, "approve");
  if (req.method === "POST" && approveReservationId) {
    const result = await approveReservationRequest(approveReservationId, req);
    sendJson(res, 200, result);
    return;
  }

  const declineReservationId = reservationActionId(url.pathname, "decline");
  if (req.method === "POST" && declineReservationId) {
    const result = await declineReservationRequest(declineReservationId);
    sendJson(res, 200, result);
    return;
  }

  const balanceReservationId = reservationActionId(url.pathname, "balance");
  if (req.method === "POST" && balanceReservationId) {
    const result = await createBalancePaymentRequest(balanceReservationId, req);
    sendJson(res, 200, result);
    return;
  }

  const guestReservationId = reservationGuestActionId(url.pathname);
  if (req.method === "PATCH" && guestReservationId) {
    const payload = await readJsonBody(req);
    const reservation = await updateReservationGuest(guestReservationId, payload);
    const settings = await readSettings();
    const queue = await refreshMessageQueueAfterGuestEdit(settings);
    sendJson(res, 200, { reservation, queue });
    return;
  }

  if (req.method === "PATCH" && url.pathname.startsWith("/api/admin/reservations/")) {
    const id = decodeURIComponent(url.pathname.split("/").pop());
    const payload = await readJsonBody(req);
    const reservation = await updateReservation(id, payload);
    sendJson(res, 200, reservation);
    return;
  }

  if (req.method === "DELETE" && url.pathname.startsWith("/api/admin/reservations/")) {
    const id = decodeURIComponent(url.pathname.split("/").pop());
    const reservation = await deleteReservation(id);
    sendJson(res, 200, { deleted: true, reservation });
    return;
  }

  if (req.method === "PATCH" && url.pathname.startsWith("/api/admin/message-queue/")) {
    const id = decodeURIComponent(url.pathname.split("/").pop());
    const payload = await readJsonBody(req);
    const delivery = await updateMessageDelivery(id, payload);
    sendJson(res, 200, delivery);
    return;
  }

  sendJson(res, 404, { error: "Not found." });
}

async function serveStatic(res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const absolute = path.normalize(path.join(publicDir, safePath));
  if (!absolute.startsWith(publicDir)) {
    sendText(res, 403, "Forbidden");
    return;
  }
  try {
    const content = await readFile(absolute);
    res.writeHead(200, { "content-type": mimeTypes[path.extname(absolute)] || "application/octet-stream" });
    res.end(content);
  } catch {
    const fallback = await readFile(path.join(publicDir, "index.html"));
    res.writeHead(200, { "content-type": mimeTypes[".html"] });
    res.end(fallback);
  }
}

async function sendAdminExport(res) {
  const [settings, store] = await Promise.all([readSettings(), readReservations()]);
  const exportedAt = new Date().toISOString();
  sendJsonDownload(res, `sixth14th-booking-export-${exportedAt.slice(0, 10)}.json`, {
    exportedAt,
    settings,
    reservations: store.reservations || [],
    manualBlocks: store.manualBlocks || [],
    availabilityBlocks: store.availabilityBlocks || [],
    googleAdsPurchaseConversions: store.googleAdsPurchaseConversions || [],
    messageQueue: store.messageQueue || [],
    auditEvents: recentAuditEvents(store, 1000)
  });
}

async function createBooking(payload, req) {
  const settings = await readSettings();
  const guest = {
    name: required(payload.name, "Guest name"),
    email: required(payload.email, "Guest email"),
    phone: required(payload.phone, "Guest phone"),
    guests: Number(payload.guests || 1),
    notes: String(payload.notes || "")
  };
  if (!guest.email.includes("@")) {
    throw userError("Please enter a valid email address.");
  }
  validateGuestCount(guest.guests, settings);

  let reservation;

  await updateReservationStore((store) => {
    const quote = quoteStay(payload.arrival, payload.departure, settings, store);
    const now = new Date().toISOString();
    reservation = {
      id: randomUUID(),
      arrival: payload.arrival,
      departure: payload.departure,
      status: "pending_host_approval",
      paymentStatus: "awaiting_host_approval",
      holdExpiresAt: null,
      guest,
      quote,
      stripeCheckoutSessionId: null,
      stripeCheckoutUrl: null,
      stripePaymentIntentId: null,
      amountPaid: 0,
      attribution: sanitizeAttribution(payload.attribution),
      createdAt: now,
      updatedAt: now
    };
    store.reservations.push(reservation);
    addAuditEvent(store, "booking.requested", `Booking request from ${guest.name}`, {
      reservationId: reservation.id,
      guestEmail: guest.email,
      dates: reservationDateRange(reservation),
      total: reservation.quote?.total
    });
    return reservation;
  });

  await notifyOwner("New booking request", [
    `${guest.name} requested ${reservationDateRange(reservation)}.`,
    `Email: ${guest.email}`,
    `Phone: ${guest.phone}`,
    `Guests: ${guest.guests}`,
    `Quoted total: ${formatCurrency(reservation.quote?.total, reservation.quote?.currency)}`
  ], reservation);

  return {
    reservation,
    checkoutUrl: null,
    demoMode: false,
    message: "Thank you for your booking request. When approved, you will be emailed a link to make a deposit and secure your booking."
  };
}

function sanitizeAttribution(attribution = {}) {
  if (!attribution || typeof attribution !== "object" || Array.isArray(attribution)) return {};
  const allowedKeys = [
    "gclid",
    "gbraid",
    "wbraid",
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "landingPage",
    "capturedAt"
  ];
  const clean = {};
  for (const key of allowedKeys) {
    if (typeof attribution[key] !== "string") continue;
    const value = attribution[key].trim().slice(0, 500);
    if (value) clean[key] = value;
  }
  return clean;
}

async function approveReservationRequest(id, req) {
  const settings = await readSettings();
  const payload = await readJsonBody(req);
  const specialOfferTotal = parseOptionalMoney(payload?.specialOfferTotal, "Preferred total");
  const reservation = await findReservation(id);
  if (reservation.status !== "pending_host_approval") {
    throw userError("Only pending booking requests can be approved.", 400);
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    const updated = await mutateReservation(id, (item) => {
      if (item.status !== "pending_host_approval") {
        throw userError("Only pending booking requests can be approved.", 400);
      }
      applySpecialOfferToReservation(item, settings, specialOfferTotal);
      item.status = "demo_hold";
      item.paymentStatus = "demo_no_payment";
      item.holdExpiresAt = null;
    });
    await appendAuditEvent("booking.approved_demo", `Approved demo booking for ${updated.guest?.name || "Guest"}`, {
      reservationId: updated.id,
      dates: reservationDateRange(updated)
    });
    await notifyOwner("Booking approved in demo mode", [
      `${updated.guest?.name || "Guest"} was approved in demo mode.`,
      `Dates: ${reservationDateRange(updated)}`
    ], updated);
    await syncReservationCalendarEvent(updated);
    return {
      reservation: updated,
      checkoutUrl: null,
      demoMode: true,
      message: "Request approved in demo mode. Add a Stripe test key to create deposit links."
    };
  }

  const pricedReservation = applySpecialOfferToReservation(cloneReservation(reservation), settings, specialOfferTotal);
  const session = await createStripeCheckoutSession(pricedReservation, settings, req, "deposit");
  await mutateReservation(id, (item) => {
    if (item.status !== "pending_host_approval") {
      throw userError("Only pending booking requests can be approved.", 400);
    }
    applySpecialOfferToReservation(item, settings, specialOfferTotal);
    item.status = "pending_payment";
    item.paymentStatus = "deposit_due";
    item.holdExpiresAt = addMinutes(new Date(), paymentHoldMinutes).toISOString();
    item.stripeCheckoutSessionId = session.id;
    item.stripeCheckoutUrl = session.url;
    item.depositPaymentToken = item.depositPaymentToken || createPaymentToken();
  });
  const updated = await prepareDepositEmail(id, settings);
  await appendAuditEvent("booking.approved", `Approved booking request for ${updated.guest?.name || "Guest"}`, {
    reservationId: updated.id,
    dates: reservationDateRange(updated),
    depositEmailStatus: updated.depositEmail?.status || "none"
  });
  await notifyOwner("Booking approved", [
    `${updated.guest?.name || "Guest"} was approved.`,
    `Dates: ${reservationDateRange(updated)}`,
    `Deposit email: ${updated.depositEmail?.status || "none"}`
  ], updated);

  return {
    reservation: updated,
    checkoutUrl: session.url,
    email: updated.depositEmail || null,
    demoMode: false,
    message: depositEmailResultMessage(updated.depositEmail)
  };
}

async function createBalancePaymentRequest(id, req) {
  const settings = await readSettings();
  const reservation = await findReservation(id);
  if (reservation.status !== "booked") {
    throw userError("Only booked reservations can receive a balance link.", 400);
  }
  const balanceDue = remainingBalance(reservation);
  if (balanceDue <= 0 || reservation.paymentStatus === "paid_in_full") {
    throw userError("This reservation does not have a remaining balance.", 400);
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return {
      reservation,
      checkoutUrl: null,
      demoMode: true,
      message: "Add a Stripe test key to create balance payment links."
    };
  }

  const session = await createStripeCheckoutSession(reservation, settings, req, "balance");
  await mutateReservation(id, (item) => {
    if (item.status !== "booked") {
      throw userError("Only booked reservations can receive a balance link.", 400);
    }
    item.paymentStatus = "balance_due";
    item.balanceCheckoutSessionId = session.id;
    item.balanceCheckoutUrl = session.url;
    item.balancePaymentToken = item.balancePaymentToken || createPaymentToken();
    item.balanceDueCreatedAt = new Date().toISOString();
  });
  const updated = await prepareBalanceEmail(id, settings);
  await appendAuditEvent("payment.balance_link_created", `Created balance link for ${updated.guest?.name || "Guest"}`, {
    reservationId: updated.id,
    balanceEmailStatus: updated.balanceEmail?.status || "none",
    balanceDue: remainingBalance(updated)
  });
  await notifyOwner("Balance link created", [
    `Balance link created for ${updated.guest?.name || "Guest"}.`,
    `Dates: ${reservationDateRange(updated)}`,
    `Balance due: ${formatCurrency(remainingBalance(updated), updated.quote?.currency)}`,
    `Email status: ${updated.balanceEmail?.status || "none"}`
  ], updated);

  return {
    reservation: updated,
    checkoutUrl: session.url,
    email: updated.balanceEmail || null,
    demoMode: false,
    message: balanceEmailResultMessage(updated.balanceEmail)
  };
}

async function declineReservationRequest(id) {
  const updated = await mutateReservation(id, (reservation) => {
    if (reservation.status !== "pending_host_approval") {
      throw userError("Only pending booking requests can be declined.", 400);
    }
    reservation.status = "declined";
    reservation.paymentStatus = "declined";
    reservation.holdExpiresAt = null;
  });
  await appendAuditEvent("booking.declined", `Declined booking request for ${updated.guest?.name || "Guest"}`, {
    reservationId: updated.id,
    dates: reservationDateRange(updated)
  });
  await notifyOwner("Booking request declined", [
    `${updated.guest?.name || "Guest"} was declined.`,
    `Dates: ${reservationDateRange(updated)}`
  ], updated);
  return {
    reservation: updated,
    message: "Booking request declined and dates released."
  };
}

async function createStripeCheckoutSession(reservation, settings, req, paymentType = "deposit") {
  const baseUrl = process.env.PUBLIC_BASE_URL || `http://${req.headers.host || `localhost:${port}`}`;
  const amount = paymentType === "balance" ? remainingBalance(reservation) : reservation.quote.depositDue;
  const paymentLabel = paymentType === "balance" ? "Balance" : "Deposit";
  const body = new URLSearchParams();
  body.set("mode", "payment");
  body.set("success_url", `${baseUrl}/success.html?booking=${encodeURIComponent(reservation.id)}`);
  body.set("cancel_url", `${baseUrl}/?booking_cancelled=${encodeURIComponent(reservation.id)}`);
  body.set("customer_email", reservation.guest.email);
  body.set("metadata[booking_id]", reservation.id);
  body.set("metadata[payment_type]", paymentType);
  body.set("payment_intent_data[metadata][booking_id]", reservation.id);
  body.set("payment_intent_data[metadata][payment_type]", paymentType);
  const metadata = stripeAttributionMetadata(reservation, paymentType);
  for (const [key, value] of Object.entries(metadata)) {
    body.set(`metadata[${key}]`, value);
    body.set(`payment_intent_data[metadata][${key}]`, value);
  }
  body.set("line_items[0][quantity]", "1");
  body.set("line_items[0][price_data][currency]", settings.pricing.currency.toLowerCase());
  body.set("line_items[0][price_data][unit_amount]", String(toCents(amount)));
  body.set("line_items[0][price_data][product_data][name]", `${paymentLabel} for ${settings.business.siteName}`);
  body.set(
    "line_items[0][price_data][product_data][description]",
    `${reservation.arrival} to ${reservation.departure}`
  );

  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded"
    },
    body
  });
  const data = await response.json();
  if (!response.ok) {
    throw userError(data.error?.message || "Stripe could not create checkout.");
  }
  return data;
}

async function handlePaymentLink(req, res, url) {
  const link = paymentLinkParts(url.pathname);
  if (!link) {
    sendPaymentNotice(
      res,
      404,
      "Payment link not found",
      "We could not find this payment link. Please use the newest link from your email or reply to us for help."
    );
    return;
  }

  let reservation;
  try {
    reservation = await findReservationForPaymentLink(link);
  } catch (error) {
    if (error.status === 404) {
      sendPaymentNotice(
        res,
        404,
        "Payment link not found",
        "We could not find this payment link. Please use the newest link from your email or reply to us for help."
      );
      return;
    }
    throw error;
  }

  if (["canceled", "declined"].includes(reservation.status) || ["canceled", "declined"].includes(reservation.paymentStatus)) {
    sendPaymentNotice(
      res,
      410,
      "Payment link no longer active",
      "This booking was canceled or replaced during testing, so this payment link has been turned off. Please use the newest link from your latest email."
    );
    return;
  }

  if (
    link.type === "deposit" &&
    (reservation.status === "booked" || ["deposit_paid", "paid_in_full"].includes(reservation.paymentStatus))
  ) {
    sendPaymentNotice(
      res,
      200,
      "Deposit already received",
      "Thank you. This booking is already secured. We will send the balance link separately if a balance is due."
    );
    return;
  }

  if (link.type === "deposit" && isExpiredHold(reservation)) {
    sendPaymentNotice(res, 410, "Payment link expired", "This payment hold has expired. Please contact us if you still want these dates.");
    return;
  }

  if (link.type === "balance" && reservation.paymentStatus === "paid_in_full") {
    sendPaymentNotice(res, 200, "Balance already paid", "Thank you. This booking is already paid in full.");
    return;
  }

  if (link.type === "balance") {
    const balanceDue = remainingBalance(reservation);
    if (balanceDue <= 0) {
      sendPaymentNotice(res, 200, "Balance already paid", "Thank you. This booking is already paid in full.");
      return;
    }
    if (!process.env.STRIPE_SECRET_KEY) {
      sendPaymentNotice(
        res,
        503,
        "Payment link not ready",
        "Online payments are not configured right now. Please reply to your latest email and we will help."
      );
      return;
    }

    const settings = await readSettings();
    const session = await createStripeCheckoutSession(reservation, settings, req, "balance");
    await mutateReservation(reservation.id, (item) => {
      item.paymentStatus = "balance_due";
      item.balanceCheckoutSessionId = session.id;
      item.balanceCheckoutUrl = session.url;
      item.balanceStripeCheckoutSessionRefreshedAt = new Date().toISOString();
    });
    await appendAuditEvent("payment.balance_checkout_created", `Created fresh balance checkout for ${reservation.guest?.name || "Guest"}`, {
      reservationId: reservation.id,
      balanceDue,
      checkoutSessionId: session.id
    });
    redirect(res, session.url);
    return;
  }

  const checkoutUrl = link.type === "balance" ? reservation.balanceCheckoutUrl : reservation.stripeCheckoutUrl;
  if (!checkoutUrl) {
    sendPaymentNotice(
      res,
      404,
      "Payment link not ready",
      "This payment link has not been created yet. Please use the newest link from your email or reply to us for help."
    );
    return;
  }

  redirect(res, checkoutUrl);
}

async function prepareDepositEmail(id, settings) {
  const reservation = await findReservation(id);
  const draft = buildDepositEmail(reservation, settings);
  const result = await sendEmailMessage(draft);
  if (result.status === "failed") {
    await notifyOwner("Deposit email failed", [
      `Deposit email failed for ${reservation.guest?.name || "Guest"}.`,
      `Guest email: ${reservation.guest?.email || "missing"}`,
      `Error: ${result.error || "Unknown email error"}`
    ], reservation);
  }
  return mutateReservation(id, (item) => {
    item.depositEmail = buildEmailRecord(item.depositEmail, draft, result);
    appendReservationEmailLog(item, "deposit_payment_link", draft, result);
  });
}

async function prepareBalanceEmail(id, settings) {
  const reservation = await findReservation(id);
  const draft = buildBalanceEmail(reservation, settings);
  const result = await sendEmailMessage(draft);
  if (result.status === "failed") {
    await notifyOwner("Balance email failed", [
      `Balance email failed for ${reservation.guest?.name || "Guest"}.`,
      `Guest email: ${reservation.guest?.email || "missing"}`,
      `Error: ${result.error || "Unknown email error"}`
    ], reservation);
  }
  return mutateReservation(id, (item) => {
    item.balanceEmail = buildEmailRecord(item.balanceEmail, draft, result);
    appendReservationEmailLog(item, "balance_payment_link", draft, result);
  });
}

function buildEmailRecord(existingEmail, draft, result) {
  return {
    to: draft.to,
    from: draft.from,
    replyTo: draft.replyTo,
    subject: draft.subject,
    text: draft.text,
    status: result.status,
    detail: result.detail || "",
    provider: result.provider || emailProviderName(),
    providerId: result.providerId || null,
    error: result.error || null,
    createdAt: existingEmail?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    sentAt: result.status === "sent" ? new Date().toISOString() : null
  };
}

function appendReservationEmailLog(reservation, type, draft, result) {
  if (!reservation) return;
  const log = Array.isArray(reservation.emailLog) ? reservation.emailLog : [];
  log.push({
    id: randomUUID(),
    type,
    to: draft.to,
    from: draft.from,
    replyTo: draft.replyTo,
    subject: draft.subject,
    status: result.status,
    provider: result.provider || emailProviderName(),
    providerId: result.providerId || null,
    error: result.error || null,
    detail: result.detail || "",
    createdAt: new Date().toISOString(),
    sentAt: result.status === "sent" ? new Date().toISOString() : null
  });
  reservation.emailLog = log.slice(-50);
}

function buildDepositEmail(reservation, settings) {
  const business = settings.business || {};
  const brandName = business.displayName || "Sixth & 14th";
  const houseName = business.propertyName || brandName;
  const guestFirstName = firstName(reservation.guest?.name);
  const dateRange = `${formatLongDate(reservation.arrival)} to ${formatLongDate(reservation.departure)}`;
  const depositAmount = formatCurrency(reservation.quote?.depositDue, reservation.quote?.currency);
  const totalAmount = formatCurrency(reservation.quote?.total, reservation.quote?.currency);
  const holdUntil = reservation.holdExpiresAt ? formatDateTimeForEmail(reservation.holdExpiresAt, settings) : "";
  const contactPhone = business.contactPhone ? ` or text ${business.contactPhone}` : "";
  const link = publicPaymentUrl(reservation, "deposit") || reservation.stripeCheckoutUrl || "";
  const subject = `Deposit link for your ${brandName} booking`;
  const text = [
    `Hi ${guestFirstName},`,
    "",
    `Your booking request for ${houseName} has been approved.`,
    "",
    `Dates: ${dateRange}`,
    `Total: ${totalAmount}`,
    `Deposit due now: ${depositAmount}`,
    "",
    "Please use this secure link to make your deposit and secure the booking:",
    link,
    "",
    holdUntil ? `This payment link will hold the dates until ${holdUntil}.` : null,
    `If you have any questions, just reply to this email${contactPhone}.`,
    "",
    "Warmly,",
    business.ownerName || "Marc",
    brandName
  ].filter((line) => line !== null).join("\n");
  const textWithFooter = appendBookingDetailsFooter(text, reservation, settings);
  const html = `
    <p>Hi ${escapeHtml(guestFirstName)},</p>
    <p>Your booking request for ${escapeHtml(houseName)} has been approved.</p>
    <p>
      <strong>Dates:</strong> ${escapeHtml(dateRange)}<br>
      <strong>Total:</strong> ${escapeHtml(totalAmount)}<br>
      <strong>Deposit due now:</strong> ${escapeHtml(depositAmount)}
    </p>
    <p><a href="${escapeHtml(link)}" style="background:#2e4c3b;color:#ffffff;display:inline-block;padding:12px 18px;text-decoration:none;border-radius:6px;font-weight:700;">Make your secure deposit</a></p>
    ${holdUntil ? `<p>This payment link will hold the dates until ${escapeHtml(holdUntil)}.</p>` : ""}
    <p>If you have any questions, just reply to this email${escapeHtml(contactPhone)}.</p>
    <p>Warmly,<br>${escapeHtml(business.ownerName || "Marc")}<br>${escapeHtml(brandName)}</p>
    ${bookingDetailsFooterHtml(reservation, settings)}
  `;

  return {
    to: reservation.guest.email,
    from: emailFromAddress(),
    replyTo: emailReplyToAddress(),
    subject,
    text: textWithFooter,
    html
  };
}

function buildBalanceEmail(reservation, settings) {
  const business = settings.business || {};
  const brandName = business.displayName || "Sixth & 14th";
  const houseName = business.propertyName || brandName;
  const guestFirstName = firstName(reservation.guest?.name);
  const dateRange = `${formatLongDate(reservation.arrival)} to ${formatLongDate(reservation.departure)}`;
  const balanceAmount = formatCurrency(remainingBalance(reservation), reservation.quote?.currency);
  const totalAmount = formatCurrency(reservation.quote?.total, reservation.quote?.currency);
  const contactPhone = business.contactPhone ? ` or text ${business.contactPhone}` : "";
  const link = publicPaymentUrl(reservation, "balance") || reservation.balanceCheckoutUrl || "";
  const subject = `Balance payment link for your ${brandName} stay`;
  const text = [
    `Hi ${guestFirstName},`,
    "",
    `Your remaining balance for ${houseName} is due before arrival.`,
    "",
    `Dates: ${dateRange}`,
    `Total: ${totalAmount}`,
    `Balance due: ${balanceAmount}`,
    "",
    "Please use this secure link to pay the remaining balance:",
    link,
    "",
    `If you have any questions, just reply to this email${contactPhone}.`,
    "",
    "Thank you,",
    business.ownerName || "Marc",
    brandName
  ].join("\n");
  const textWithFooter = appendBookingDetailsFooter(text, reservation, settings);
  const html = `
    <p>Hi ${escapeHtml(guestFirstName)},</p>
    <p>Your remaining balance for ${escapeHtml(houseName)} is due before arrival.</p>
    <p>
      <strong>Dates:</strong> ${escapeHtml(dateRange)}<br>
      <strong>Total:</strong> ${escapeHtml(totalAmount)}<br>
      <strong>Balance due:</strong> ${escapeHtml(balanceAmount)}
    </p>
    <p><a href="${escapeHtml(link)}" style="background:#2e4c3b;color:#ffffff;display:inline-block;padding:12px 18px;text-decoration:none;border-radius:6px;font-weight:700;">Pay the remaining balance</a></p>
    <p>If you have any questions, just reply to this email${escapeHtml(contactPhone)}.</p>
    <p>Thank you,<br>${escapeHtml(business.ownerName || "Marc")}<br>${escapeHtml(brandName)}</p>
    ${bookingDetailsFooterHtml(reservation, settings)}
  `;

  return {
    to: reservation.guest.email,
    from: emailFromAddress(),
    replyTo: emailReplyToAddress(),
    subject,
    text: textWithFooter,
    html
  };
}

async function sendEmailMessage(message) {
  if (!emailSendingEnabled()) {
    return {
      status: "ready",
      provider: emailProviderName(),
      detail: "Email sending is disabled."
    };
  }

  if (gmailConfigured()) {
    return sendGmailEmail(message);
  }

  if (process.env.RESEND_API_KEY) {
    return sendResendEmail(message);
  }

  if (smtpConfigured()) {
    return sendSmtpEmail(message);
  }

  return {
    status: "failed",
    provider: emailProviderName(),
    error: "Email sending is enabled, but no email provider is configured."
  };
}

async function sendGmailEmail(message) {
  try {
    const token = await fetchGoogleAccessToken();
    const user = encodeURIComponent(process.env.GMAIL_OAUTH_USER || "me");
    const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/${user}/messages/send`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        raw: base64UrlEncode(buildMimeMessage(message))
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        status: "failed",
        provider: "gmail",
        error: data.error?.message || "Gmail could not send the message."
      };
    }
    return {
      status: "sent",
      provider: "gmail",
      providerId: data.id || null,
      detail: "Email sent."
    };
  } catch (error) {
    return {
      status: "failed",
      provider: "gmail",
      error: safeEmailError(error)
    };
  }
}

async function fetchGoogleAccessToken() {
  const body = new URLSearchParams({
    client_id: process.env.GMAIL_OAUTH_CLIENT_ID || "",
    client_secret: process.env.GMAIL_OAUTH_CLIENT_SECRET || "",
    refresh_token: process.env.GMAIL_OAUTH_REFRESH_TOKEN || "",
    grant_type: "refresh_token"
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || "Gmail OAuth token exchange failed.");
  }
  return data.access_token;
}

async function syncReservationCalendarEvent(reservation) {
  if (!calendarSyncEnabled() || !shouldHaveCalendarEvent(reservation)) return null;
  try {
    const token = await fetchGoogleAccessToken();
    const calendarId = encodeURIComponent(calendarTargetId());
    const event = buildReservationCalendarEvent(reservation);
    const existingId = reservation.googleCalendarEvent?.id;
    const url = existingId
      ? `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(existingId)}?sendUpdates=all`
      : `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?sendUpdates=all`;
    const response = await fetch(url, {
      method: existingId ? "PATCH" : "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(event)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error?.message || "Google Calendar could not save the booking event.");
    }
    await mutateReservation(reservation.id, (item) => {
      item.googleCalendarEvent = {
        id: data.id || existingId || null,
        htmlLink: data.htmlLink || item.googleCalendarEvent?.htmlLink || "",
        status: "synced",
        calendarId: calendarTargetId(),
        attendee: calendarInviteEmail(),
        updatedAt: new Date().toISOString(),
        error: null
      };
    });
    await appendAuditEvent("calendar.event_synced", `Synced calendar event for ${reservation.guest?.name || "Guest"}`, {
      reservationId: reservation.id,
      calendarId: calendarTargetId(),
      eventId: data.id || existingId || null
    });
    return data;
  } catch (error) {
    await mutateReservation(reservation.id, (item) => {
      item.googleCalendarEvent = {
        ...(item.googleCalendarEvent || {}),
        status: "failed",
        calendarId: calendarTargetId(),
        attendee: calendarInviteEmail(),
        updatedAt: new Date().toISOString(),
        error: safeEmailError(error)
      };
    }).catch(() => {});
    await appendAuditEvent("calendar.event_failed", `Calendar event failed for ${reservation.guest?.name || "Guest"}`, {
      reservationId: reservation.id,
      error: safeEmailError(error)
    }).catch(() => {});
    console.error(`Calendar sync failed: ${safeEmailError(error)}`);
    return null;
  }
}

async function deleteReservationCalendarEvent(reservation) {
  const eventId = reservation?.googleCalendarEvent?.id;
  if (!calendarSyncEnabled() || !eventId) return null;
  try {
    const token = await fetchGoogleAccessToken();
    const calendarId = encodeURIComponent(reservation.googleCalendarEvent.calendarId || calendarTargetId());
    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events/${encodeURIComponent(eventId)}?sendUpdates=all`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` }
    });
    if (!response.ok && response.status !== 410 && response.status !== 404) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error?.message || "Google Calendar could not delete the booking event.");
    }
    await mutateReservation(reservation.id, (item) => {
      item.googleCalendarEvent = {
        ...(item.googleCalendarEvent || {}),
        status: "deleted",
        deletedAt: new Date().toISOString(),
        error: null
      };
    });
    await appendAuditEvent("calendar.event_deleted", `Deleted calendar event for ${reservation.guest?.name || "Guest"}`, {
      reservationId: reservation.id,
      eventId
    });
    return true;
  } catch (error) {
    await appendAuditEvent("calendar.event_delete_failed", `Calendar event delete failed for ${reservation.guest?.name || "Guest"}`, {
      reservationId: reservation.id,
      eventId,
      error: safeEmailError(error)
    }).catch(() => {});
    console.error(`Calendar delete failed: ${safeEmailError(error)}`);
    return null;
  }
}

function buildReservationCalendarEvent(reservation) {
  const guest = reservation.guest || {};
  const currency = reservation.quote?.currency || "USD";
  const balance = remainingBalance(reservation);
  const summary = `${guest.name || "Guest"} - Sixth & 14th stay`;
  const description = [
    `Reservation: ${reservation.id}`,
    `Guest: ${guest.name || "Guest"}`,
    `Email: ${guest.email || ""}`,
    `Phone: ${guest.phone || ""}`,
    `Guests: ${guest.guests || ""}`,
    `Dates: ${reservationDateRange(reservation)}`,
    `Status: ${reservation.status || ""}`,
    `Payment: ${reservation.paymentStatus || ""}`,
    `Total: ${formatCurrency(reservation.quote?.total, currency)}`,
    `Balance remaining: ${formatCurrency(balance, currency)}`,
    guest.notes ? `Notes: ${guest.notes}` : ""
  ].filter(Boolean).join("\n");
  return {
    summary,
    description,
    location: "531 Sixth Avenue, Brooklyn, NY",
    start: { date: reservation.arrival },
    end: { date: reservation.departure },
    attendees: [{ email: calendarInviteEmail() }],
    reminders: { useDefault: true },
    extendedProperties: {
      private: {
        reservationId: reservation.id,
        source: "sixth14th-booking"
      }
    }
  };
}

function shouldHaveCalendarEvent(reservation) {
  if (!reservation || reservation.source === "lodgify") return false;
  if (!reservation.arrival || !reservation.departure) return false;
  if (reservation.archivedAt) return false;
  return ["booked", "demo_hold"].includes(reservation.status);
}

function buildMimeMessage(message) {
  const boundary = `sixth14th-${randomUUID()}`;
  const headers = [
    `From: ${message.from}`,
    `To: ${message.to}`,
    message.replyTo ? `Reply-To: ${message.replyTo}` : "",
    `Subject: ${mimeHeader(message.subject || "")}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`
  ].filter(Boolean);
  const text = message.text || stripHtml(message.html || "");
  const html = message.html || escapeHtml(text).replace(/\n/g, "<br>");
  return [
    ...headers,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    text,
    "",
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    html,
    "",
    `--${boundary}--`,
    ""
  ].join("\r\n");
}

function base64UrlEncode(value) {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function mimeHeader(value) {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function stripHtml(value) {
  return String(value || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n").replace(/<[^>]+>/g, "").trim();
}

async function sendResendEmail(message) {
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        from: message.from,
        to: [message.to],
        subject: message.subject,
        html: message.html,
        text: message.text,
        reply_to: message.replyTo
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return {
        status: "failed",
        provider: "resend",
        error: data.message || data.error || "The email provider could not send the message."
      };
    }
    return {
      status: "sent",
      provider: "resend",
      providerId: data.id || null,
      detail: "Email sent."
    };
  } catch (error) {
    return {
      status: "failed",
      provider: "resend",
      error: safeEmailError(error)
    };
  }
}

async function sendSmtpEmail(message) {
  try {
    const { default: nodemailer } = await import("nodemailer");
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: smtpSecure(),
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });
    const info = await transporter.sendMail({
      from: message.from,
      to: message.to,
      replyTo: message.replyTo,
      subject: message.subject,
      text: message.text,
      html: message.html
    });
    return {
      status: "sent",
      provider: "smtp",
      providerId: info.messageId || null,
      detail: "Email sent."
    };
  } catch (error) {
    return {
      status: "failed",
      provider: "smtp",
      error: safeEmailError(error)
    };
  }
}

function safeEmailError(error) {
  return error?.message || "The email provider could not send the message.";
}

function depositEmailResultMessage(email) {
  if (!email) return "Deposit link created.";
  if (email.status === "sent") {
    return "Deposit link created and emailed to the guest.";
  }
  if (email.status === "failed") {
    return "Deposit link created, but the email could not be sent. Use the saved link in Admin.";
  }
  return "Deposit link created. Email is ready, but sending is disabled.";
}

function balanceEmailResultMessage(email) {
  if (!email) return "Balance link created.";
  if (email.status === "sent") {
    return "Balance link created and emailed to the guest.";
  }
  if (email.status === "failed") {
    return "Balance link created, but the email could not be sent. Use the saved link in Admin.";
  }
  return "Balance link created. Email is ready, but sending is disabled.";
}

async function handleStripeWebhook(req, res) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    sendJson(res, 400, { error: "Stripe webhook secret is not configured." });
    return;
  }
  const rawBody = await readRawBody(req);
  const signature = req.headers["stripe-signature"];
  if (!verifyStripeSignature(rawBody, signature, secret)) {
    sendJson(res, 400, { error: "Invalid Stripe signature." });
    return;
  }
  const event = JSON.parse(rawBody.toString("utf8"));
  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const bookingId = session.metadata?.booking_id;
    if (bookingId) {
      const paymentType = session.metadata?.payment_type || "deposit";
      const updated = await markCheckoutSessionCompleted(bookingId, session, paymentType);
      if (paymentType === "deposit") {
        await preparePurchaseConversionRecordSafe(updated, session);
      }
      await syncReservationCalendarEvent(updated);
      await appendAuditEvent(paymentType === "balance" ? "payment.balance_paid" : "payment.deposit_paid", `${paymentType === "balance" ? "Balance" : "Deposit"} paid by ${updated.guest?.name || "Guest"}`, {
        reservationId: updated.id,
        amountPaid: updated.amountPaid,
        paymentStatus: updated.paymentStatus
      });
      await notifyOwner(paymentType === "balance" ? "Balance paid" : "Deposit paid", [
        `${updated.guest?.name || "Guest"} paid ${paymentType === "balance" ? "the balance" : "a deposit"}.`,
        `Dates: ${reservationDateRange(updated)}`,
        `Payment status: ${updated.paymentStatus}`,
        `Amount paid total: ${formatCurrency(updated.amountPaid, updated.quote?.currency)}`
      ], updated);
    }
  }
  sendJson(res, 200, { received: true });
}

async function markCheckoutSessionCompleted(bookingId, session, paymentType) {
  const paidAmount = centsToDollars(session.amount_total || 0);
  const completedAt = new Date().toISOString();
  return mutateReservation(bookingId, (reservation) => {
    const total = Number(reservation.quote?.total || 0);

    if (paymentType === "balance") {
      const alreadyApplied = reservation.balanceStripePaymentIntentId === session.payment_intent;
      reservation.balanceCheckoutSessionId = reservation.balanceCheckoutSessionId || session.id;
      reservation.balanceStripeCheckoutSessionId = session.id;
      reservation.balanceStripePaymentIntentId = session.payment_intent;
      reservation.balancePaidAt = reservation.balancePaidAt || completedAt;
      reservation.holdExpiresAt = null;
      reservation.status = "booked";
      if (!alreadyApplied) {
        reservation.amountPaid = roundMoney(Math.min(total, Number(reservation.amountPaid || 0) + paidAmount));
      }
      reservation.paymentStatus = "paid_in_full";
      return;
    }

    reservation.status = "booked";
    reservation.stripeCheckoutSessionId = session.id;
    reservation.stripePaymentIntentId = session.payment_intent;
    reservation.holdExpiresAt = null;
    if (reservation.paymentStatus !== "paid_in_full") {
      reservation.amountPaid = paidAmount;
      reservation.paymentStatus = paidAmount >= total ? "paid_in_full" : "deposit_paid";
    }
  });
}

async function preparePurchaseConversionRecordSafe(reservation, session) {
  try {
    const record = await preparePurchaseConversionRecord(reservation, session);
    await appendAuditEvent("ads.purchase_conversion_prepared", `Prepared purchase conversion for ${reservation.guest?.name || "Guest"}`, {
      reservationId: reservation.id,
      deliveryStatus: record.deliveryStatus,
      clickIdType: record.googleClickIdType || null
    });
    return record;
  } catch (error) {
    console.error(`Purchase conversion preparation failed: ${safeEmailError(error)}`);
    await appendAuditEvent("ads.purchase_conversion_failed", `Purchase conversion preparation failed for ${reservation.guest?.name || "Guest"}`, {
      reservationId: reservation.id,
      error: safeEmailError(error)
    }).catch(() => {});
    return null;
  }
}

async function preparePurchaseConversionRecord(reservation, session) {
  let preparedRecord;
  await updateReservationStore((store) => {
    const conversions = Array.isArray(store.googleAdsPurchaseConversions) ? store.googleAdsPurchaseConversions : [];
    const existing = conversions.find((item) => item?.bookingId === reservation.id);
    if (existing) {
      preparedRecord = existing;
      store.googleAdsPurchaseConversions = conversions;
      return existing;
    }

    const click = availableGoogleClickId(reservation.attribution);
    const now = new Date().toISOString();
    preparedRecord = {
      id: randomUUID(),
      bookingId: reservation.id,
      orderId: reservation.id,
      conversionAction: "purchase",
      value: roundMoney(Number(reservation.quote?.total || 0)),
      currency: "USD",
      googleClickId: click.value || null,
      googleClickIdType: click.type || null,
      conversionTimestamp: now,
      deliveryStatus: click.value ? "pending_delivery" : "skipped_no_click_id",
      deliveryAttempts: 0,
      stripeCheckoutSessionId: session.id || null,
      stripePaymentIntentId: session.payment_intent || null,
      attribution: safeAttributionFields(reservation.attribution),
      createdAt: now,
      updatedAt: now
    };
    conversions.push(preparedRecord);
    store.googleAdsPurchaseConversions = conversions;
    addAuditEvent(store, "ads.purchase_conversion_recorded", "Recorded prepared Google Ads purchase conversion", {
      reservationId: reservation.id,
      orderId: reservation.id,
      deliveryStatus: preparedRecord.deliveryStatus,
      clickIdType: preparedRecord.googleClickIdType
    });
    return preparedRecord;
  });
  return preparedRecord;
}

async function sendGoogleAdsPurchaseConversions({ dryRun = false } = {}) {
  const config = googleAdsDeliveryConfig();
  const store = await readReservations();
  const conversions = Array.isArray(store.googleAdsPurchaseConversions) ? store.googleAdsPurchaseConversions : [];
  const pending = conversions.filter(shouldAttemptGoogleAdsDelivery);

  if (!pending.length) {
    return {
      configured: googleAdsDeliveryConfigured(config),
      dryRun,
      sent: 0,
      failed: 0,
      skipped: 0,
      pending: 0,
      message: "No Google Ads purchase conversions are pending delivery."
    };
  }

  if (!googleAdsDeliveryConfigured(config)) {
    return {
      configured: false,
      dryRun,
      sent: 0,
      failed: 0,
      skipped: 0,
      pending: pending.length,
      message: "Google Ads delivery is not configured."
    };
  }

  const uploadConversions = pending.map((record) => buildGoogleAdsClickConversion(record, config));

  if (dryRun) {
    return {
      configured: true,
      dryRun: true,
      sent: 0,
      failed: 0,
      skipped: 0,
      pending: pending.length,
      request: {
        customerId: config.customerId,
        conversions: uploadConversions,
        partialFailure: true,
        validateOnly: true
      },
      message: "Dry run only. No Google Ads API call was made."
    };
  }

  const accessToken = await fetchGoogleAdsAccessToken(config);
  const response = await uploadGoogleAdsClickConversions(config, accessToken, uploadConversions);
  const resultStatuses = googleAdsUploadResultStatuses(pending, response);
  const now = new Date().toISOString();
  let sent = 0;
  let failed = 0;

  await updateReservationStore((storeToUpdate) => {
    const existing = Array.isArray(storeToUpdate.googleAdsPurchaseConversions)
      ? storeToUpdate.googleAdsPurchaseConversions
      : [];
    for (const status of resultStatuses) {
      const record = existing.find((item) => item?.id === status.id || item?.bookingId === status.bookingId);
      if (!record) continue;
      record.deliveryAttempts = Number(record.deliveryAttempts || 0) + 1;
      record.lastDeliveryAttemptAt = now;
      record.googleAdsJobId = response.jobId || response.job_id || null;
      record.updatedAt = now;
      if (status.delivered) {
        sent += 1;
        record.deliveryStatus = "delivered";
        record.deliveredAt = now;
        record.googleAdsResult = status.result;
        record.deliveryError = null;
      } else {
        failed += 1;
        record.deliveryStatus = "delivery_failed";
        record.deliveryError = status.error || response.partialFailureError?.message || response.partial_failure_error?.message || "Google Ads upload did not return a successful result for this conversion.";
      }
    }
    storeToUpdate.googleAdsPurchaseConversions = existing;
    addAuditEvent(storeToUpdate, "ads.purchase_conversion_delivery", "Sent Google Ads purchase conversion batch", {
      sent,
      failed,
      jobId: response.jobId || response.job_id || null
    });
  });

  return {
    configured: true,
    dryRun: false,
    sent,
    failed,
    skipped: 0,
    pending: Math.max(pending.length - sent - failed, 0),
    jobId: response.jobId || response.job_id || null,
    partialFailureError: response.partialFailureError || response.partial_failure_error || null,
    message: failed
      ? `Delivered ${sent} Google Ads conversion${sent === 1 ? "" : "s"}; ${failed} failed.`
      : `Delivered ${sent} Google Ads conversion${sent === 1 ? "" : "s"}.`
  };
}

function shouldAttemptGoogleAdsDelivery(record) {
  if (!record || !record.googleClickId || !record.googleClickIdType) return false;
  if (!["pending_delivery", "delivery_failed"].includes(record.deliveryStatus)) return false;
  return Number(record.deliveryAttempts || 0) < 5;
}

function googleAdsDeliveryConfig() {
  const customerId = normalizeGoogleAdsCustomerId(process.env.GOOGLE_ADS_CUSTOMER_ID);
  const conversionActionId = normalizeGoogleAdsCustomerId(process.env.GOOGLE_ADS_PURCHASE_CONVERSION_ACTION_ID);
  return {
    apiVersion: process.env.GOOGLE_ADS_API_VERSION || "v25",
    customerId,
    loginCustomerId: normalizeGoogleAdsCustomerId(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID),
    developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN || "",
    oauthClientId: process.env.GOOGLE_ADS_OAUTH_CLIENT_ID || "",
    oauthClientSecret: process.env.GOOGLE_ADS_OAUTH_CLIENT_SECRET || "",
    oauthRefreshToken: process.env.GOOGLE_ADS_OAUTH_REFRESH_TOKEN || "",
    conversionActionResourceName: customerId && conversionActionId
      ? `customers/${customerId}/conversionActions/${conversionActionId}`
      : ""
  };
}

function googleAdsDeliveryConfigured(config = googleAdsDeliveryConfig()) {
  return Boolean(
    config.customerId &&
    config.developerToken &&
    config.oauthClientId &&
    config.oauthClientSecret &&
    config.oauthRefreshToken &&
    config.conversionActionResourceName
  );
}

function buildGoogleAdsClickConversion(record, config = googleAdsDeliveryConfig()) {
  const conversion = {
    conversionAction: config.conversionActionResourceName,
    conversionDateTime: googleAdsDateTime(record.conversionTimestamp),
    conversionValue: Number(record.value || 0),
    currencyCode: record.currency || "USD",
    orderId: record.orderId || record.bookingId
  };
  if (record.googleClickIdType === "gbraid") {
    conversion.gbraid = record.googleClickId;
  } else if (record.googleClickIdType === "wbraid") {
    conversion.wbraid = record.googleClickId;
  } else {
    conversion.gclid = record.googleClickId;
  }
  return conversion;
}

async function fetchGoogleAdsAccessToken(config = googleAdsDeliveryConfig()) {
  const body = new URLSearchParams({
    client_id: config.oauthClientId,
    client_secret: config.oauthClientSecret,
    refresh_token: config.oauthRefreshToken,
    grant_type: "refresh_token"
  });
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || "Google Ads OAuth token exchange failed.");
  }
  return data.access_token;
}

async function uploadGoogleAdsClickConversions(config, accessToken, conversions) {
  const response = await fetch(`https://googleads.googleapis.com/${config.apiVersion}/customers/${config.customerId}:uploadClickConversions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      "developer-token": config.developerToken,
      ...(config.loginCustomerId ? { "login-customer-id": config.loginCustomerId } : {})
    },
    body: JSON.stringify({
      conversions,
      partialFailure: true
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error?.message || data.message || `Google Ads upload failed with status ${response.status}.`);
  }
  return data;
}

function googleAdsUploadResultStatuses(records, response = {}) {
  const results = Array.isArray(response.results) ? response.results : [];
  const partialErrorMessage = response.partialFailureError?.message || response.partial_failure_error?.message || "";
  return records.map((record, index) => {
    const result = results[index] || {};
    const delivered = Boolean(result.conversionDateTime || result.conversion_date_time || result.conversionAction || result.conversion_action);
    return {
      id: record.id,
      bookingId: record.bookingId,
      delivered,
      result,
      error: delivered ? null : partialErrorMessage
    };
  });
}

function verifyStripeSignature(rawBody, signature, secret) {
  if (!signature) return false;
  const parts = Object.fromEntries(signature.split(",").map((part) => part.split("=")));
  if (!parts.t || !parts.v1) return false;
  const signedPayload = `${parts.t}.${rawBody.toString("utf8")}`;
  const expected = createHmac("sha256", secret).update(signedPayload).digest("hex");
  const received = Buffer.from(parts.v1, "hex");
  const computed = Buffer.from(expected, "hex");
  return received.length === computed.length && timingSafeEqual(received, computed);
}

async function createManualBlock(payload) {
  const start = required(payload.start, "Block start");
  const end = required(payload.end, "Block end");
  assertDateRange(start, end);
  let block;
  await updateReservationStore((store) => {
    block = {
      id: randomUUID(),
      start,
      end,
      reason: String(payload.reason || "Manual block"),
      createdAt: new Date().toISOString()
    };
    store.manualBlocks.push(block);
    addAuditEvent(store, "calendar.block_created", `Blocked ${start} to ${end}`, {
      blockId: block.id,
      reason: block.reason
    });
    return block;
  });
  return block;
}

async function updateManualBlock(id, patch) {
  const payload = plainObject(patch);
  let updatedBlock;
  await updateReservationStore((store) => {
    const block = (store.manualBlocks || []).find((item) => item?.id === id);
    if (!block) {
      throw userError("Manual block not found.", 404);
    }
    if (payload.start !== undefined || payload.end !== undefined) {
      const start = required(payload.start || block.start, "Block start");
      const end = required(payload.end || block.end, "Block end");
      assertDateRange(start, end);
      block.start = start;
      block.end = end;
    }
    if (payload.reason !== undefined) {
      block.reason = cleanText(payload.reason || "Manual block", 180);
    }
    if (payload.archived === true && !block.archivedAt) {
      block.archivedAt = new Date().toISOString();
      block.archiveReason = cleanText(payload.archiveReason || "Archived from Admin", 180);
    }
    if (payload.archived === false) {
      block.archivedAt = null;
      block.archiveReason = "";
    }
    block.updatedAt = new Date().toISOString();
    updatedBlock = block;
    addAuditEvent(store, block.archivedAt ? "calendar.block_archived" : "calendar.block_updated", `${block.archivedAt ? "Archived" : "Updated"} block ${block.start} to ${block.end}`, {
      blockId: block.id,
      reason: block.reason,
      archivedAt: block.archivedAt || null
    });
    return block;
  });
  return updatedBlock;
}

async function deleteManualBlock(id) {
  let deletedBlock;
  await updateReservationStore((store) => {
    const index = (store.manualBlocks || []).findIndex((item) => item?.id === id);
    if (index === -1) {
      throw userError("Manual block not found.", 404);
    }
    deletedBlock = store.manualBlocks.splice(index, 1)[0];
    addAuditEvent(store, "calendar.block_deleted", `Deleted block ${deletedBlock.start} to ${deletedBlock.end}`, {
      blockId: deletedBlock.id,
      reason: deletedBlock.reason
    });
    return deletedBlock;
  });
  return deletedBlock;
}

async function syncLodgify() {
  const hasLodgifyApiKey = Boolean(process.env.LODGIFY_API_KEY);
  const hasLodgifyIcalUrl = Boolean(process.env.LODGIFY_ICAL_URL);

  if (!hasLodgifyApiKey && !hasLodgifyIcalUrl) {
    throw userError("Lodgify sync is not configured. Add the Lodgify iCal export URL.");
  }

  const settings = await readSettings();
  try {
    let syncResult;
    await updateReservationStore(async (store) => {
        syncResult = await syncLodgifyData(store, {
          apiKey: process.env.LODGIFY_API_KEY || "",
          months: Number(process.env.LODGIFY_SYNC_MONTHS || 12) || 12,
          apiBaseUrl: process.env.LODGIFY_API_BASE_URL,
          propertyId: process.env.LODGIFY_PROPERTY_ID || settings.business?.lodgifyPropertyId,
          roomTypeId: process.env.LODGIFY_ROOM_TYPE_ID || settings.business?.lodgifyRoomTypeId,
        iCalUrl: process.env.LODGIFY_ICAL_URL
      });
      replaceStoreContents(store, syncResult.store);
      addAuditEvent(store, "lodgify.synced", "Synced Lodgify calendar", {
        importedBookings: syncResult.importedBookings,
        availabilityBlocks: syncResult.availabilityBlocks,
        warnings: syncResult.warnings || []
      });
      return syncResult;
    });
    return {
      importedBookings: syncResult.importedBookings,
      availabilityBlocks: syncResult.availabilityBlocks,
      syncedAt: syncResult.syncedAt,
      warnings: syncResult.warnings || []
    };
  } catch (error) {
    console.error(error);
    throw userError(error.safeMessage || "Lodgify sync failed. Check the Lodgify API key or iCal URL and try again.", 502);
  }
}

async function updateReservation(id, patch) {
  const updated = await mutateReservation(id, (reservation) => {
    Object.assign(
      reservation,
      pick(patch, [
        "status",
        "paymentStatus",
        "holdExpiresAt",
        "stripeCheckoutSessionId",
        "stripeCheckoutUrl",
        "stripePaymentIntentId",
        "balanceCheckoutSessionId",
        "balanceCheckoutUrl",
        "balanceStripeCheckoutSessionId",
        "balanceStripePaymentIntentId",
        "balanceDueCreatedAt",
        "balancePaidAt",
        "balanceEmail",
        "amountPaid",
        "archivedAt",
        "archiveReason"
      ])
    );
    if (patch.archived === true && !reservation.archivedAt) {
      reservation.archivedAt = new Date().toISOString();
    }
    if (patch.archived === false) {
      reservation.archivedAt = null;
      reservation.archiveReason = "";
    }
  });
  await appendAuditEvent(updated.archivedAt ? "booking.archived" : "booking.updated", `${updated.archivedAt ? "Archived" : "Updated"} reservation for ${updated.guest?.name || "Guest"}`, {
    reservationId: updated.id,
    status: updated.status,
    paymentStatus: updated.paymentStatus,
    archivedAt: updated.archivedAt || null
  });
  if (["canceled", "declined"].includes(updated.status) || ["canceled", "declined"].includes(updated.paymentStatus)) {
    await deleteReservationCalendarEvent(updated);
    await notifyOwner("Booking canceled or released", [
      `${updated.guest?.name || "Guest"} was updated to ${updated.status}/${updated.paymentStatus}.`,
      `Dates: ${reservationDateRange(updated)}`
    ], updated);
  } else {
    await syncReservationCalendarEvent(updated);
  }
  return updated;
}

async function deleteReservation(id) {
  const reservationForCalendar = await findReservation(id);
  await deleteReservationCalendarEvent(reservationForCalendar);
  let deletedReservation;
  await updateReservationStore((store) => {
    const index = (store.reservations || []).findIndex((item) => item?.id === id);
    if (index === -1) {
      throw userError("Reservation not found.", 404);
    }
    const reservation = store.reservations[index];
    if (reservation.source === "lodgify" || String(reservation.status || "").startsWith("lodgify_")) {
      throw userError("Lodgify synced reservations cannot be deleted here. Remove or change them in Lodgify, then sync again.");
    }
    deletedReservation = store.reservations.splice(index, 1)[0];
    store.messageQueue = (store.messageQueue || []).filter((delivery) => delivery?.reservationId !== id);
    addAuditEvent(store, "booking.deleted", `Deleted reservation for ${deletedReservation.guest?.name || "Guest"}`, {
      reservationId: deletedReservation.id,
      status: deletedReservation.status,
      paymentStatus: deletedReservation.paymentStatus,
      dates: reservationDateRange(deletedReservation)
    });
    return deletedReservation;
  });
  return deletedReservation;
}

async function updateReservationGuest(id, patch) {
  const payload = plainObject(patch);
  let updatedReservation;
  await updateReservationStore((store) => {
    const reservation = store.reservations.find((item) => item?.id === id);
    if (!reservation) {
      throw userError("Reservation not found.", 404);
    }
    if (reservation.source === "lodgify" || String(reservation.status || "").startsWith("lodgify_")) {
      throw userError("Lodgify synced reservations cannot be edited here.");
    }
    const existingGuest = plainObject(reservation.guest);
    const guest = {
      ...existingGuest,
      name: cleanText(payload.name, 120),
      email: normalizeEmailField(payload.email),
      phone: cleanText(payload.phone, 40),
      notes: cleanText(payload.notes, 1000)
    };
    if (!guest.name) {
      throw userError("Guest name is required.");
    }
    if (guest.email && !guest.email.includes("@")) {
      throw userError("Please enter a valid email address.");
    }
    reservation.guest = guest;
    for (const delivery of store.messageQueue || []) {
      if (delivery?.reservationId === id && !["sent", "skipped"].includes(delivery.status)) {
        delivery.recipientName = guest.name;
        delivery.recipientEmail = guest.email;
      }
    }
    reservation.updatedAt = new Date().toISOString();
    updatedReservation = reservation;
    return reservation;
  });
  await appendAuditEvent("guest.updated", `Updated guest details for ${updatedReservation.guest?.name || "Guest"}`, {
    reservationId: updatedReservation.id,
    guestEmail: updatedReservation.guest?.email
  });
  await syncReservationCalendarEvent(updatedReservation);
  return updatedReservation;
}

async function updateMessageTemplate(id, patch) {
  const payload = plainObject(patch);
  const updatedMessage = await updateSettingsStore((settings) => {
    const messages = Array.isArray(settings.messages) ? settings.messages : [];
    const message = messages.find((item) => item?.id === id);
    if (!message) {
      throw userError("Message template not found.", 404);
    }

    if (Object.prototype.hasOwnProperty.call(payload, "subject")) {
      message.subject = cleanText(payload.subject, 180);
    }
    if (Object.prototype.hasOwnProperty.call(payload, "body")) {
      message.body = cleanText(payload.body, 5000);
    }
    if (Object.prototype.hasOwnProperty.call(payload, "enabled")) {
      message.enabled = Boolean(payload.enabled);
    }
    if (Object.prototype.hasOwnProperty.call(payload, "sendOffset")) {
      Object.assign(message, normalizeMessageTiming(payload.sendOffset));
    }
    message.subject = cleanText(message.subject || message.name || "Guest message", 180);
    if (!message.body) {
      throw userError("Message body is required.");
    }

    message.updatedAt = new Date().toISOString();
    return message;
  });
  await appendAuditEvent("message_template.updated", `Updated message template: ${updatedMessage.name || id}`, {
    messageId: id,
    enabled: updatedMessage.enabled
  });
  return updatedMessage;
}

async function previewMessageTemplate(id, payload) {
  const { message, reservation, settings } = await messageTemplateContext(id, payload?.reservationId);
  const body = appendBookingDetailsFooter(renderMessageBody(message.body || "", reservation, settings), reservation, settings);
  return {
    to: reservation.guest?.email || "",
    recipientName: reservation.guest?.name || "Guest",
    subject: message.subject || message.name,
    body,
    messageName: message.name,
    reservationId: reservation.id
  };
}

async function sendMessageTemplateTest(id, payload) {
  const preview = await previewMessageTemplate(id, payload);
  const to = normalizeEmailField(payload?.email || ownerNotifyEmail());
  if (!to || !to.includes("@")) {
    throw userError("Test recipient email is required.");
  }
  const draft = {
    to,
    from: emailFromAddress(),
    replyTo: emailReplyToAddress(),
    subject: `[Test] ${preview.subject}`,
    text: preview.body,
    html: plainTextEmailHtml(preview.body)
  };
  const result = await sendEmailMessage(draft);
  await appendAuditEvent("message_template.test_sent", `Sent test for ${preview.messageName}`, {
    messageId: id,
    reservationId: preview.reservationId,
    to,
    status: result.status,
    error: result.error || null
  });
  return { ...result, to };
}

async function messageTemplateContext(id, reservationId) {
  const settings = await readSettings();
  const message = (settings.messages || []).find((item) => item?.id === id);
  if (!message) {
    throw userError("Message template not found.", 404);
  }
  const store = await readReservations();
  const reservation = (store.reservations || []).find((item) => item.id === reservationId)
    || (store.reservations || []).find((item) => shouldScheduleMessages(item))
    || (store.reservations || []).find((item) => item.guest?.email);
  if (!reservation) {
    throw userError("No reservation is available for preview.");
  }
  return { message, reservation, settings };
}

function normalizeMessageTiming(sendOffset) {
  const value = String(sendOffset || "");
  const options = {
    immediate: "booking_confirmed",
    "-7d": "seven_days_before_arrival",
    "-2d": "two_days_before_arrival",
    "0d": "arrival_day",
    checkout: "checkout_day",
    "+2d": "two_days_after_departure"
  };
  if (!Object.prototype.hasOwnProperty.call(options, value)) {
    throw userError("Choose a valid message timing.");
  }
  return { sendOffset: value, trigger: options[value] };
}

async function mutateReservation(id, mutator) {
  let updatedReservation;
  await updateReservationStore((store) => {
    const reservation = store.reservations.find((item) => item.id === id);
    if (!reservation) {
      throw userError("Reservation not found.", 404);
    }
    mutator(reservation);
    reservation.updatedAt = new Date().toISOString();
    updatedReservation = reservation;
    return reservation;
  });
  return updatedReservation;
}

async function findReservation(id) {
  const store = await readReservations();
  const reservation = store.reservations.find((item) => item.id === id);
  if (!reservation) {
    throw userError("Reservation not found.", 404);
  }
  return reservation;
}

async function findReservationForPaymentLink(link) {
  const store = await readReservations();
  const tokenField = link.type === "balance" ? "balancePaymentToken" : "depositPaymentToken";
  const reservation = store.reservations.find((item) => item.id === link.id || item[tokenField] === link.id);
  if (!reservation) {
    throw userError("Reservation not found.", 404);
  }
  return reservation;
}

function reservationActionId(pathname, action) {
  const parts = pathname.split("/");
  if (parts.length !== 6 || parts[1] !== "api" || parts[2] !== "admin" || parts[3] !== "reservations") {
    return "";
  }
  if (parts[5] !== action) {
    return "";
  }
  return decodeURIComponent(parts[4]);
}

function reservationGuestActionId(pathname) {
  const match = /^\/api\/admin\/reservations\/([^/]+)\/guest\/?$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : "";
}

function manualBlockActionId(pathname) {
  const match = /^\/api\/admin\/blocks\/([^/]+)\/?$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : "";
}

function messageTemplateActionId(pathname) {
  const match = /^\/api\/admin\/messages\/([^/]+)$/.exec(pathname);
  return match ? decodeURIComponent(match[1]) : "";
}

function messageTemplateSubAction(pathname, action) {
  const match = /^\/api\/admin\/messages\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (!match || match[2] !== action) return "";
  return decodeURIComponent(match[1]);
}

function paymentLinkParts(pathname) {
  const match = /^\/pay\/(deposit|balance)\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  return {
    type: match[1],
    id: decodeURIComponent(match[2])
  };
}

function publicPaymentUrl(reservation, paymentType) {
  const baseUrl = String(process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  if (!baseUrl || !reservation?.id) return "";
  const token = paymentType === "balance" ? reservation.balancePaymentToken : reservation.depositPaymentToken;
  const identifier = token || reservation.id;
  return `${baseUrl}/pay/${paymentType}/${encodeURIComponent(identifier)}`;
}

function createPaymentToken() {
  return randomUUID().replaceAll("-", "").slice(0, 12);
}

async function appendAuditEvent(action, summary, metadata = {}) {
  await updateReservationStore((store) => {
    addAuditEvent(store, action, summary, metadata);
  });
}

function addAuditEvent(store, action, summary, metadata = {}) {
  const events = Array.isArray(store.auditEvents) ? store.auditEvents : [];
  events.unshift({
    id: randomUUID(),
    action,
    summary,
    metadata: plainObject(metadata),
    createdAt: new Date().toISOString()
  });
  store.auditEvents = events.slice(0, 500);
}

function recentAuditEvents(store, limit = 50) {
  return (Array.isArray(store.auditEvents) ? store.auditEvents : [])
    .slice()
    .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
    .slice(0, limit);
}

async function notifyOwner(subject, lines = [], reservation = null) {
  if (!ownerNotificationsEnabled()) return null;
  const to = ownerNotifyEmail();
  if (!to) return null;

  const textLines = [
    String(subject || "Booking alert"),
    "",
    ...lines.filter(Boolean).map(String),
    ...(reservation ? ["", bookingDetailsFooterText(reservation, { business: {}, rules: {}, pricing: reservation.quote || {} })] : [])
  ];
  const message = {
    to,
    from: emailFromAddress(),
    replyTo: emailReplyToAddress(),
    subject: `[Sixth & 14th] ${subject}`,
    text: textLines.join("\n"),
    html: plainTextEmailHtml(textLines.join("\n"))
  };
  const result = await sendEmailMessage(message);
  if (result.status === "failed") {
    console.error(`Owner notification failed: ${result.error || "Unknown email error"}`);
  }
  return result;
}

function ownerNotificationsEnabled() {
  return process.env.OWNER_NOTIFY_ENABLED === "true";
}

function ownerNotifyEmail() {
  return process.env.OWNER_NOTIFY_EMAIL || "marc@lucasand.co";
}

async function updateMessageDelivery(id, patch) {
  const settings = await readSettings();
  await refreshMessageQueue(settings);
  let updatedDelivery;
  await updateReservationStore((store) => {
    const delivery = (store.messageQueue || []).find((item) => item.id === id);
    if (!delivery) {
      throw userError("Message delivery not found.", 404);
    }
    const status = String(patch.status || "");
    if (!["scheduled", "due", "sent", "skipped"].includes(status)) {
      throw userError("Choose a valid message status.");
    }
    delivery.status = status;
    delivery.sentAt = status === "sent" ? new Date().toISOString() : null;
    delivery.updatedAt = new Date().toISOString();
    updatedDelivery = delivery;
    addAuditEvent(store, "message.status_updated", `Marked ${delivery.messageName} ${status}`, {
      deliveryId: delivery.id,
      reservationId: delivery.reservationId,
      status
    });
    return delivery;
  });
  return updatedDelivery;
}

async function sendDueMessageQueue() {
  const settings = await readSettings();
  const queue = await refreshMessageQueue(settings);
  const dueMessages = queue.filter((delivery) => ["due", "failed"].includes(delivery.status));

  if (!dueMessages.length) {
    return {
      sent: 0,
      failed: 0,
      ready: 0,
      message: "No guest messages are due right now.",
      queue
    };
  }

  if (!emailSendingEnabled()) {
    return {
      sent: 0,
      failed: 0,
      ready: dueMessages.length,
      message: emailProviderConfigured()
        ? "Email sending is configured but turned off, so due messages remain queued."
        : "Email sending is not configured yet, so due messages remain queued.",
      queue
    };
  }

  const attempts = [];
  for (const delivery of dueMessages) {
    const draft = buildScheduledMessageEmail(delivery);
    const result = await sendEmailMessage(draft);
    attempts.push({ deliveryId: delivery.id, draft, result });
  }

  let updatedQueue = [];
  const failedAttempts = [];
  await updateReservationStore((store) => {
    const now = new Date().toISOString();
    const deliveries = new Map((store.messageQueue || []).map((delivery) => [delivery.id, delivery]));
    for (const attempt of attempts) {
      const delivery = deliveries.get(attempt.deliveryId);
      if (!delivery) continue;
      delivery.email = buildEmailRecord(delivery.email, attempt.draft, attempt.result);
      const reservation = (store.reservations || []).find((item) => item.id === delivery.reservationId);
      appendReservationEmailLog(reservation, delivery.messageId || "scheduled_message", attempt.draft, attempt.result);
      delivery.updatedAt = now;
      delivery.lastAttemptAt = now;
      if (attempt.result.status === "sent") {
        delivery.status = "sent";
        delivery.sentAt = now;
      } else if (attempt.result.status === "failed") {
        delivery.status = "failed";
        delivery.error = attempt.result.error || "Email send failed.";
        failedAttempts.push(delivery);
      }
      addAuditEvent(store, `message.${delivery.status}`, `${delivery.messageName} ${delivery.status} for ${delivery.recipientName || "Guest"}`, {
        deliveryId: delivery.id,
        reservationId: delivery.reservationId,
        recipientEmail: delivery.recipientEmail,
        error: delivery.error || null
      });
    }
    updatedQueue = store.messageQueue || [];
    return updatedQueue;
  });

  const sent = attempts.filter((attempt) => attempt.result.status === "sent").length;
  const failed = attempts.filter((attempt) => attempt.result.status === "failed").length;
  if (failedAttempts.length) {
    await notifyOwner("Guest message send failed", failedAttempts.map((delivery) => (
      `${delivery.messageName} for ${delivery.recipientName || "Guest"} <${delivery.recipientEmail || "missing"}>: ${delivery.error || "Unknown email error"}`
    )));
  }
  return {
    sent,
    failed,
    ready: 0,
    message: failed
      ? `Sent ${sent} guest message${sent === 1 ? "" : "s"}; ${failed} failed.`
      : `Sent ${sent} guest message${sent === 1 ? "" : "s"}.`,
    queue: updatedQueue
  };
}

async function handleCronSendDueMessages(req, res, url) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Use POST for this automation endpoint." });
    return;
  }
  if (!process.env.CRON_SECRET) {
    sendJson(res, 503, { error: "CRON_SECRET is not configured." });
    return;
  }
  if (!isCronAuthorized(req, url)) {
    sendJson(res, 401, { error: "Unauthorized." });
    return;
  }

  const result = await sendDueMessageQueue();
  sendJson(res, 200, {
    ...result,
    triggeredBy: "cron",
    triggeredAt: new Date().toISOString()
  });
}

async function handleCronSendGoogleAdsConversions(req, res, url) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Use POST for this automation endpoint." });
    return;
  }
  if (!process.env.CRON_SECRET) {
    sendJson(res, 503, { error: "CRON_SECRET is not configured." });
    return;
  }
  if (!isCronAuthorized(req, url)) {
    sendJson(res, 401, { error: "Unauthorized." });
    return;
  }

  const result = await sendGoogleAdsPurchaseConversions({
    dryRun: url.searchParams.get("dryRun") === "true" || process.env.GOOGLE_ADS_DELIVERY_DRY_RUN === "true"
  });
  sendJson(res, 200, {
    ...result,
    triggeredBy: "cron",
    triggeredAt: new Date().toISOString()
  });
}

function isCronAuthorized(req, url) {
  const submitted = req.headers["x-cron-secret"]
    || bearerToken(req.headers.authorization)
    || url.searchParams.get("secret")
    || "";
  return safeEqualString(submitted, process.env.CRON_SECRET || "");
}

function bearerToken(header = "") {
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function buildScheduledMessageEmail(delivery) {
  return {
    to: delivery.recipientEmail,
    from: emailFromAddress(),
    replyTo: emailReplyToAddress(),
    subject: delivery.subject || delivery.messageName,
    text: delivery.body || "",
    html: plainTextEmailHtml(delivery.body || "")
  };
}

function plainTextEmailHtml(text) {
  const paragraphs = String(text || "")
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${linkifyEmailText(paragraph).replaceAll("\n", "<br>")}</p>`);
  return paragraphs.join("\n");
}

function linkifyEmailText(text) {
  const urlPattern = /https?:\/\/[^\s<]+/g;
  let html = "";
  let lastIndex = 0;
  for (const match of String(text || "").matchAll(urlPattern)) {
    const url = match[0];
    html += escapeHtml(text.slice(lastIndex, match.index));
    html += paymentButtonHtml(url) || `<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`;
    lastIndex = match.index + url.length;
  }
  html += escapeHtml(text.slice(lastIndex));
  return html;
}

function paymentButtonHtml(url) {
  let label = "";
  if (/\/pay\/balance\//.test(url)) {
    label = "Pay the remaining balance";
  } else if (/\/pay\/deposit\//.test(url)) {
    label = "Make your secure deposit";
  }
  if (!label) return "";
  return `<a href="${escapeHtml(url)}" style="background:#2e4c3b;color:#ffffff;display:inline-block;padding:12px 18px;text-decoration:none;border-radius:6px;font-weight:700;">${escapeHtml(label)}</a>`;
}

async function replaceReservation(nextReservation) {
  await updateReservationStore((store) => {
    const index = store.reservations.findIndex((item) => item.id === nextReservation.id);
    if (index !== -1) {
      store.reservations[index] = nextReservation;
    }
  });
}

async function refreshMessageQueue(settings, now = new Date()) {
  let queue = [];
  await updateReservationStore((store) => {
    queue = buildMessageQueue(store, settings, now);
    store.messageQueue = queue;
    return queue;
  });
  return queue;
}

async function refreshMessageQueueAfterGuestEdit(settings) {
  try {
    return await refreshMessageQueue(settings);
  } catch (error) {
    console.error("Guest details were saved, but the message queue refresh failed.", error);
    return [];
  }
}

function buildMessageQueue(store, settings, now) {
  const existing = new Map((store.messageQueue || []).filter(Boolean).map((delivery) => [delivery.id, delivery]));
  const messages = (settings.messages || []).filter((message) => message?.enabled);
  const queue = [];

  for (const reservation of store.reservations || []) {
    if (!shouldScheduleMessages(reservation)) continue;
    for (const message of messages) {
      if (!shouldScheduleMessage(message, reservation)) continue;
      const id = `${reservation.id}:${message.id}`;
      const previous = existing.get(id);
      const dueAt = messageDueAt(message, reservation);
      const status = ["sent", "skipped", "failed"].includes(previous?.status)
        ? previous.status
        : new Date(dueAt).getTime() <= now.getTime() ? "due" : "scheduled";
      const body = renderMessageBody(message.body || "", reservation, settings);
      queue.push({
        id,
        reservationId: reservation.id,
        messageId: message.id,
        messageName: message.name,
        status,
        dueAt,
        trigger: message.trigger,
        recipientName: reservation.guest?.name || "Guest",
        recipientEmail: reservation.guest?.email || "",
        subject: message.subject || message.name,
        body: appendBookingDetailsFooter(body, reservation, settings),
        sentAt: status === "sent" ? previous?.sentAt || now.toISOString() : null,
        createdAt: previous?.createdAt || now.toISOString(),
        updatedAt: now.toISOString()
      });
    }
  }

  return queue.sort((a, b) => a.dueAt.localeCompare(b.dueAt) || a.messageName.localeCompare(b.messageName));
}

function shouldScheduleMessages(reservation) {
  if (!reservation || reservation.source === "lodgify") return false;
  if (!reservation.guest?.email) return false;
  return ["booked", "demo_hold"].includes(reservation.status);
}

function shouldScheduleMessage(message, reservation) {
  if (["balance-due", "balance-reminder"].includes(message.id) && reservation.paymentStatus === "paid_in_full") {
    return false;
  }
  return true;
}

function messageDueAt(message, reservation) {
  const trigger = message.trigger || message.sendOffset;
  if (trigger === "booking_confirmed" || message.sendOffset === "immediate") {
    return reservation.updatedAt || reservation.createdAt || new Date().toISOString();
  }
  if (trigger === "seven_days_before_arrival" || message.sendOffset === "-7d") {
    return dateAtUtcHour(addDaysIso(reservation.arrival, -7), 14);
  }
  if (trigger === "two_days_before_arrival" || message.sendOffset === "-2d") {
    return dateAtUtcHour(addDaysIso(reservation.arrival, -2), 14);
  }
  if (trigger === "arrival_day" || message.sendOffset === "0d") {
    return dateAtUtcHour(reservation.arrival, 19);
  }
  if (trigger === "checkout_day" || message.sendOffset === "checkout") {
    return dateAtUtcHour(reservation.departure, 12);
  }
  if (trigger === "two_days_after_departure" || message.sendOffset === "+2d") {
    return dateAtUtcHour(addDaysIso(reservation.departure, 2), 15);
  }
  return reservation.updatedAt || reservation.createdAt || new Date().toISOString();
}

function renderMessageBody(template, reservation, settings) {
  const business = settings.business || {};
  const currency = reservation.quote?.currency || settings.pricing?.currency || "USD";
  const values = {
    guestFirstName: firstName(reservation.guest?.name),
    guestName: reservation.guest?.name || "Guest",
    guestCount: String(reservation.guest?.guests || 1),
    houseName: business.propertyName || business.siteName || "Sixth 14th",
    housePhone: business.contactPhone || "the phone number in your confirmation email",
    ownerName: business.ownerName || "Marc",
    ownerUrl: business.ownerUrl || "",
    arrivalDate: formatLongDate(reservation.arrival),
    departureDate: formatLongDate(reservation.departure),
    bookingDate: formatLongDate((reservation.createdAt || "").slice(0, 10)),
    nights: String(reservation.quote?.nights || nightsBetween(reservation.arrival, reservation.departure)),
    checkInTime: reservation.quote?.checkInTime || settings.rules?.checkInTime || "",
    checkOutTime: reservation.quote?.checkOutTime || settings.rules?.checkOutTime || "",
    totalAmount: formatCurrency(reservation.quote?.total, currency),
    depositAmount: formatCurrency(reservation.quote?.depositDue, currency),
    balanceAmount: formatCurrency(remainingBalance(reservation), currency),
    bookingDetails: bookingDetailsText(reservation, settings),
    balancePaymentLink: balancePaymentLinkText(reservation),
    reviewLink: "Review link will be added here."
  };
  return String(template).replace(/{{\s*([A-Za-z0-9_]+)\s*}}/g, (_match, key) => values[key] ?? "");
}

function appendBookingDetailsFooter(body, reservation, settings) {
  const text = String(body || "").trim();
  const footer = bookingDetailsFooterText(reservation, settings);
  if (!footer) return text;
  if (text.includes("Booking details:")) return text;
  return [text, footer].filter(Boolean).join("\n\n");
}

function bookingDetailsFooterText(reservation, settings) {
  return ["Booking details:", bookingDetailsText(reservation, settings)].filter(Boolean).join("\n");
}

function bookingDetailsFooterHtml(reservation, settings) {
  const details = bookingDetailsText(reservation, settings);
  if (!details) return "";
  const rows = details
    .split("\n")
    .map((line) => {
      const separator = line.indexOf(":");
      if (separator === -1) return `<tr><td colspan="2">${escapeHtml(line)}</td></tr>`;
      const label = line.slice(0, separator);
      const value = line.slice(separator + 1).trim();
      return `<tr><th align="left" style="padding:3px 16px 3px 0;">${escapeHtml(label)}</th><td style="padding:3px 0;">${escapeHtml(value)}</td></tr>`;
    })
    .join("");
  return `
    <hr style="border:none;border-top:1px solid #dddddd;margin:24px 0 12px;">
    <p><strong>Booking details</strong></p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      ${rows}
    </table>
  `;
}

function bookingDetailsText(reservation, settings) {
  const quote = reservation.quote || {};
  const currency = quote.currency || settings.pricing?.currency || "USD";
  const lines = [
    `Property: ${settings.business?.propertyName || settings.business?.siteName || "Sixth 14th"}`,
    `Guest: ${reservation.guest?.name || "Guest"}`,
    `Dates: ${formatLongDate(reservation.arrival)} to ${formatLongDate(reservation.departure)}`,
    `Nights: ${quote.nights || nightsBetween(reservation.arrival, reservation.departure)}`,
    `Guests: ${reservation.guest?.guests || 1}`,
    `Check-in: ${quote.checkInTime || settings.rules?.checkInTime || ""}`,
    `Check-out: ${quote.checkOutTime || settings.rules?.checkOutTime || ""}`,
    `Total: ${formatCurrency(quote.total, currency)}`
  ];
  if (Number(quote.depositDue || 0) > 0) {
    lines.push(`Deposit: ${formatCurrency(quote.depositDue, currency)}`);
  }
  if (remainingBalance(reservation) > 0) {
    lines.push(`Balance remaining: ${formatCurrency(remainingBalance(reservation), currency)}`);
  }
  return lines.filter((line) => !line.endsWith(": ")).join("\n");
}

function balancePaymentLinkText(reservation) {
  if (reservation.paymentStatus === "paid_in_full") {
    return "Your balance is paid. No payment link is needed.";
  }
  return publicPaymentUrl(reservation, "balance")
    || reservation.balanceCheckoutUrl
    || "Balance payment link will be generated before sending.";
}

function firstName(name = "") {
  return String(name).trim().split(/\s+/)[0] || "there";
}

function formatLongDate(iso) {
  if (!isIsoDate(iso)) return "";
  return parseDate(iso).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  });
}

function formatDateTimeForEmail(iso, settings) {
  const timeZone = settings.business?.timezone || "America/New_York";
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    timeZone
  });
}

function formatCurrency(amount = 0, currency = "USD") {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency || "USD"
  }).format(Number(amount || 0));
}

function quoteStay(arrival, departure, settings, store) {
  assertDateRange(arrival, departure);
  const nights = nightsBetween(arrival, departure);
  const rules = settings.rules;
  if (nights < rules.minimumStayNights) {
    throw userError(`The minimum stay is ${rules.minimumStayNights} nights.`);
  }
  if (nights > rules.maximumStayNights) {
    throw userError(`The maximum stay is ${rules.maximumStayNights} nights.`);
  }
  const conflicts = findConflicts(arrival, departure, settings, store);
  if (conflicts.length) {
    throw userError("Those dates are not available.");
  }
  const today = startOfUtcDay(new Date());
  const earliestArrival = addDays(today, rules.advanceNoticeDays);
  if (parseDate(arrival) < earliestArrival) {
    throw userError(`Reservations need at least ${rules.advanceNoticeDays} days of notice.`);
  }

  const stay = calculateStayTotal(arrival, departure, settings.pricing);
  const cleaning = settings.pricing.cleaningFee;
  const taxes = roundMoney((stay.total + cleaning) * settings.pricing.taxRate);
  const total = roundMoney(stay.total + cleaning + taxes);
  const depositDue = roundMoney(total * settings.pricing.depositPercentage);
  const balanceDue = roundMoney(total - depositDue);
  return {
    arrival,
    departure,
    nights,
    currency: settings.pricing.currency,
    lineItems: [
      ...stay.lineItems,
      { label: "Cleaning & Stocking", amount: cleaning },
      ...(taxes ? [{ label: "Taxes", amount: taxes }] : [])
    ],
    subtotal: roundMoney(stay.total + cleaning),
    taxes,
    total,
    depositDue,
    balanceDue,
    checkInTime: settings.rules.checkInTime,
    checkOutTime: settings.rules.checkOutTime
  };
}

function calculateStayTotal(arrival, departure, pricing) {
  const dates = eachNight(arrival, departure);
  let remaining = [...dates];
  const lineItems = [];
  let total = 0;

  while (remaining.length >= pricing.monthlyStay.nights) {
    total += pricing.monthlyStay.price;
    lineItems.push({ label: `${pricing.monthlyStay.nights}-night monthly stay`, amount: pricing.monthlyStay.price });
    remaining = remaining.slice(pricing.monthlyStay.nights);
  }
  while (remaining.length >= pricing.weeklyStay.nights) {
    total += pricing.weeklyStay.price;
    lineItems.push({ label: `${pricing.weeklyStay.nights}-night weekly stay`, amount: pricing.weeklyStay.price });
    remaining = remaining.slice(pricing.weeklyStay.nights);
  }
  for (const date of remaining) {
    const weekday = String(date.getUTCDay());
    const rate = pricing.baseNightlyByWeekday[weekday];
    total += rate;
    lineItems.push({ label: `${formatShortDate(date)} nightly rate`, amount: rate });
  }

  return { total: roundMoney(total), lineItems };
}

function getAvailability(start, end, settings, store) {
  assertDateRange(start, end);
  const days = [];
  for (const date of eachDayInclusive(start, end)) {
    const iso = dateToIso(date);
    days.push({
      date: iso,
      available: findConflicts(iso, addDaysIso(iso, 1), settings, store).length === 0,
      conflicts: findConflicts(iso, addDaysIso(iso, 1), settings, store).map((item) => item.type)
    });
  }
  return { start, end, days };
}

function findConflicts(arrival, departure, settings, store) {
  const conflicts = [];
  const start = parseDate(arrival);
  const end = parseDate(departure);
  const buffer = settings.rules.preparationDays;

  for (const reservation of store.reservations || []) {
    if (["canceled", "declined"].includes(reservation.status)) continue;
    if (reservation.status === "pending_payment" && isExpiredHold(reservation)) continue;
    const blockedStart = addDays(parseDate(reservation.arrival), -buffer);
    const blockedEnd = addDays(parseDate(reservation.departure), buffer);
    if (rangesOverlap(start, end, blockedStart, blockedEnd)) {
      conflicts.push({ type: "reservation", id: reservation.id });
    }
  }

  for (const block of store.manualBlocks || []) {
    if (rangesOverlap(start, end, parseDate(block.start), parseDate(block.end))) {
      conflicts.push({ type: "manual_block", id: block.id });
    }
  }

  for (const block of store.availabilityBlocks || []) {
    if (rangesOverlap(start, end, parseDate(block.start), parseDate(block.end))) {
      conflicts.push({ type: "synced_availability", id: block.id });
    }
  }
  return conflicts;
}

function publicBusiness(business) {
  return {
    siteName: business.siteName,
    propertyName: business.propertyName,
    addressSummary: business.addressSummary,
    imageUrl: business.imageUrl,
    timezone: business.timezone
  };
}

function assertDateRange(start, end) {
  if (!isIsoDate(start) || !isIsoDate(end)) {
    throw userError("Please choose valid arrival and departure dates.");
  }
  if (parseDate(start) >= parseDate(end)) {
    throw userError("Departure must be after arrival.");
  }
}

function required(value, label) {
  if (!String(value || "").trim()) {
    throw userError(`${label} is required.`);
  }
  return String(value).trim();
}

function validateGuestCount(value, settings) {
  const guests = Number(value || 1);
  const maximumGuests = Number(settings.rules?.maximumGuests || 3);
  if (!Number.isInteger(guests) || guests < 1 || guests > maximumGuests) {
    throw userError(`Guest count must be between 1 and ${maximumGuests}.`);
  }
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) && !Number.isNaN(parseDate(value).getTime());
}

function parseDate(value) {
  return new Date(`${value}T00:00:00.000Z`);
}

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function nightsBetween(start, end) {
  return Math.round((parseDate(end) - parseDate(start)) / 86400000);
}

function eachNight(start, end) {
  const dates = [];
  for (let date = parseDate(start); date < parseDate(end); date = addDays(date, 1)) {
    dates.push(date);
  }
  return dates;
}

function eachDayInclusive(start, end) {
  const dates = [];
  for (let date = parseDate(start); date <= parseDate(end); date = addDays(date, 1)) {
    dates.push(date);
  }
  return dates;
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

function addDaysIso(iso, days) {
  return dateToIso(addDays(parseDate(iso), days));
}

function dateAtUtcHour(iso, hour) {
  return `${iso}T${String(hour).padStart(2, "0")}:00:00.000Z`;
}

function dateToIso(date) {
  return date.toISOString().slice(0, 10);
}

function formatShortDate(date) {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function rangesOverlap(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

function roundMoney(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function cloneReservation(value) {
  return JSON.parse(JSON.stringify(value));
}

function parseOptionalMoney(value, label) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return null;
  }
  const parsed = Number(String(value).replace(/[$,]/g, "").trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw userError(`${label} must be a positive dollar amount.`, 400);
  }
  return roundMoney(parsed);
}

function applySpecialOfferToReservation(reservation, settings, specialOfferTotal) {
  if (specialOfferTotal === null) {
    return reservation;
  }
  if (!reservation.quote) {
    throw userError("Reservation quote is missing.", 400);
  }

  const currentTotal = roundMoney(Number(reservation.quote.total || 0));
  const existingOffer = reservation.quote.specialOffer;
  const originalTotal = roundMoney(Number(existingOffer?.originalTotal || currentTotal));
  if (!Number.isFinite(originalTotal) || originalTotal <= 0) {
    throw userError("Reservation total is missing.", 400);
  }
  if (specialOfferTotal > originalTotal) {
    throw userError("Preferred total must be less than or equal to the current quote total.", 400);
  }

  const originalLineItems = Array.isArray(reservation.quote.lineItems)
    ? reservation.quote.lineItems.filter((item) => item.type !== "special_offer")
    : [];
  const depositPercentage = Number(settings.pricing?.depositPercentage || 0.5);

  reservation.quote.lineItems = originalLineItems;
  reservation.quote.total = specialOfferTotal;
  reservation.quote.depositDue = roundMoney(specialOfferTotal * depositPercentage);
  reservation.quote.balanceDue = roundMoney(specialOfferTotal - reservation.quote.depositDue);
  delete reservation.quote.specialOffer;

  if (specialOfferTotal === originalTotal) {
    return reservation;
  }

  const discount = roundMoney(originalTotal - specialOfferTotal);
  reservation.quote.lineItems = [
    ...originalLineItems,
    { label: "Preferred guest discount", amount: -discount, type: "special_offer" }
  ];
  reservation.quote.specialOffer = {
    originalTotal,
    discount,
    total: specialOfferTotal,
    createdAt: existingOffer?.createdAt || new Date().toISOString()
  };
  return reservation;
}

function toCents(value) {
  return Math.round(Number(value) * 100);
}

function centsToDollars(value) {
  return roundMoney(Number(value) / 100);
}

function remainingBalance(reservation) {
  const total = Number(reservation.quote?.total || 0);
  const paid = Number(reservation.amountPaid || 0);
  return roundMoney(Math.max(total - paid, 0));
}

function reservationDateRange(reservation) {
  return `${reservation?.arrival || "unknown arrival"} to ${reservation?.departure || "unknown departure"}`;
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function cleanText(value, maxLength = 1000) {
  return String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .trim()
    .slice(0, maxLength);
}

function normalizeEmailField(value) {
  return cleanText(value, 254).toLowerCase();
}

function normalizeGoogleAdsCustomerId(value = "") {
  return String(value || "").replace(/\D/g, "");
}

function googleAdsDateTime(value) {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) {
    return googleAdsDateTime(new Date().toISOString());
  }
  return `${date.toISOString().slice(0, 19).replace("T", " ")}+00:00`;
}

function stripeAttributionMetadata(reservation, paymentType) {
  return {
    booking_value: safeMetadataValue(reservation.quote?.total),
    booking_currency: safeMetadataValue(reservation.quote?.currency || "USD"),
    ...safeAttributionFields(reservation.attribution),
    payment_type: safeMetadataValue(paymentType)
  };
}

function safeAttributionFields(attribution = {}) {
  const clean = sanitizeAttribution(attribution);
  return Object.fromEntries(
    Object.entries(clean).map(([key, value]) => [key, safeMetadataValue(value)]).filter(([, value]) => value)
  );
}

function safeMetadataValue(value) {
  return String(value ?? "").replace(/[\r\n]/g, " ").trim().slice(0, 500);
}

function availableGoogleClickId(attribution = {}) {
  const clean = sanitizeAttribution(attribution);
  for (const type of ["gclid", "gbraid", "wbraid"]) {
    if (clean[type]) return { type, value: clean[type] };
  }
  return { type: "", value: "" };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function pick(object, keys) {
  return Object.fromEntries(keys.filter((key) => key in object).map((key) => [key, object[key]]));
}

async function readFileSettings() {
  return JSON.parse(await readFile(settingsPath, "utf8"));
}

function mergeSettings(fileSettings, storedSettings) {
  const stored = storedSettings && typeof storedSettings === "object" ? storedSettings : {};
  return {
    ...fileSettings,
    ...stored,
    business: { ...(fileSettings.business || {}), ...(stored.business || {}) },
    rules: { ...(fileSettings.rules || {}), ...(stored.rules || {}) },
    pricing: { ...(fileSettings.pricing || {}), ...(stored.pricing || {}) },
    messages: Array.isArray(stored.messages) ? stored.messages : fileSettings.messages
  };
}

async function readSettings() {
  const fileSettings = await readFileSettings();
  if (databasePool) {
    const result = await databasePool.query("select payload from app_documents where document_key = $1", ["settings"]);
    if (result.rows[0]?.payload) {
      return mergeSettings(fileSettings, result.rows[0].payload);
    }
  }
  return fileSettings;
}

async function readReservations() {
  if (databasePool) {
    const result = await databasePool.query("select payload from app_documents where document_key = $1", ["reservations"]);
    return normalizeReservationStore(result.rows[0]?.payload);
  }
  return normalizeReservationStore(JSON.parse(await readFile(reservationsPath, "utf8")));
}

async function updateReservationStore(mutator) {
  if (databasePool) {
    return updateReservationStoreInDatabase(mutator);
  }

  const nextJob = jsonStoreQueue.then(async () => {
    const store = await readReservations();
    const result = await mutator(store);
    await writeJson(reservationsPath, normalizeReservationStore(store));
    return result;
  });
  jsonStoreQueue = nextJob.catch(() => {});
  return nextJob;
}

async function updateReservationStoreInDatabase(mutator) {
  const client = await databasePool.connect();
  try {
    await client.query("begin");
    const result = await client.query("select payload from app_documents where document_key = $1 for update", ["reservations"]);
    const store = normalizeReservationStore(result.rows[0]?.payload);
    const returnValue = await mutator(store);
    await client.query(
      `
        insert into app_documents (document_key, payload, updated_at)
        values ($1, $2::jsonb, now())
        on conflict (document_key)
        do update set payload = excluded.payload, updated_at = now()
      `,
      ["reservations", JSON.stringify(normalizeReservationStore(store))]
    );
    await client.query("commit");
    return returnValue;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function updateSettingsStore(mutator) {
  if (databasePool) {
    return updateSettingsStoreInDatabase(mutator);
  }

  const nextJob = settingsStoreQueue.then(async () => {
    const settings = await readSettings();
    const result = await mutator(settings);
    await writeJson(settingsPath, settings);
    return result;
  });
  settingsStoreQueue = nextJob.catch(() => {});
  return nextJob;
}

async function updateSettingsStoreInDatabase(mutator) {
  const client = await databasePool.connect();
  try {
    await client.query("begin");
    const fileSettings = await readFileSettings();
    const result = await client.query("select payload from app_documents where document_key = $1 for update", ["settings"]);
    const settings = mergeSettings(fileSettings, result.rows[0]?.payload);
    const returnValue = await mutator(settings);
    await client.query(
      `
        insert into app_documents (document_key, payload, updated_at)
        values ($1, $2::jsonb, now())
        on conflict (document_key)
        do update set payload = excluded.payload, updated_at = now()
      `,
      ["settings", JSON.stringify(settings)]
    );
    await client.query("commit");
    return returnValue;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function initializeDatabaseStorage() {
  const { Pool } = await import("pg");
  databasePool = new Pool({
    connectionString: databaseUrl,
    ...(process.env.DATABASE_SSL === "true" ? { ssl: { rejectUnauthorized: false } } : {})
  });
  await databasePool.query(`
    create table if not exists app_documents (
      document_key text primary key,
      payload jsonb not null,
      updated_at timestamptz not null default now()
    )
  `);

  const existing = await databasePool.query("select 1 from app_documents where document_key = $1", ["reservations"]);
  if (!existing.rowCount) {
    await databasePool.query(
      "insert into app_documents (document_key, payload) values ($1, $2::jsonb)",
      ["reservations", JSON.stringify(await readInitialReservationStore())]
    );
  }

  const settingsExisting = await databasePool.query("select 1 from app_documents where document_key = $1", ["settings"]);
  if (!settingsExisting.rowCount) {
    await databasePool.query(
      "insert into app_documents (document_key, payload) values ($1, $2::jsonb)",
      ["settings", JSON.stringify(await readFileSettings())]
    );
  }
}

async function readInitialReservationStore() {
  if (existsSync(reservationsPath)) {
    return normalizeReservationStore(JSON.parse(await readFile(reservationsPath, "utf8")));
  }

  const seedPath = path.join(seedDataDir, "reservations.seed.json");
  if (existsSync(seedPath)) {
    return normalizeReservationStore(JSON.parse(await readFile(seedPath, "utf8")));
  }

  return emptyReservationStore();
}

function emptyReservationStore() {
  return { reservations: [], manualBlocks: [], availabilityBlocks: [], googleAdsPurchaseConversions: [], messageQueue: [], auditEvents: [] };
}

function normalizeReservationStore(store) {
  return {
    ...emptyReservationStore(),
    ...(store && typeof store === "object" ? store : {}),
    reservations: Array.isArray(store?.reservations) ? store.reservations : [],
    manualBlocks: Array.isArray(store?.manualBlocks) ? store.manualBlocks : [],
    availabilityBlocks: Array.isArray(store?.availabilityBlocks) ? store.availabilityBlocks : [],
    googleAdsPurchaseConversions: Array.isArray(store?.googleAdsPurchaseConversions) ? store.googleAdsPurchaseConversions : [],
    messageQueue: Array.isArray(store?.messageQueue) ? store.messageQueue : [],
    auditEvents: Array.isArray(store?.auditEvents) ? store.auditEvents : []
  };
}

function replaceStoreContents(target, source) {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, normalizeReservationStore(source));
}

async function ensureDataFile(fileName, fallback, seedFileName = fileName) {
  const runtimePath = path.join(dataDir, fileName);
  if (existsSync(runtimePath)) return;

  const seedPath = path.join(seedDataDir, seedFileName);
  if (existsSync(seedPath)) {
    await writeFile(runtimePath, await readFile(seedPath, "utf8"));
    return;
  }

  await writeJson(runtimePath, fallback);
}

async function writeJson(filePath, data) {
  await writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

async function readJsonBody(req) {
  const raw = await readRawBody(req);
  if (!raw.length) return {};
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    throw userError("Request body must be valid JSON.");
  }
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function sendJsonDownload(res, fileName, data) {
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "content-disposition": `attachment; filename="${fileName}"`
  });
  res.end(`${JSON.stringify(data, null, 2)}\n`);
}

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function redirect(res, location) {
  res.writeHead(303, {
    "cache-control": "no-store",
    location
  });
  res.end();
}

function sendPaymentNotice(res, status, title, message) {
  sendHtml(res, status, `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)} - Sixth &amp; 14th</title>
    <link rel="stylesheet" href="/styles.css">
    <script src="/tracking.js" type="module"></script>
  </head>
  <body>
    <main class="success-shell">
      <section class="success-card">
        <img src="/park-slope-6av-14st.webp" alt="Sixth &amp; 14th illustrated icon">
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(message)}</p>
        <a class="primary-button" href="/">Back to booking</a>
      </section>
    </main>
  </body>
</html>`);
}

function requiresStagingAuth(req, url) {
  if (!process.env.STAGING_PASSWORD) return false;
  if (isAlwaysPublicRequest(url)) return false;
  if (publicBookingEnabled() && isPublicBookingRequest(req, url)) return false;
  return true;
}

function isAlwaysPublicRequest(url) {
  return ["/api/health", "/api/stripe/webhook"].includes(url.pathname);
}

function isPublicBookingRequest(req, url) {
  if (req.method === "GET" && publicBookingStaticPaths.has(url.pathname)) return true;
  if (req.method === "GET" && paymentLinkParts(url.pathname)) return true;
  if (req.method === "GET" && ["/api/config", "/api/availability"].includes(url.pathname)) return true;
  if (req.method === "POST" && ["/api/quote", "/api/bookings"].includes(url.pathname)) return true;
  return false;
}

function publicBookingEnabled() {
  return process.env.PUBLIC_BOOKING_ENABLED === "true";
}

function publicTrackingConfig() {
  return {
    googleAdsId: process.env.GOOGLE_ADS_ID || "AW-994349610",
    googleAdsConversionLabel: process.env.GOOGLE_ADS_CONVERSION_LABEL || "",
    debug: trackingDebugEnabled()
  };
}

function trackingDebugEnabled() {
  return process.env.NODE_ENV !== "production" || process.env.TRACKING_DEBUG === "true";
}

function isAuthorized(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator === -1) return false;
  const username = decoded.slice(0, separator);
  const password = decoded.slice(separator + 1);
  return safeEqualString(username, process.env.STAGING_USERNAME || "marc") && safeEqualString(password, process.env.STAGING_PASSWORD);
}

function requestStagingAuth(res) {
  res.writeHead(401, {
    "content-type": "text/plain; charset=utf-8",
    "www-authenticate": 'Basic realm="Sixth 14th private staging", charset="UTF-8"'
  });
  res.end("Private staging requires a username and password.");
}

function safeEqualString(left = "", right = "") {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function getHealthPayload() {
  return {
    ok: true,
    service: "sixth14th-booking",
    timestamp: new Date().toISOString()
  };
}

function publicStagingStatus() {
  return {
    label: process.env.STAGING_LABEL || "Local prototype",
    private: Boolean(process.env.STAGING_PASSWORD),
    publicBookingEnabled: publicBookingEnabled(),
    stripeMode: stripeMode()
  };
}

function getStagingStatus() {
  const emailStatus = getEmailStatus();
  const googleAdsStatus = getGoogleAdsDeliveryStatus();
  return {
    label: process.env.STAGING_LABEL || "Local prototype",
    privateAccessEnabled: Boolean(process.env.STAGING_PASSWORD),
    publicBookingEnabled: publicBookingEnabled(),
    publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${port}`,
    storage: databasePool ? "postgres" : "local-json",
    databaseConfigured: Boolean(databasePool),
    stripeConfigured: Boolean(process.env.STRIPE_SECRET_KEY),
    stripeMode: stripeMode(),
    stripeWebhookConfigured: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    liveStripeUnlocked: process.env.ALLOW_LIVE_STRIPE === "true",
    lodgifySyncConfigured: Boolean(process.env.LODGIFY_API_KEY || process.env.LODGIFY_ICAL_URL),
    emailConfigured: emailStatus.configured,
    emailSendingEnabled: emailStatus.sendingEnabled,
    emailProvider: emailStatus.provider,
    emailFrom: emailStatus.from,
    emailReplyTo: emailStatus.replyTo,
    googleCalendarConfigured: calendarConfigured(),
    googleCalendarSyncEnabled: calendarSyncEnabled(),
    googleCalendarId: calendarTargetId(),
    googleCalendarAttendee: calendarInviteEmail(),
    googleAdsDeliveryConfigured: googleAdsStatus.configured,
    googleAdsDeliveryDryRun: googleAdsStatus.dryRun,
    googleAdsApiVersion: googleAdsStatus.apiVersion,
    ownerNotificationsEnabled: ownerNotificationsEnabled(),
    ownerNotifyEmail: ownerNotifyEmail(),
    paymentHoldMinutes
  };
}

function getGoogleAdsDeliveryStatus() {
  const config = googleAdsDeliveryConfig();
  return {
    configured: googleAdsDeliveryConfigured(config),
    dryRun: process.env.GOOGLE_ADS_DELIVERY_DRY_RUN === "true",
    apiVersion: config.apiVersion
  };
}

function getEmailStatus() {
  return {
    configured: emailProviderConfigured(),
    sendingEnabled: emailSendingEnabled(),
    provider: emailProviderName(),
    from: emailFromAddress(),
    replyTo: emailReplyToAddress()
  };
}

function emailSendingEnabled() {
  return process.env.EMAIL_SEND_ENABLED === "true" && emailProviderConfigured();
}

function emailProviderConfigured() {
  return Boolean(emailFromAddress() && (gmailConfigured() || process.env.RESEND_API_KEY || smtpConfigured()));
}

function gmailConfigured() {
  return Boolean(
    process.env.GMAIL_OAUTH_CLIENT_ID
    && process.env.GMAIL_OAUTH_CLIENT_SECRET
    && process.env.GMAIL_OAUTH_REFRESH_TOKEN
    && process.env.GMAIL_OAUTH_USER
  );
}

function calendarConfigured() {
  return gmailConfigured();
}

function calendarSyncEnabled() {
  return process.env.GOOGLE_CALENDAR_SYNC_ENABLED !== "false" && calendarConfigured();
}

function calendarTargetId() {
  return process.env.GOOGLE_CALENDAR_ID || "primary";
}

function calendarInviteEmail() {
  return process.env.GOOGLE_CALENDAR_ATTENDEE || process.env.GMAIL_OAUTH_USER || "stay@sixth14th.com";
}

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function smtpSecure() {
  if (process.env.SMTP_SECURE) return process.env.SMTP_SECURE === "true";
  return Number(process.env.SMTP_PORT || 587) === 465;
}

function emailProviderName() {
  if (gmailConfigured()) return "gmail";
  if (process.env.RESEND_API_KEY) return "resend";
  if (smtpConfigured() || process.env.SMTP_HOST) return "smtp";
  return "none";
}

function emailFromAddress() {
  return process.env.EMAIL_FROM || defaultEmailFrom;
}

function emailReplyToAddress() {
  return process.env.EMAIL_REPLY_TO || defaultEmailReplyTo;
}

function stripeMode() {
  if (!process.env.STRIPE_SECRET_KEY) return "not_configured";
  if (isLiveStripeKey(process.env.STRIPE_SECRET_KEY)) return "live";
  if (isTestStripeKey(process.env.STRIPE_SECRET_KEY)) return "test";
  return "unknown";
}

function userError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function isExpiredHold(reservation) {
  return reservation.holdExpiresAt && new Date(reservation.holdExpiresAt).getTime() <= Date.now();
}

function isLiveStripeKey(value = "") {
  return ["sk_live_", "rk_live_"].some((prefix) => String(value).startsWith(prefix));
}

function isTestStripeKey(value = "") {
  return ["sk_test_", "rk_test_"].some((prefix) => String(value).startsWith(prefix));
}

process.on("uncaughtException", (error) => {
  console.error(error);
});

process.on("unhandledRejection", (error) => {
  console.error(error);
});
