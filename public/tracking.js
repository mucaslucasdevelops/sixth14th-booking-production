const DEFAULT_GOOGLE_ADS_ID = "AW-994349610";
// The loader ID is distinct from the Ads event destination. The AW alias
// currently loads another container; use the account's installation snippet.
const DEFAULT_GOOGLE_TAG_ID = "GT-MBGGQJGQ";
// "Booking request" conversion action (Primary for Submit lead forms in the
// "Sixth & 14th — Advertising" account). Label copied verbatim from the
// action's event snippet in Google Ads; do not change without updating it there too.
const DEFAULT_GOOGLE_ADS_CONVERSION_LABEL = "YoJWCNCQsKAdEKqkktoD";
const GOOGLE_TAG_SCRIPT_ID = "sixth14th-google-tag";

const trackingState = {
  adsId: DEFAULT_GOOGLE_ADS_ID,
  tagId: DEFAULT_GOOGLE_TAG_ID,
  conversionLabel: DEFAULT_GOOGLE_ADS_CONVERSION_LABEL,
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
    const configuredAdsId = normalizeGoogleAdsId(tracking.googleAdsId);
    trackingState.tagId = /^GT-[A-Z0-9]+$/.test(tracking.googleTagId || "")
      ? tracking.googleTagId : DEFAULT_GOOGLE_TAG_ID;
    const configuredLabel = normalizeConversionLabel(tracking.googleAdsConversionLabel, configuredAdsId);
    trackingState.adsId = configuredAdsId && configuredLabel ? configuredAdsId : DEFAULT_GOOGLE_ADS_ID;
    trackingState.conversionLabel = configuredAdsId && configuredLabel ? configuredLabel : DEFAULT_GOOGLE_ADS_CONVERSION_LABEL;
    trackingState.debug = Boolean(tracking.debug);
    installGoogleTag(trackingState.tagId);
    trackingState.ready = true;
    debugLog("Google Ads tracking initialized for booking requests", {
      adsId: trackingState.adsId,
      hasConversionLabel: Boolean(trackingState.conversionLabel)
    });
  } catch (error) {
    console.warn("[Sixth14th tracking] Google Ads tracking did not initialize.", error);
  }
}

async function trackBookingRequestConversion(details = {}) {
  await trackingReady;
  if (!trackingState.ready || !trackingState.adsId || !trackingState.conversionLabel || typeof window.gtag !== "function") {
    debugLog("Booking request conversion skipped because Google Ads tracking is unavailable", {
      adsId: trackingState.adsId,
      hasConversionLabel: Boolean(trackingState.conversionLabel)
    });
    return false;
  }

  debugLog("Sending booking request Google Ads conversion", {
    adsId: trackingState.adsId,
    hasConversionLabel: Boolean(trackingState.conversionLabel),
    hasTransactionId: Boolean(details.transactionId),
    value: details.value,
    currency: details.currency
  });
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(true);
    };

    // Fire the "Booking request" conversion in Google Ads. value/currency/
    // transaction_id are passed through so the action (configured for dynamic
    // values) records the real booking value for future ROAS bidding.
    const eventParams = {
      send_to: `${trackingState.adsId}/${trackingState.conversionLabel}`,
      event_callback: finish,
      event_timeout: 1000
    };
    if (typeof details.value === "number" && Number.isFinite(details.value)) {
      eventParams.value = details.value;
    }
    if (details.currency) {
      eventParams.currency = details.currency;
    }
    if (details.transactionId) {
      eventParams.transaction_id = String(details.transactionId);
    }
    window.gtag("event", "conversion", eventParams);
    setTimeout(finish, 1200);
  });
}

function installGoogleTag(tagId) {
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function gtag() {
    window.dataLayer.push(arguments);
  };
  window.gtag("js", new Date());
  window.gtag("config", tagId);

  if (document.getElementById(GOOGLE_TAG_SCRIPT_ID)) return;
  const script = document.createElement("script");
  script.id = GOOGLE_TAG_SCRIPT_ID;
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(tagId)}`;
  document.head.append(script);
}

function normalizeConversionLabel(value, adsId) {
  const label = String(value || "").trim();
  if (!label) return "";
  const sendToPrefix = `${adsId}/`;
  if (label.startsWith(sendToPrefix)) return label.slice(sendToPrefix.length);
  if (label.startsWith("AW-") && label.includes("/")) return label.split("/").pop();
  return label;
}

function normalizeGoogleAdsId(value) {
  const id = String(value || "").trim();
  return /^AW-\d+$/.test(id) ? id : "";
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
