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

  await check("private staging allows authenticated API reads", async () => {
    const response = await request(context, "GET", "/api/staging/status");
    assert(response.status === 200, `expected 200, got ${response.status}`);
    assert(response.body.privateAccessEnabled === true, "private access is not enabled");
    assert(response.body.stripeWebhookConfigured === true, "webhook secret should be configured in regression");
    assert(response.body.liveStripeUnlocked === false, "live Stripe should remain locked");
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

  await check("manual blocks prevent quoting", async () => {
    const start = nextWeekdayIso(2, 75);
    const end = addDaysIso(start, 2);
    const block = await request(context, "POST", "/api/admin/blocks", { start, end, reason: "Regression block" });
    assert(block.status === 201, `expected block 201, got ${block.status}`);
    const response = await quote(context, start, end);
    assert(response.status === 400, `expected blocked quote 400, got ${response.status}`);
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
  await check("booking hold blocks duplicate dates", async () => {
    const response = await request(context, "POST", "/api/bookings", {
      arrival: sixNightArrival,
      departure: sixNightDeparture,
      guests: 2,
      name: "QA Guest",
      email: "qa@example.com",
      phone: "5551234567",
      notes: "Regression test"
    });
    assert(response.status === 201, `expected 201, got ${response.status}`);
    assert(response.body.demoMode === true, "local regression should not use Stripe checkout");
    booking = response.body.reservation;

    const duplicate = await quote(context, sixNightArrival, sixNightDeparture);
    assert(duplicate.status === 400, `expected duplicate quote 400, got ${duplicate.status}`);

    const availability = await request(context, "GET", `/api/availability?start=${sixNightArrival}&end=${addDaysIso(sixNightArrival, 1)}`);
    assert(availability.status === 200, `expected availability 200, got ${availability.status}`);
    assert(availability.body.days[0].available === false, "arrival day should be unavailable after hold");
  });

  await check("webhook rejects bad signatures", async () => {
    const response = await request(context, "POST", "/api/stripe/webhook", { type: "checkout.session.completed" }, {
      auth: false,
      headers: { "stripe-signature": "t=1,v1=bad" }
    });
    assert(response.status === 400, `expected 400, got ${response.status}`);
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
  });

  await check("admin can cancel a pending hold and release dates", async () => {
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
    assert(response.status === 201, `expected hold 201, got ${response.status}`);
    const booking = response.body.reservation;

    const blocked = await quote(context, arrival, departure);
    assert(blocked.status === 400, `expected pending hold to block dates, got ${blocked.status}`);

    const canceled = await request(context, "PATCH", `/api/admin/reservations/${booking.id}`, {
      status: "canceled",
      paymentStatus: "canceled"
    });
    assert(canceled.status === 200, `expected cancel 200, got ${canceled.status}`);
    assert(canceled.body.status === "canceled", `expected canceled, got ${canceled.body.status}`);

    const available = await quote(context, arrival, departure);
    assert(available.status === 200, `expected canceled hold to release dates, got ${available.status}`);
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

async function startApp() {
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
      STRIPE_SECRET_KEY: "",
      STRIPE_WEBHOOK_SECRET: webhookSecret,
      LODGIFY_API_KEY: lodgify.apiKey,
      LODGIFY_API_BASE_URL: lodgify.baseUrl,
      LODGIFY_SYNC_MONTHS: "6",
      PAYMENT_HOLD_MINUTES: "30"
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
