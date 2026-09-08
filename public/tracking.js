const DEFAULT_GOOGLE_ADS_ID = "AW-18386448301";
const DEFAULT_GOOGLE_ADS_CONVERSION_LABEL = "d5yYCNPXtugcEK3fq79E";
const GOOGLE_TAG_SCRIPT_ID = "sixth14th-google-tag";

const trackingState = {
  adsId: DEFAULT_GOOGLE_ADS_ID,
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
    const configuredLabel = normalizeConversionLabel(tracking.googleAdsConversionLabel, configuredAdsId);
    trackingState.adsId = configuredAdsId && configuredLabel ? configuredAdsId : DEFAULT_GOOGLE_ADS_ID;
    trackingState.conversionLabel = configuredAdsId && configuredLabel ? configuredLabel : DEFAULT_GOOGLE_ADS_CONVERSION_LABEL;
    trackingState.debug = Boolean(tracking.debug);
    installGoogleTag(trackingState.adsId);
    trackingState.ready = true;
    debugLog("Google Ads tracking initialized for begin-checkout conversion", {
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
    debugLog("Begin-checkout conversion skipped because Google Ads tracking is unavailable", {
      adsId: trackingState.adsId,
      hasConversionLabel: Boolean(trackingState.conversionLabel)
    });
    return false;
  }

  debugLog("Sending begin-checkout Google Ads conversion", {
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

    window.gtag("event", "conversion", {
      send_to: `${trackingState.adsId}/${trackingState.conversionLabel}`,
      event_callback: finish,
      event_timeout: 1000
    });
    setTimeout(finish, 1200);
  });
}

function installGoogleTag(adsId) {
  window.dataLayer = window.dataLayer || [];
  window.gtag = window.gtag || function gtag() {
    window.dataLayer.push(arguments);
  };
  window.gtag("js", new Date());
  window.gtag("config", adsId);

  if (document.getElementById(GOOGLE_TAG_SCRIPT_ID)) return;
  const script = document.createElement("script");
  script.id = GOOGLE_TAG_SCRIPT_ID;
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(adsId)}`;
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
