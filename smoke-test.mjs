const baseUrl = process.env.SMOKE_BASE_URL || "http://localhost:4173";
const auth = process.env.SMOKE_USERNAME && process.env.SMOKE_PASSWORD
  ? `Basic ${Buffer.from(`${process.env.SMOKE_USERNAME}:${process.env.SMOKE_PASSWORD}`).toString("base64")}`
  : null;
const availableArrival = nextWeekdayIso(0, 180);
const availableDeparture = addDaysIso(availableArrival, 2);

const checks = [
  ["health", "GET", "/api/health"],
  ["config", "GET", "/api/config"],
  ["success page", "GET", "/success.html"],
  ["status", "GET", "/api/staging/status"],
  ["available quote", "POST", "/api/quote", { arrival: availableArrival, departure: availableDeparture, guests: 2 }],
  ["blocked quote", "POST", "/api/quote", { arrival: "2026-05-15", departure: "2026-05-17", guests: 2 }, 400]
];

let failures = 0;

for (const [name, method, path, body, expectedStatus = 200] of checks) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(auth ? { authorization: auth } : {}),
      ...(body ? { "content-type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const passed = response.status === expectedStatus;
  console.log(`${passed ? "PASS" : "FAIL"} ${name}: ${response.status}`);
  if (!passed) failures += 1;

  if (passed && name === "success page") {
    const html = await response.text();
    const hasGoogleTag = html.includes("https://www.googletagmanager.com/gtag/js?id=AW-18244613356");
    const hasConversion = html.includes("AW-18244613356/2W2tCPPk7gcEKqktoD");
    console.log(`${hasGoogleTag ? "PASS" : "FAIL"} success page Google tag`);
    console.log(`${hasConversion ? "PASS" : "FAIL"} success page conversion event`);
    if (!hasGoogleTag || !hasConversion) failures += 1;
  }
}

if (failures) {
  process.exit(1);
}

function nextWeekdayIso(weekday, minimumDaysAway) {
  let date = addDays(startOfUtcDay(new Date()), minimumDaysAway);
  while (date.getUTCDay() !== weekday) {
    date = addDays(date, 1);
  }
  return dateToIso(date);
}

function addDaysIso(iso, days) {
  return dateToIso(addDays(new Date(`${iso}T00:00:00.000Z`), days));
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
