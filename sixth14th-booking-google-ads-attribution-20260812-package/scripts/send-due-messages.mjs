const baseUrl = process.env.CRON_TARGET_URL || process.env.PUBLIC_BASE_URL;
const secret = process.env.CRON_SECRET;

if (!baseUrl) {
  console.error("CRON_TARGET_URL or PUBLIC_BASE_URL is required.");
  process.exit(1);
}

if (!secret) {
  console.error("CRON_SECRET is required.");
  process.exit(1);
}

const url = new URL("/api/cron/send-due-messages", baseUrl);
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
  console.error(`Send due messages failed (${response.status}).`);
  console.error(payload.error || payload);
  process.exit(1);
}

console.log(
  [
    `Send due messages complete.`,
    `Sent: ${payload.sent || 0}.`,
    `Failed: ${payload.failed || 0}.`,
    `Ready: ${payload.ready || 0}.`,
    payload.message || ""
  ].filter(Boolean).join(" ")
);

if (Number(payload.failed || 0) > 0) {
  const failedDeliveries = Array.isArray(payload.queue)
    ? payload.queue.filter((delivery) => delivery?.status === "failed")
    : [];
  for (const delivery of failedDeliveries) {
    console.error(
      [
        `Failed delivery: ${delivery.messageName || delivery.messageId || delivery.id}.`,
        `Guest: ${delivery.recipientName || "Guest"}.`,
        `Email: ${delivery.recipientEmail || "missing"}.`,
        `Error: ${delivery.error || delivery.email?.error || "No provider error returned."}`
      ].join(" ")
    );
  }
  process.exit(1);
}
