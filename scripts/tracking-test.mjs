import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../public/tracking.js", import.meta.url), "utf8");
const expectedTag = "GT-MBGGQJGQ";
const expectedDestination = "AW-994349610/YoJWCNCQsKAdEKqkktoD";

async function loadTracker(tracking = {}) {
  const scripts = [];
  const window = {};
  const context = vm.createContext({
    window,
    document: {
      getElementById: id => scripts.find(script => script.id === id),
      createElement: () => ({}),
      head: { append: script => scripts.push(script) }
    },
    fetch: async url => {
      assert.equal(url, "/api/config");
      return { ok: true, json: async () => ({ tracking }) };
    },
    console,
    // Exercise the bounded redirect fallback without contacting Google.
    setTimeout: callback => queueMicrotask(callback)
  });
  vm.runInContext(source, context);
  await window.sixth14thTracking.ready;
  return { window, scripts, commands: () => window.dataLayer.map(args => Array.from(args)) };
}

for (const config of [{}, {
  googleAdsId: "AW-994349610",
  googleTagId: expectedTag,
  googleAdsConversionLabel: "YoJWCNCQsKAdEKqkktoD"
}]) {
  const tracker = await loadTracker(config);
  assert.equal(tracker.scripts.length, 1);
  assert.equal(tracker.scripts[0].src, `https://www.googletagmanager.com/gtag/js?id=${expectedTag}`);
  assert.equal(tracker.commands().find(command => command[0] === "config")[1], expectedTag);
  // A success-page load configures the container's automatic deposit rule,
  // without adding a second manual deposit conversion.
  assert.equal(tracker.commands().filter(command => command[0] === "event").length, 0);
  await tracker.window.sixth14thTracking.trackBookingRequestConversion({
    transactionId: "test-reservation", value: 820.5, currency: "USD"
  });
  const events = tracker.commands().filter(command => command[0] === "event");
  assert.equal(events.length, 1);
  assert.equal(events[0][1], "conversion");
  assert.equal(events[0][2].send_to, expectedDestination);
  assert.equal(events[0][2].transaction_id, "test-reservation");
  assert.equal(events[0][2].value, 820.5);
  assert.equal(events[0][2].currency, "USD");
}
console.log("PASS Google tag loader, exact booking label, value and transaction ID, and no duplicate manual deposit event");
