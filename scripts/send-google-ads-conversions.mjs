const baseUrl = process.env.CRON_TARGET_URL || process.env.PUBLIC_BASE_URL;
const secret = process.env.CRON_SECRET;
const dryRun = process.env.GOOGLE_ADS_DELIVERY_DRY_RUN === "true";

if (!baseUrl) {
  console.error("CRON_TARGET_URL or PUBLIC_BASE_URL is required.");
  process.exit(1);
}

if (!secret) {
  console.error("CRON_SECRET is required.");
  process.exit(1);
}

const url = new URL("/api/cron/send-google-ads-conversions", baseUrl);
if (dryRun) url.searchParams.set("dryRun", "true");

const response = await fetch(url, {
  method: "POST",
  headers: {
    "x-cron-secret": secret
  }
});

const text = await response.text();
let payload = {};
try {
  payload = text ? JSON.parse(text) : {};
} catch {
  payload = { error: text || "Unexpected non-JSON response." };
}

if (!response.ok) {
  console.error(`Google Ads conversion delivery failed (${response.status}).`);
  console.error(payload.error || payload);
  process.exit(1);
}

console.log(
  [
    `Google Ads conversion delivery complete.`,
    `Configured: ${payload.configured ? "yes" : "no"}.`,
    `Dry run: ${payload.dryRun ? "yes" : "no"}.`,
    `Sent: ${payload.sent || 0}.`,
    `Failed: ${payload.failed || 0}.`,
    `Pending: ${payload.pending || 0}.`,
    payload.message || ""
  ].filter(Boolean).join(" ")
);

if (Number(payload.failed || 0) > 0) {
  process.exit(1);
}
