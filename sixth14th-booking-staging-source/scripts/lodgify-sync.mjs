export async function syncLodgifyData(store, options) {
  const apiKey = options.apiKey;
  if (!apiKey) {
    throw lodgifyConfigError("Lodgify API key is not configured.");
  }

  const now = options.now || new Date();
  const months = Number(options.months || 12);
  const apiBaseUrl = String(options.apiBaseUrl || "https://api.lodgify.com/v2").replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl || fetch;

  const lodgifyBookings = await fetchLodgifyBookings({ apiKey, apiBaseUrl, fetchImpl });
  const lodgifyReservations = buildBookingSummaries(lodgifyBookings, now);
  let availabilityBlocks = [];
  const warnings = [];

  try {
    availabilityBlocks = await fetchAvailabilityBlocks({
      apiKey,
      apiBaseUrl,
      fetchImpl,
      months,
      now,
      propertyId: options.propertyId,
      roomTypeId: options.roomTypeId
    });
  } catch (error) {
    warnings.push(`${safeLodgifyMessage(error)} Booking summaries were still imported.`);
  }

  const previousReservations = Array.isArray(store.reservations) ? store.reservations : [];
  const previousAvailabilityBlocks = Array.isArray(store.availabilityBlocks) ? store.availabilityBlocks : [];

  return {
    store: {
      ...store,
      reservations: [
        ...previousReservations.filter((reservation) => reservation.source !== "lodgify"),
        ...lodgifyReservations
      ],
      manualBlocks: Array.isArray(store.manualBlocks) ? store.manualBlocks : [],
      availabilityBlocks: [
        ...previousAvailabilityBlocks.filter((block) => block.source !== "lodgify_availability"),
        ...availabilityBlocks
      ],
      lodgifyLastSyncedAt: now.toISOString()
    },
    importedBookings: lodgifyReservations.length,
    availabilityBlocks: availabilityBlocks.length,
    syncedAt: now.toISOString(),
    warnings
  };
}

async function fetchLodgifyBookings({ apiKey, apiBaseUrl, fetchImpl }) {
  const url = new URL(`${apiBaseUrl}/reservations/bookings`);
  url.searchParams.set("size", "100");
  url.searchParams.set("includeExternal", "true");
  url.searchParams.set("stayFilter", "Upcoming");
  url.searchParams.set("trash", "false");
  return fetchLodgifyJson(fetchImpl, url, apiKey, "Lodgify booking import");
}

function buildBookingSummaries(lodgify, now) {
  const reservations = [];

  for (const booking of bookingItems(lodgify)) {
    const status = String(booking.status || "").toLowerCase();
    const shouldBlock =
      !booking.is_deleted &&
      !["declined", "canceled", "cancelled"].includes(status) &&
      (booking.is_unavailable || ["booked", "tentative", "open"].includes(status));

    if (!shouldBlock) continue;

    reservations.push({
      id: `lodgify-${booking.id}`,
      source: "lodgify",
      externalId: String(booking.id),
      arrival: booking.arrival,
      departure: booking.departure,
      status: `lodgify_${status || "hold"}`,
      paymentStatus: booking.amount_due > 0 ? "lodgify_balance_due" : "lodgify_paid_or_external",
      guest: {
        name: booking.guest?.name || "Imported Lodgify booking",
        email: "",
        phone: "",
        guests: booking.rooms?.[0]?.people || 1,
        notes: "Guest contact details are intentionally not imported."
      },
      quote: {
        arrival: booking.arrival,
        departure: booking.departure,
        nights: nightsBetween(booking.arrival, booking.departure),
        currency: booking.currency_code || "USD",
        lineItems: [],
        subtotal: booking.total_amount || 0,
        taxes: booking.subtotals?.taxes || 0,
        total: booking.total_amount || 0,
        depositDue: 0,
        balanceDue: booking.amount_due || 0,
        checkInTime: normalizeTime(booking.check_in?.time),
        checkOutTime: normalizeTime(booking.check_out?.time)
      },
      stripeCheckoutSessionId: null,
      stripePaymentIntentId: null,
      amountPaid: booking.amount_paid || 0,
      createdAt: booking.created_at || now.toISOString(),
      updatedAt: now.toISOString()
    });
  }

  return reservations;
}

async function fetchAvailabilityBlocks({ apiKey, apiBaseUrl, fetchImpl, months, now, propertyId, roomTypeId }) {
  const today = startOfUtcDay(now);
  const finalDay = addMonths(today, months);
  const blocks = [];
  const candidates = availabilityCandidates(apiBaseUrl, propertyId, roomTypeId);

  for (let cursor = today; cursor < finalDay; cursor = addDays(cursor, 60)) {
    const chunkEnd = new Date(Math.min(addDays(cursor, 59).getTime(), finalDay.getTime()));
    const availability = await fetchAvailabilityChunk({
      apiKey,
      fetchImpl,
      candidates,
      start: dateToIso(cursor),
      end: dateToIso(chunkEnd)
    });

    for (const calendar of normalizeAvailabilityCalendars(availability)) {
      for (const period of availabilityPeriods(calendar)) {
        if (!isUnavailablePeriod(period)) continue;
        const bookingIds = (period.bookings || []).map((booking) => String(booking.id)).filter(Boolean);
        bookingIds.push(...(period.reservationIds || period.reservation_ids || []).map(String).filter(Boolean));
        const start = period.start || period.date;
        const displayEnd = period.end || period.date;
        if (!start || !displayEnd) continue;
        const end = addDaysIso(displayEnd, 1);
        blocks.push({
          id: `lodgify-availability-${start}-${displayEnd}-${bookingIds.join("-") || "blocked"}`,
          source: "lodgify_availability",
          start,
          end,
          displayEnd,
          reason: availabilityReason(period, bookingIds),
          bookingIds,
          createdAt: now.toISOString()
        });
      }
    }
  }

  return mergeAvailabilityBlocks(blocks);
}

async function fetchAvailabilityChunk({ apiKey, fetchImpl, candidates, start, end }) {
  let lastError;
  for (const candidate of candidates) {
    const url = new URL(candidate.url);
    url.searchParams.set("start", start);
    url.searchParams.set("end", end);

    try {
      return await fetchLodgifyJson(fetchImpl, url, apiKey, candidate.label);
    } catch (error) {
      lastError = error;
      if ([401, 403, 429].includes(error.status)) break;
    }
  }
  throw lastError;
}

async function fetchLodgifyJson(fetchImpl, url, apiKey, label) {
  const response = await fetchImpl(url, { headers: lodgifyHeaders(apiKey) });
  const text = await response.text();
  if (!response.ok) {
    throw lodgifyHttpError(label, response.status, text);
  }
  return text ? JSON.parse(text) : null;
}

function bookingItems(lodgify) {
  if (Array.isArray(lodgify)) return lodgify;
  return lodgify?.items || lodgify?.data || [];
}

function availabilityCandidates(apiBaseUrl, propertyId, roomTypeId) {
  const encodedPropertyId = propertyId ? encodeURIComponent(String(propertyId)) : "";
  const encodedRoomTypeId = roomTypeId ? encodeURIComponent(String(roomTypeId)) : "";
  const candidates = [];

  if (encodedPropertyId) {
    candidates.push({ label: "Lodgify property availability sync", url: `${apiBaseUrl}/properties/${encodedPropertyId}/availability` });
    if (encodedRoomTypeId) {
      candidates.push({
        label: "Lodgify room type availability sync",
        url: `${apiBaseUrl}/properties/${encodedPropertyId}/room-types/${encodedRoomTypeId}/availability`
      });
      candidates.push({
        label: "Lodgify room availability sync",
        url: `${apiBaseUrl}/properties/${encodedPropertyId}/rooms/${encodedRoomTypeId}/availability`
      });
    }
  }

  candidates.push({ label: "Lodgify account availability sync", url: `${apiBaseUrl}/availability` });
  return candidates;
}

function normalizeAvailabilityCalendars(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.periods)) return [payload];
  for (const key of ["items", "data", "details", "availability", "availabilities"]) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  return [];
}

function availabilityPeriods(calendar) {
  if (Array.isArray(calendar?.periods)) return calendar.periods;
  if (Array.isArray(calendar?.dateWiseAvailability)) return calendar.dateWiseAvailability;
  if (calendar?.date) return [calendar];
  return [];
}

function isUnavailablePeriod(period) {
  if ("available" in period) return Number(period.available) <= 0 || period.available === false;
  if ("unitsAvailable" in period) return Number(period.unitsAvailable) <= 0;
  if ("units_available" in period) return Number(period.units_available) <= 0;
  const status = String(period.status || "").toLowerCase();
  return ["booked", "blocked", "closed", "unavailable"].includes(status);
}

function mergeAvailabilityBlocks(blocks) {
  const sorted = [...blocks].sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  const merged = [];

  for (const block of sorted) {
    const previous = merged[merged.length - 1];
    const canMerge =
      previous &&
      previous.end >= block.start &&
      previous.reason === block.reason &&
      sameIds(previous.bookingIds, block.bookingIds);

    if (canMerge) {
      previous.end = maxIso(previous.end, block.end);
      previous.displayEnd = maxIso(previous.displayEnd, block.displayEnd);
      continue;
    }
    merged.push({ ...block });
  }

  return merged;
}

function availabilityReason(period, bookingIds) {
  if (bookingIds.length) return "Synced Lodgify booking";
  if (period.closed_period || period.closedPeriod) return "Synced Lodgify closed period";
  if ((period.channel_calendars || []).length) return "Synced channel calendar";
  return "Synced Lodgify unavailable";
}

function lodgifyHeaders(apiKey) {
  return {
    accept: "application/json",
    "accept-language": "en",
    "X-ApiKey": apiKey
  };
}

function lodgifyConfigError(message) {
  const error = new Error(message);
  error.safeMessage = message;
  return error;
}

function lodgifyHttpError(label, status, text) {
  const detail = safeErrorDetail(text);
  const error = new Error(`${label} failed: ${status}${detail ? ` ${detail}` : ""}`);
  error.status = status;
  error.safeMessage = `${label} failed (${status}${detail ? `: ${detail}` : ""}).`;
  return error;
}

function safeErrorDetail(text) {
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    return [parsed.message, parsed.error, parsed.code ? `code ${parsed.code}` : ""].filter(Boolean).join(" ");
  } catch {
    return text.slice(0, 120).replace(/\s+/g, " ");
  }
}

function safeLodgifyMessage(error) {
  return error.safeMessage || "Lodgify availability sync failed.";
}

function nightsBetween(start, end) {
  return Math.round((new Date(`${end}T00:00:00Z`) - new Date(`${start}T00:00:00Z`)) / 86400000);
}

function normalizeTime(value) {
  if (!value) return "";
  const [hour, minute] = value.split(":").map(Number);
  const suffix = hour >= 12 ? "PM" : "AM";
  const displayHour = hour % 12 || 12;
  return `${displayHour}:${String(minute || 0).padStart(2, "0")} ${suffix}`;
}

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDays(date, days) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function addMonths(date, months) {
  const next = new Date(date);
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

function addDaysIso(iso, days) {
  return dateToIso(addDays(new Date(`${iso}T00:00:00Z`), days));
}

function dateToIso(date) {
  return date.toISOString().slice(0, 10);
}

function maxIso(a, b) {
  return a > b ? a : b;
}

function sameIds(a = [], b = []) {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}
