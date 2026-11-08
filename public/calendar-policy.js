// Shared by availability checks and the host calendar. A request or an
// approval alone never reserves dates; owner-created blocks are separate.
export function reservationOccupiesCalendar(reservation) {
  if (!reservation || reservation.archivedAt) return false;
  if (!reservation.arrival || !reservation.departure) return false;
  if (!["booked", "lodgify_booked"].includes(reservation.status)) return false;
  if (["canceled", "declined", "refunded", "demo_no_payment"].includes(reservation.paymentStatus)) return false;
  return Number.isFinite(Number(reservation.amountPaid)) && Number(reservation.amountPaid) > 0;
}
