const DEFAULT_GOOGLE_ADS_ID = "AW-18244613356";

const trackingState = {
  adsId: DEFAULT_GOOGLE_ADS_ID,
  conversionLabel: "",
  debug: false,
  ready: false,
  initialized: false
};

const trackingReady = initTracking();

/**
 * Public API
 */
window.sixth14thTracking = {
  ready: trackingReady,
  trackBookingRequestConversion,
  firePurchaseConversion
};

async function initTracking() {
  try {
    const config = await fetchJson("/api/config");
    const tracking = config.tracking || {};

    trackingState.adsId = tracking.googleAdsId || DEFAULT_GOOGLE_ADS_ID;
    trackingState.conversionLabel = normalizeConversionLabel(
      tracking.googleAdsConversionLabel,
      trackingState.adsId
    );
    trackingState.debug = Boolean(tracking.debug);
    trackingState.initialized = true;

    loadGoogleAdsTag(trackingState.adsId);

    debugLog("Tracking initialized", trackingState);
  } catch (error) {
    console.warn("[Sixth14th tracking] init failed, using defaults", error);
    trackingState.adsId = DEFAULT_GOOGLE_ADS_ID;
    loadGoogleAdsTag(trackingState.adsId);
  }
}

/**
 * Load Google Ads base tag if not already present
 */
function loadGoogleAdsTag(adsId) {
  if (window.gtag) return;

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${adsId}`;
  document.head.appendChild(script);

  window.dataLayer = window.dataLayer || [];
  window.gtag = function () {
    window.dataLayer.push(arguments);
  };

  window.gtag("js", new Date());
  window.gtag("config", adsId);

  debugLog("Google Ads tag loaded", { adsId });
}

/**
 * FIRE CONVERSION (shared core function)
 */
function fireGoogleAdsConversion({ value = 1, currency = "USD", transactionId, labelOverride } = {}) {
  if (!window.gtag) {
    console.warn("[Sixth14th tracking] gtag not available");
    return false;
  }

  const label = labelOverride || trackingState.conversionLabel;

  if (!label) {
    console.warn("[Sixth14th tracking] Missing conversion label");
    return false;
  }

  window.gtag("event", "conversion", {
    send_to: `${trackingState.adsId}/${label}`,
    value,
    currency,
    transaction_id: transactionId
  });

  debugLog("Google Ads conversion fired", {
    send_to: `${trackingState.adsId}/${label}`,
    value,
    currency,
    transactionId
  });

  return true;
}

/**
 * 1. BOOKING REQUEST (intent signal)
 */
async function trackBookingRequestConversion(details = {}) {
  await trackingReady;

  return fireGoogleAdsConversion({
    value: details.value || 1,
    currency: details.currency || "USD",
    transactionId: details.transactionId
  });
}

/**
 * 2. PURCHASE CONVERSION (Stripe success page)
 */
function firePurchaseConversion(details = {}) {
  return fireGoogleAdsConversion({
    value: details.value || 1,
    currency: details.currency || "USD",
    transactionId: details.transactionId
  });
}

/**
 * Normalize conversion label formats
 */
function normalizeConversionLabel(value, adsId) {
  const label = String(value || "").trim();
  if (!label) return "";

  const prefix = `${adsId}/`;

  if (label.startsWith(prefix)) {
    return label.slice(prefix.length);
  }

  if (label.includes("/")) {
    return label.split("/").pop();
  }

  return label;
}

/**
 * Fetch config
 */
async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed: ${response.status}`);
  return response.json();
}

/**
 * Debug logging
 */
function debugLog(message, detail) {
  if (!trackingState.debug) return;
  if (detail) {
    console.log(`[Sixth14th tracking] ${message}`, detail);
  } else {
    console.log(`[Sixth14th tracking] ${message}`);
  }
}
