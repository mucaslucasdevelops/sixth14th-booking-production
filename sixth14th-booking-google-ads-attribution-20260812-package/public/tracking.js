const DEFAULT_GOOGLE_ADS_ID = "AW-994349610";

const trackingState = {
  adsId: DEFAULT_GOOGLE_ADS_ID,
  conversionLabel: "",
  debug: false,
  ready: false
};

const trackingReady = initTracking();

window.sixth14thTracking = {
  ready: trackingReady,
  trackBookingRequestConversion
};

async function initTracking() {
  try {
    const config = await fetchJson("/api/config");
    const tracking = config.tracking || {};
    trackingState.adsId = tracking.googleAdsId || DEFAULT_GOOGLE_ADS_ID;
    trackingState.conversionLabel = normalizeConversionLabel(tracking.googleAdsConversionLabel, trackingState.adsId);
    trackingState.debug = Boolean(tracking.debug);
    trackingState.ready = false;
    debugLog("Google Ads delivery disabled; attribution is capture-only", {
      adsId: trackingState.adsId,
      hasConversionLabel: Boolean(trackingState.conversionLabel)
    });
  } catch (error) {
    console.warn("[Sixth14th tracking] Google Ads tracking did not initialize.", error);
  }
}

async function trackBookingRequestConversion(details = {}) {
  await trackingReady;
  debugLog("Booking request conversion delivery skipped; attribution is capture-only", {
    adsId: trackingState.adsId,
    hasConversionLabel: Boolean(trackingState.conversionLabel),
    hasTransactionId: Boolean(details.transactionId),
    value: details.value,
    currency: details.currency
  });
  return false;
}

function normalizeConversionLabel(value, adsId) {
  const label = String(value || "").trim();
  if (!label) return "";
  const sendToPrefix = `${adsId}/`;
  if (label.startsWith(sendToPrefix)) return label.slice(sendToPrefix.length);
  if (label.startsWith("AW-") && label.includes("/")) return label.split("/").pop();
  return label;
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
  return response.json();
}

function debugLog(message, detail) {
  if (!trackingState.debug) return;
  if (detail) {
    console.log(`[Sixth14th tracking] ${message}`, detail);
  } else {
    console.log(`[Sixth14th tracking] ${message}`);
  }
}
