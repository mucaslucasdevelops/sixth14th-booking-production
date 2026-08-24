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
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg"
};

await mkdir(dataDir, { recursive: true });
await ensureDataFile("settings.json", { business: {}, rules: {}, pricing: {}, messages: [] });
await ensureDataFile("reservations.json", { reservations: [], manualBlocks: [], availabilityBlocks: [] }, "reservations.seed.json");
if (!existsSync(reservationsPath)) {
  await writeJson(reservationsPath, { reservations: [], manualBlocks: [], availabilityBlocks: [] });
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, getHealthPayload());
      return;
    }
    if (requiresStagingAuth(url) && !isAuthorized(req)) {
      requestStagingAuth(res);
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

  if (req.method === "GET" && url.pathname === "/api/admin/messages") {
    const settings = await readSettings();
    sendJson(res, 200, settings.messages);
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

  if (req.method === "PATCH" && url.pathname.startsWith("/api/admin/reservations/")) {
    const id = decodeURIComponent(url.pathname.split("/").pop());
    const payload = await readJsonBody(req);
    const reservation = await updateReservation(id, payload);
    sendJson(res, 200, reservation);
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

async function createBooking(payload, req) {
  const settings = await readSettings();
  const store = await readReservations();
  const quote = quoteStay(payload.arrival, payload.departure, settings, store);
  const now = new Date().toISOString();
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
  if (guest.guests < 1 || guest.guests > 4) {
    throw userError("Guest count must be between 1 and 4.");
  }

  const stripeEnabled = Boolean(process.env.STRIPE_SECRET_KEY);
  const reservation = {
    id: randomUUID(),
    arrival: payload.arrival,
    departure: payload.departure,
    status: stripeEnabled ? "pending_payment" : "demo_hold",
    paymentStatus: stripeEnabled ? "deposit_due" : "demo_no_payment",
    holdExpiresAt: stripeEnabled ? addMinutes(new Date(), paymentHoldMinutes).toISOString() : null,
    guest,
    quote,
    stripeCheckoutSessionId: null,
    stripePaymentIntentId: null,
    amountPaid: 0,
    createdAt: now,
    updatedAt: now
  };

  let checkoutUrl = null;
  if (stripeEnabled) {
    const session = await createStripeCheckoutSession(reservation, settings, req);
    reservation.stripeCheckoutSessionId = session.id;
    checkoutUrl = session.url;
  }

  store.reservations.push(reservation);
  await writeJson(reservationsPath, store);

  return {
    reservation,
    checkoutUrl,
    demoMode: !stripeEnabled,
    message: stripeEnabled
      ? "Reservation hold created. Continue to Stripe to pay the deposit."
      : "Demo hold created. Add a Stripe test key to take the deposit."
  };
}

async function createStripeCheckoutSession(reservation, settings, req) {
  const baseUrl = process.env.PUBLIC_BASE_URL || `http://${req.headers.host || `localhost:${port}`}`;
  const body = new URLSearchParams();
  body.set("mode", "payment");
  body.set("success_url", `${baseUrl}/success.html?booking=${encodeURIComponent(reservation.id)}`);
  body.set("cancel_url", `${baseUrl}/?booking_cancelled=${encodeURIComponent(reservation.id)}`);
  body.set("customer_email", reservation.guest.email);
  body.set("metadata[booking_id]", reservation.id);
  body.set("payment_intent_data[metadata][booking_id]", reservation.id);
  body.set("line_items[0][quantity]", "1");
  body.set("line_items[0][price_data][currency]", settings.pricing.currency.toLowerCase());
  body.set("line_items[0][price_data][unit_amount]", String(toCents(reservation.quote.depositDue)));
  body.set("line_items[0][price_data][product_data][name]", `Deposit for ${settings.business.siteName}`);
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
      await updateReservation(bookingId, {
        status: "booked",
        paymentStatus: "deposit_paid",
        stripeCheckoutSessionId: session.id,
        stripePaymentIntentId: session.payment_intent,
        amountPaid: centsToDollars(session.amount_total || 0)
      });
    }
  }
  sendJson(res, 200, { received: true });
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
  const store = await readReservations();
  const start = required(payload.start, "Block start");
  const end = required(payload.end, "Block end");
  assertDateRange(start, end);
  const block = {
    id: randomUUID(),
    start,
    end,
    reason: String(payload.reason || "Manual block"),
    createdAt: new Date().toISOString()
  };
  store.manualBlocks.push(block);
  await writeJson(reservationsPath, store);
  return block;
}

async function syncLodgify() {
  if (!process.env.LODGIFY_API_KEY) {
    throw userError("Lodgify API key is not configured on this staging service.");
  }

  const store = await readReservations();
  const settings = await readSettings();
  try {
    const result = await syncLodgifyData(store, {
      apiKey: process.env.LODGIFY_API_KEY,
      months: Number(process.env.LODGIFY_SYNC_MONTHS || 12) || 12,
      apiBaseUrl: process.env.LODGIFY_API_BASE_URL,
      propertyId: process.env.LODGIFY_PROPERTY_ID || settings.business?.lodgifyPropertyId,
      roomTypeId: process.env.LODGIFY_ROOM_TYPE_ID || settings.business?.lodgifyRoomTypeId
    });
    await writeJson(reservationsPath, result.store);
    return {
      importedBookings: result.importedBookings,
      availabilityBlocks: result.availabilityBlocks,
      syncedAt: result.syncedAt,
      warnings: result.warnings || []
    };
  } catch (error) {
    console.error(error);
    throw userError(error.safeMessage || "Lodgify sync failed. Check the API key and try again.", 502);
  }
}

async function updateReservation(id, patch) {
  const store = await readReservations();
  const reservation = store.reservations.find((item) => item.id === id);
  if (!reservation) {
    throw userError("Reservation not found.", 404);
  }
  Object.assign(reservation, pick(patch, ["status", "paymentStatus", "stripeCheckoutSessionId", "stripePaymentIntentId", "amountPaid"]));
  reservation.updatedAt = new Date().toISOString();
  await writeJson(reservationsPath, store);
  return reservation;
}

async function replaceReservation(nextReservation) {
  const store = await readReservations();
  const index = store.reservations.findIndex((item) => item.id === nextReservation.id);
  if (index !== -1) {
    store.reservations[index] = nextReservation;
    await writeJson(reservationsPath, store);
  }
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

function toCents(value) {
  return Math.round(Number(value) * 100);
}

function centsToDollars(value) {
  return roundMoney(Number(value) / 100);
}

function pick(object, keys) {
  return Object.fromEntries(keys.filter((key) => key in object).map((key) => [key, object[key]]));
}

async function readSettings() {
  return JSON.parse(await readFile(settingsPath, "utf8"));
}

async function readReservations() {
  return JSON.parse(await readFile(reservationsPath, "utf8"));
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

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function requiresStagingAuth(url) {
  if (!process.env.STAGING_PASSWORD) return false;
  return !["/api/health", "/api/stripe/webhook"].includes(url.pathname);
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
    stripeMode: stripeMode()
  };
}

function getStagingStatus() {
  return {
    label: process.env.STAGING_LABEL || "Local prototype",
    privateAccessEnabled: Boolean(process.env.STAGING_PASSWORD),
    publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${port}`,
    storage: "local-json",
    stripeConfigured: Boolean(process.env.STRIPE_SECRET_KEY),
    stripeMode: stripeMode(),
    stripeWebhookConfigured: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
    liveStripeUnlocked: process.env.ALLOW_LIVE_STRIPE === "true",
    lodgifySyncConfigured: Boolean(process.env.LODGIFY_API_KEY),
    emailConfigured: Boolean(process.env.RESEND_API_KEY),
    paymentHoldMinutes
  };
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
