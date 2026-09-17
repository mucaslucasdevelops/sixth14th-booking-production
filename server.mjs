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
    rewriteAdminDataPath(url);
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

function rewriteAdminDataPath(url) {
  if (url.pathname === "/admin-data/status") {
    url.pathname = "/api/staging/status";
    return;
  }
  if (url.pathname.startsWith("/admin-data/")) {
    url.pathname = `/api/admin/${url.pathname.slice("/admin-data/".length)}`;
  }
}

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
    sendCheckoutRedirect(res, session.url);
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

  sendCheckoutRedirect(res, checkoutUrl);
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
    return sendResendEmail(message)…31999 tokens truncated…elector("[data-action='preview-template']").addEventListener("click", (event) => previewMessageTemplate(event, message.id));
  item.querySelector("[data-action='send-template-test']").addEventListener("click", (event) => sendMessageTemplateTest(event, message.id));
  return item;
}

function timingOptions(selected) {
  const options = [
    ["immediate", "When booking is confirmed"],
    ["-7d", "7 days before arrival"],
    ["-2d", "2 days before arrival"],
    ["0d", "Arrival day"],
    ["checkout", "Checkout day"],
    ["+2d", "2 days after departure"]
  ];
  return options.map(([value, label]) => `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`).join("");
}

function timingLabel(value) {
  const labels = {
    immediate: "When booking is confirmed",
    booking_confirmed: "When booking is confirmed",
    "-7d": "7 days before arrival",
    seven_days_before_arrival: "7 days before arrival",
    "-2d": "2 days before arrival",
    two_days_before_arrival: "2 days before arrival",
    "0d": "Arrival day",
    arrival_day: "Arrival day",
    checkout: "Checkout day",
    checkout_day: "Checkout day",
    "+2d": "2 days after departure",
    two_days_after_departure: "2 days after departure"
  };
  return labels[value] || value || "Timing not set";
}

function reservationPreviewOptions() {
  const reservations = latestReservations
    .filter((reservation) => reservation.guest?.email && reservation.source !== "lodgify")
    .sort(compareArrival);
  if (!reservations.length) {
    return '<option value="">No guest reservations available</option>';
  }
  return reservations.map((reservation) => (
    `<option value="${escapeHtml(reservation.id)}">${escapeHtml(reservation.guest?.name || "Guest")} · ${escapeHtml(formatDate(reservation.arrival))} to ${escapeHtml(formatDate(reservation.departure))}</option>`
  )).join("");
}

async function saveMessageTemplate(event, id) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector("button[type='submit']");
  const status = form.querySelector("[data-template-message]");
  const payload = {
    enabled: form.elements.enabled.checked,
    sendOffset: form.elements.sendOffset.value,
    subject: form.elements.subject.value,
    body: form.elements.body.value
  };

  submit.disabled = true;
  submit.textContent = "Saving...";
  status.textContent = "";
  status.classList.remove("error");

  try {
    await patchJson(`/api/admin/messages/${encodeURIComponent(id)}`, payload);
    form.closest(".message-item")?.classList.toggle("disabled", !payload.enabled);
    status.textContent = "Saved. Unsent scheduled messages were updated.";
    await loadMessages();
    await loadMessageQueue();
  } catch (error) {
    status.textContent = error.message;
    status.classList.add("error");
  } finally {
    submit.disabled = false;
    submit.textContent = "Save template";
  }
}

async function previewMessageTemplate(event, id) {
  const form = event.currentTarget.closest("form");
  const status = form.querySelector("[data-template-message]");
  const preview = form.querySelector("[data-template-preview]");
  status.textContent = "";
  status.classList.remove("error");
  preview.hidden = true;
  try {
    const result = await postJson(`/api/admin/messages/${encodeURIComponent(id)}/preview`, {
      reservationId: form.elements.reservationId.value
    });
    preview.textContent = `To: ${result.recipientName} <${result.to}>\nSubject: ${result.subject}\n\n${result.body}`;
    preview.hidden = false;
  } catch (error) {
    status.textContent = error.message;
    status.classList.add("error");
  }
}

async function sendMessageTemplateTest(event, id) {
  const button = event.currentTarget;
  const form = button.closest("form");
  const status = form.querySelector("[data-template-message]");
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Sending...";
  status.textContent = "";
  status.classList.remove("error");
  try {
    const result = await postJson(`/api/admin/messages/${encodeURIComponent(id)}/test`, {
      reservationId: form.elements.reservationId.value,
      email: form.elements.testEmail.value
    });
    status.textContent = result.status === "sent"
      ? `Test sent to ${result.to}.`
      : `Test ready but not sent: ${result.detail || result.error || result.status}.`;
  } catch (error) {
    status.textContent = error.message;
    status.classList.add("error");
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

function renderMessageQueue(queue) {
  const rows = [];
  const head = document.createElement("div");
  head.className = "message-head";
  head.innerHTML = "<span>Guest</span><span>Message</span><span>Send timing</span><span>Status</span><span>Actions</span>";
  rows.push(head);

  for (const delivery of queue) {
    const row = document.createElement("div");
    row.className = "message-row";
    row.dataset.deliveryId = delivery.id;
    row.innerHTML = `
      <div><strong>${escapeHtml(delivery.recipientName || "Guest")}</strong><br><span class="muted">${escapeHtml(delivery.recipientEmail || "")}</span></div>
      <span>${escapeHtml(delivery.messageName)}</span>
      <span>${escapeHtml(formatDateTime(delivery.dueAt))}</span>
      <span class="status-pill">${escapeHtml(delivery.status)}</span>
      <span class="row-actions">
        <button type="button" class="text-button" data-action="preview-message">Preview</button>
        ${messageComposeLink(delivery)}
        ${["sent", "skipped"].includes(delivery.status) ? "" : '<button type="button" class="text-button" data-action="mark-message-sent">Mark sent</button>'}
      </span>
    `;
    row.querySelector("[data-action='preview-message']").addEventListener("click", () => renderMessagePreview(delivery));
    const markSent = row.querySelector("[data-action='mark-message-sent']");
    if (markSent) {
      markSent.addEventListener("click", () => markMessageSent(delivery.id, markSent));
    }
    rows.push(row);
  }

  if (rows.length === 1) {
    const empty = document.createElement("div");
    empty.className = "message-row";
    empty.innerHTML = "<span>No guest messages are scheduled yet.</span><span></span><span></span><span></span><span></span>";
    rows.push(empty);
  }

  els.messageQueue.replaceChildren(...rows);
}

function renderMessagePreview(delivery) {
  els.messagePreview.innerHTML = `
    <h2>${escapeHtml(delivery.messageName)}</h2>
    <dl class="preview-meta">
      <div><dt>To</dt><dd>${escapeHtml(delivery.recipientName)} &lt;${escapeHtml(delivery.recipientEmail)}&gt;</dd></div>
      <div><dt>Subject</dt><dd>${escapeHtml(delivery.subject)}</dd></div>
      <div><dt>Scheduled</dt><dd>${escapeHtml(formatDateTime(delivery.dueAt))}</dd></div>
      <div><dt>Status</dt><dd>${escapeHtml(delivery.status)}</dd></div>
    </dl>
    ${messageComposeLink(delivery)}
    <pre>${escapeHtml(delivery.body)}</pre>
  `;
}

function messageComposeLink(delivery) {
  if (!delivery || ["sent", "skipped"].includes(delivery.status)) return "";
  if (!delivery.recipientEmail || !delivery.body) return "";
  const href = `mailto:${encodeURIComponent(delivery.recipientEmail)}?subject=${encodeURIComponent(delivery.subject || delivery.messageName)}&body=${encodeURIComponent(delivery.body)}`;
  return `<a class="text-button" href="${escapeHtml(href)}">Compose email</a>`;
}

function renderAuditLog(events) {
  const rows = [];
  const head = document.createElement("div");
  head.className = "audit-head";
  head.innerHTML = "<span>Time</span><span>Event</span><span>Details</span>";
  rows.push(head);

  for (const event of events) {
    const row = document.createElement("div");
    row.className = "audit-row";
    row.innerHTML = `
      <span>${escapeHtml(formatDateTime(event.createdAt))}</span>
      <div><strong>${escapeHtml(event.summary || event.action)}</strong><br><span class="muted">${escapeHtml(event.action || "")}</span></div>
      <span>${escapeHtml(formatAuditMetadata(event.metadata))}</span>
    `;
    rows.push(row);
  }

  if (rows.length === 1) {
    const empty = document.createElement("div");
    empty.className = "audit-row";
    empty.innerHTML = "<span>No audit events yet.</span><span></span><span></span>";
    rows.push(empty);
  }

  els.auditLog.replaceChildren(...rows);
}

function formatAuditMetadata(metadata = {}) {
  return Object.entries(metadata || {})
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`)
    .join(" · ");
}

function paymentPageUrl(reservation, paymentType) {
  const token = paymentType === "balance" ? reservation.balancePaymentToken : reservation.depositPaymentToken;
  const identifier = token || reservation.id;
  return `${window.location.origin}/pay/${paymentType}/${encodeURIComponent(identifier)}`;
}

async function copyPaymentLink(url, button) {
  if (!url) return;
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(url);
    button.textContent = "Copied";
    window.setTimeout(() => {
      button.textContent = label;
    }, 1500);
  } catch {
    window.prompt("Copy this payment link:", url);
  }
}

async function addBlock(event) {
  event.preventDefault();
  setBlockMessage("Adding block...");
  const form = new FormData(els.blockForm);
  try {
    await postJson("/api/admin/blocks", {
      start: form.get("start"),
      end: form.get("end"),
      reason: form.get("reason")
    });
    els.blockForm.reset();
    setBlockMessage("Block added.");
    await loadReservations();
  } catch (error) {
    setBlockMessage(error.message, true);
  }
}

async function editManualBlock(block) {
  const start = window.prompt("Block start date", block.start || "");
  if (start === null) return;
  const end = window.prompt("Block end date", block.end || "");
  if (end === null) return;
  const reason = window.prompt("Block reason", block.reason || "Manual block");
  if (reason === null) return;
  try {
    await patchJson(`/api/admin/blocks/${encodeURIComponent(block.id)}`, {
      start: start.trim(),
      end: end.trim(),
      reason: reason.trim()
    });
    await loadReservations();
  } catch (error) {
    window.alert(error.message);
  }
}

async function deleteManualBlock(block) {
  if (!window.confirm(`Delete this manual block and release ${formatDate(block.start)} to ${formatDate(block.end)}?`)) {
    return;
  }
  try {
    await deleteJson(`/api/admin/blocks/${encodeURIComponent(block.id)}`);
    await loadReservations();
  } catch (error) {
    window.alert(error.message);
  }
}

async function archiveManualBlock(block, archived) {
  const verb = archived ? "archive" : "unarchive";
  if (!window.confirm(`${verb[0].toUpperCase()}${verb.slice(1)} this manual block?`)) {
    return;
  }
  try {
    await patchJson(`/api/admin/blocks/${encodeURIComponent(block.id)}`, {
      archived,
      archiveReason: archived ? "Archived from Admin" : ""
    });
    await loadReservations();
  } catch (error) {
    window.alert(error.message);
  }
}

async function cancelReservation(id, button) {
  const label = button.textContent;
  if (!window.confirm("Cancel this reservation in staging and release its dates? Stripe test charges will remain visible in Stripe, but the staging calendar will become available again.")) {
    return;
  }
  button.disabled = true;
  button.textContent = "Canceling...";
  try {
    await patchJson(`/api/admin/reservations/${encodeURIComponent(id)}`, {
      status: "canceled",
      paymentStatus: "canceled"
    });
    await loadReservations();
  } catch (error) {
    button.disabled = false;
    button.textContent = label;
    window.alert(error.message);
  }
}

async function archiveReservation(id, archived, button) {
  const label = button.textContent;
  const message = archived
    ? "Archive this booking activity? Archived activity is hidden from the default Admin activity list, but existing booked dates are not released."
    : "Unarchive this booking activity and show it in the default Admin activity list?";
  if (!window.confirm(message)) {
    return;
  }
  button.disabled = true;
  button.textContent = archived ? "Archiving..." : "Restoring...";
  try {
    await patchJson(`/api/admin/reservations/${encodeURIComponent(id)}`, {
      archived,
      archiveReason: archived ? "Archived from Admin" : ""
    });
    await loadReservations();
  } catch (error) {
    button.disabled = false;
    button.textContent = label;
    window.alert(error.message);
  }
}

async function deleteReservation(id, button) {
  const label = button.textContent;
  if (!window.confirm("Delete this local booking activity and release its dates? This cannot delete Lodgify bookings or refund Stripe charges.")) {
    return;
  }
  button.disabled = true;
  button.textContent = "Deleting...";
  try {
    await deleteJson(`/api/admin/reservations/${encodeURIComponent(id)}`);
    await Promise.all([loadReservations(), loadMessageQueue()]);
  } catch (error) {
    button.disabled = false;
    button.textContent = label;
    window.alert(error.message);
  }
}

async function approveReservation(id, button) {
  const label = button.textContent;
  const specialOfferInput = button.closest(".row-actions")?.querySelector("[data-special-offer-total]");
  const specialOfferTotal = specialOfferInput?.value?.trim() || "";
  if (specialOfferTotal) {
    const parsed = Number(specialOfferTotal.replace(/[$,]/g, ""));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      window.alert("Preferred total must be a positive dollar amount.");
      return;
    }
  }
  button.disabled = true;
  if (specialOfferInput) specialOfferInput.disabled = true;
  button.textContent = "Approving...";
  try {
    const payload = specialOfferTotal ? { specialOfferTotal } : {};
    const result = await postJson(`/api/admin/reservations/${encodeURIComponent(id)}/approve`, payload);
    await Promise.all([loadReservations(), loadMessageQueue()]);
    if (result.email?.status === "sent") {
      window.alert("Deposit link created and emailed to the guest.");
    } else if (result.email?.status === "failed") {
      const detail = result.email.error ? `\n\nEmail error: ${result.email.error}` : "";
      window.alert(`Deposit link created, but the email could not be sent. Use Open deposit link or Compose email in the reservation row.${detail}`);
    } else if (result.checkoutUrl) {
      window.alert("Deposit link created. Email is ready but not sent yet; use Compose email in the reservation row until sending is enabled.");
    } else {
      window.alert(result.message || "Request approved.");
    }
  } catch (error) {
    button.disabled = false;
    if (specialOfferInput) specialOfferInput.disabled = false;
    button.textContent = label;
    window.alert(error.message);
  }
}

async function createBalanceLink(id, button) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Creating...";
  try {
    const result = await postJson(`/api/admin/reservations/${encodeURIComponent(id)}/balance`, {});
    await Promise.all([loadReservations(), loadMessageQueue()]);
    if (result.email?.status === "sent") {
      window.alert("Balance link created and emailed to the guest.");
    } else if (result.email?.status === "failed") {
      const detail = result.email.error ? `\n\nEmail error: ${result.email.error}` : "";
      window.alert(`Balance link created, but the email could not be sent. Use Open balance link or Compose balance email in the reservation row.${detail}`);
    } else if (result.checkoutUrl) {
      window.alert("Balance link created. Email is ready but not sent yet; use Compose balance email in the reservation row until sending is enabled.");
    } else {
      window.alert(result.message || "Balance link created.");
    }
  } catch (error) {
    button.disabled = false;
    button.textContent = label;
    window.alert(error.message);
  }
}

async function declineReservation(id, button) {
  const label = button.textContent;
  if (!window.confirm("Decline this booking request and release its dates?")) {
    return;
  }
  button.disabled = true;
  button.textContent = "Declining...";
  try {
    await postJson(`/api/admin/reservations/${encodeURIComponent(id)}/decline`, {});
    await loadReservations();
  } catch (error) {
    button.disabled = false;
    button.textContent = label;
    window.alert(error.message);
  }
}

async function markMessageSent(id, button) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Saving...";
  try {
    await patchJson(`/api/admin/message-queue/${encodeURIComponent(id)}`, { status: "sent" });
    await loadMessageQueue();
  } catch (error) {
    button.disabled = false;
    button.textContent = label;
    window.alert(error.message);
  }
}

function setBlockMessage(message, isError = false) {
  els.blockMessage.textContent = message;
  els.blockMessage.classList.toggle("error", isError);
}

function setSyncMessage(message, isError = false) {
  els.syncMessage.textContent = message;
  els.syncMessage.classList.toggle("error", isError);
}

function setMessageQueueMessage(message, isError = false) {
  els.messageQueueMessage.textContent = message;
  els.messageQueueMessage.classList.toggle("error", isError);
}

async function getJson(url) {
  const response = await fetch(adminDataUrl(url));
  return readJsonResponse(response);
}

async function postJson(url, payload) {
  const response = await fetch(adminDataUrl(url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  return readJsonResponse(response);
}

async function patchJson(url, payload) {
  const response = await fetch(adminDataUrl(url), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  return readJsonResponse(response);
}

async function deleteJson(url) {
  const response = await fetch(adminDataUrl(url), { method: "DELETE" });
  return readJsonResponse(response);
}

function adminDataUrl(url) {
  if (url === "/api/staging/status") return "/admin-data/status";
  return url.replace(/^\/api\/admin\//, "/admin-data/");
}

async function readJsonResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const text = await response.text();
    const looksLikeHtml = text.trim().startsWith("<");
    const message = looksLikeHtml
      ? "The server returned a web page instead of app data. Refresh after the deploy finishes; if this repeats, check the Render logs."
      : text.trim() || "The server returned an unexpected response.";
    throw new Error(message);
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function money(amount, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

function remainingBalance(reservation) {
  const total = Number(reservation.quote?.total || 0);
  const paid = Number(reservation.amountPaid || 0);
  return Math.max(total - paid, 0);
}

function formatDate(iso) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC"
  });
}

function formatDateWithYear(iso) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  });
}

function formatDateTime(iso) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function firstOfMonth(iso) {
  return `${iso.slice(0, 7)}-01`;
}

function addDaysIso(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function eachDate(startIso, endIso, callback) {
  if (!startIso || !endIso) return;
  let cursor = startIso;
  let guard = 0;
  while (cursor < endIso && guard < 1500) {
    callback(cursor);
    cursor = addDaysIso(cursor, 1);
    guard += 1;
  }
}

function isSameMonth(iso, year, month) {
  const date = new Date(`${iso}T00:00:00Z`);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month;
}

function isExpiredHold(reservation) {
  return reservation.holdExpiresAt && new Date(reservation.holdExpiresAt).getTime() <= Date.now();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}
