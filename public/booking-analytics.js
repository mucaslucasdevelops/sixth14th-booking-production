const DAY = 86400000;
const amount = (value) => value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const cents = (value) => Math.round((amount(value) ?? 0) * 100);
function date(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return NaN;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value ? time : NaN;
}

export function calculateBookingAnalytics(reservations, year) {
  const start = Date.UTC(year, 0, 1);
  const end = Date.UTC(year + 1, 0, 1);
  const occupied = new Set();
  const financials = {};
  let bookingCount = 0;
  let missingFinancials = 0;
  for (const reservation of reservations) {
    if (!["booked", "lodgify_booked"].includes(reservation.status)) continue;
    const arrival = date(reservation.arrival);
    const departure = date(reservation.departure);
    if (!(departure > arrival)) continue;
    if (arrival < end && departure > start) {
      bookingCount++;
      for (let night = Math.max(arrival, start); night < Math.min(departure, end); night += DAY) occupied.add(night);
    }
    if (arrival < start || arrival >= end) continue;
    const quote = reservation.quote || {};
    if (amount(quote.total) === null) { missingFinancials++; continue; }
    const currency = /^[A-Z]{3}$/.test(quote.currency || "") ? quote.currency : "USD";
    const totals = financials[currency] ||= { revenue: 0, deposits: 0, due: 0 };
    const total = cents(quote.total);
    const paid = cents(reservation.amountPaid);
    const imported = reservation.source === "lodgify" || reservation.status === "lodgify_booked";
    totals.revenue += total;
    totals.deposits += imported ? 0 : Math.min(paid, cents(quote.depositDue), total);
    totals.due += imported && amount(quote.balanceDue) !== null ? cents(quote.balanceDue) : reservation.paymentStatus === "paid_in_full" ? 0 : Math.max(total - paid, 0);
  }
  for (const totals of Object.values(financials)) for (const key of Object.keys(totals)) totals[key] /= 100;
  return { bookedDays: occupied.size, daysInYear: (end - start) / DAY, bookingCount, financials, missingFinancials };
}
