/* Shared by Squarespace and the booking form. No conversion events are sent here. */
(function () {
  "use strict";
  const KEY = "sixth14th_source_v1";
  const TTL = 90 * 86400000;
  const CAMPAIGN = ["gclid", "gbraid", "wbraid", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
  const CONTEXT = ["trafficSource", "trafficMedium", "landingPage", "referrer", "capturedAt", "firstSource", "firstMedium", "firstLandingPage", "firstReferrer", "firstCapturedAt"];
  const BOOKING_HOSTS = ["sixth14th-booking-production.onrender.com", "book.sixth14th.com"];
  const INTERNAL_HOSTS = ["sixth14th.com", "www.sixth14th.com", ...BOOKING_HOSTS];
  let current;

  function read() {
    for (const storage of ["localStorage", "sessionStorage"]) {
      try {
        const saved = JSON.parse(window[storage].getItem(KEY));
        if (saved && saved.expiresAt > Date.now() && saved.value && typeof saved.value === "object" && !Array.isArray(saved.value)) return saved.value;
      } catch { /* Tracking must work even if storage is blocked. */ }
    }
    return null;
  }

  function save(value) {
    const saved = JSON.stringify({ value, expiresAt: Date.parse(value.capturedAt) + TTL });
    for (const storage of ["localStorage", "sessionStorage"]) {
      try { window[storage].setItem(KEY, saved); } catch { /* Optional persistence. */ }
    }
  }

  function capture() {
    const params = new URLSearchParams(window.location.search);
    const found = {};
    for (const key of CAMPAIGN) {
      const value = params.get(key);
      if (value && value.trim()) found[key] = value.trim().slice(0, 500);
    }
    let referrer = "";
    try { referrer = new URL(document.referrer).hostname.toLowerCase(); } catch { /* No referrer available. */ }
    const external = referrer && !INTERNAL_HOSTS.includes(referrer) && referrer !== window.location.hostname;
    const stored = current || read();
    // s14_ context is written by this script on the marketing site's booking links.
    const forwarded = params.get("s14_trafficSource") && params.get("s14_capturedAt");
    if (Object.keys(found).length || external || forwarded) {
      const paid = found.gclid || found.gbraid || found.wbraid;
      const value = {
        ...found,
        trafficSource: found.utm_source || (paid ? "google" : external ? referrer : "unknown"),
        trafficMedium: found.utm_medium || (paid ? "cpc" : external ? "referral" : "unknown"),
        landingPage: window.location.pathname,
        referrer: external ? referrer : "",
        capturedAt: new Date().toISOString()
      };
      if (forwarded) {
        for (const key of CONTEXT) {
          const item = params.get("s14_" + key);
          if (item) value[key] = item.slice(0, 500);
        }
        const captured = Date.parse(value.capturedAt);
        if (!Number.isFinite(captured) || captured > Date.now() || captured < Date.now() - TTL) {
          value.capturedAt = new Date().toISOString();
        }
      }
      const first = stored || value;
      for (const [key, original] of [["firstSource", "trafficSource"], ["firstMedium", "trafficMedium"], ["firstLandingPage", "landingPage"], ["firstReferrer", "referrer"], ["firstCapturedAt", "capturedAt"]]) {
        value[key] = first[key] ?? first[original] ?? "";
      }
      current = value;
      save(value);
      return { ...value };
    }
    if (stored) return { ...(current = stored) };
    current = { trafficSource: "unknown", trafficMedium: "direct_or_unknown", landingPage: window.location.pathname, capturedAt: new Date().toISOString() };
    // An untagged marketing-site handoff is not evidence of the original source.
    if (referrer) current.referrer = referrer;
    return { ...current };
  }

  function decorate() {
    const value = current || capture();
    for (const link of document.querySelectorAll("a[href]")) {
      let target;
      try { target = new URL(link.href); } catch { continue; }
      if (!BOOKING_HOSTS.includes(target.hostname) || target.pathname !== "/" || target.protocol !== "https:") continue;
      for (const key of CAMPAIGN) {
        if (value[key]) target.searchParams.set(key, value[key]);
      }
      for (const key of CONTEXT) {
        if (value[key]) target.searchParams.set("s14_" + key, value[key]);
      }
      if (link.href !== target.href) link.href = target.href;
    }
  }

  capture();
  window.sixth14thAttribution = { capture };
  decorate();
  document.addEventListener("pointerdown", decorate, true);
  document.addEventListener("keydown", decorate, true);
  document.addEventListener("click", decorate, true);
  new MutationObserver(decorate).observe(document.documentElement, { childList: true, subtree: true });
})();
