import assert from 'node:assert/strict';
import { calculateBookingAnalytics as calculate } from '../public/booking-analytics.js';
const stay = (overrides = {}) => ({ status: 'booked', arrival: '2026-01-01', departure: '2026-01-04', quote: { total: 1000, depositDue: 500, currency: 'USD' }, amountPaid: 500, ...overrides });
const result = calculate([
  stay({ archivedAt: '2026-02-01' }),
  stay({ arrival: '2025-12-30', departure: '2026-01-02' }),
  stay({ arrival: '2026-12-31', departure: '2027-01-03', amountPaid: 1000, paymentStatus: 'paid_in_full' }),
  ...['canceled', 'declined', 'pending_payment', 'pending_approval', 'lodgify_tentative'].map(status => stay({ status })),
], 2026);
assert.equal(result.bookedDays, 1);
assert.equal(result.daysInYear, 231);
assert.deepEqual(result.financials.USD, { revenue: 2000, deposits: 1000, due: 500 });
assert.equal(calculate([stay({ arrival: '2024-02-28', departure: '2024-03-01' })], 2024).bookedDays, 2);
assert.equal(calculate([], 2024).daysInYear, 366);
assert.equal(calculate([stay({ arrival: '2026-05-14', departure: '2026-05-16' })], 2026).bookedDays, 1);
assert.deepEqual(calculate([], 2026).financials, {});
assert.equal(calculate([stay({ arrival: '2026-02-30' })], 2026).bookedDays, 0);
const imported = calculate([stay({ status: 'lodgify_booked', source: 'lodgify', quote: { total: 900, balanceDue: 200, currency: 'EUR' } }), stay({ quote: null })], 2026);
assert.deepEqual(imported.financials.EUR, { revenue: 900, deposits: 0, due: 200 });
assert.equal(imported.missingFinancials, 1);
assert.equal(calculate([stay({ amountPaid: 1200 })], 2026).financials.USD.due, 0);
console.log('PASS booking analytics: year boundaries, overlaps, leap years, statuses, archived stays, deposits, balances, imports, currencies, and missing data');
