const DAY = 86400000;
const number = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
function date(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return NaN;
  const result = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(result) && new Date(result).toISOString().slice(0, 10) === value ? result : NaN;
}
export function calculateHousekeeping(reservations, month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '')) return null;
  const start = date(`${month}-01`);
  const endDate = new Date(start); endDate.setUTCMonth(endDate.getUTCMonth() + 1);
  const end = endDate.getTime();
  const rows = [], occupied = new Set(), paidByCurrency = {};
  let stays = 0, guests = 0, guestNights = 0, turnovers = 0, missingGuests = 0, missingPayments = 0;
  for (const r of reservations) {
    if (!['booked', 'lodgify_booked'].includes(r?.status)) continue;
    const arrival = date(r.arrival), departure = date(r.departure);
    if (!(departure > arrival)) continue;
    const nights = Math.max(0, (Math.min(departure, end) - Math.max(arrival, start)) / DAY);
    const turnover = departure >= start && departure < end;
    if (!nights && !turnover) continue;
    const count = number(r.guest?.guests);
    const guestCount = Number.isInteger(count) && count > 0 ? count : null;
    if (nights) {
      stays++;
      if (guestCount === null) missingGuests++; else { guests += guestCount; guestNights += guestCount * nights; }
      for (let d = Math.max(arrival, start); d < Math.min(departure, end); d += DAY) occupied.add(d);
    }
    if (turnover) turnovers++;
    const total = number(r.quote?.total), paid = number(r.amountPaid);
    const imported = r.source === 'lodgify' || r.status === 'lodgify_booked';
    const balance = imported && number(r.quote?.balanceDue) !== null ? number(r.quote.balanceDue) : total !== null && paid !== null ? Math.max(0, total - paid) : null;
    const currency = /^[A-Z]{3}$/.test(r.quote?.currency || '') ? r.quote.currency : 'USD';
    if (paid === null) missingPayments++; else paidByCurrency[currency] = (paidByCurrency[currency] || 0) + Math.round(paid * 100);
    rows.push({ id: r.id || '', name: r.guest?.name || 'Guest name unavailable', arrival: r.arrival, departure: r.departure, guests: guestCount, totalNights: (departure - arrival) / DAY, nights, turnover, total, paid, balance, currency, imported });
  }
  rows.sort((a,b) => a.arrival.localeCompare(b.arrival) || String(a.id).localeCompare(String(b.id)));
  return { month, rows, stays, guests, guestNights, turnovers, occupiedNights: occupied.size, paidByCurrency, missingGuests, missingPayments };
}
const headings = ['Booking ID', 'Guest', 'Guests', 'Check-in', 'Check-out', 'Full stay nights', 'Nights in month', 'Turnover in month', 'Currency', 'Booking total', 'Amount paid to date', 'Balance due', 'Source'];
function cells(row) { return [row.id, row.name, row.guests, row.arrival, row.departure, row.totalNights, row.nights, row.turnover ? 'Yes' : 'No', row.currency, row.total, row.paid, row.balance, row.imported ? 'Lodgify' : 'Direct']; }
export function housekeepingCsv(report) {
  const quote = value => {
    let text = value === null || value === undefined ? 'Unknown' : String(value);
    if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  return '\uFEFF' + [['Report month', ...headings], ...report.rows.map(row => [report.month, ...cells(row)])].map(row => row.map(quote).join(',')).join('\r\n');
}
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
function money(value, currency) {
  if (value === null) return 'Unknown';
  try { return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(value); }
  catch { return `${currency} ${value.toFixed(2)}`; }
}
export function mountHousekeepingReport() {
  const get = id => document.getElementById(id);
  const input = get('housekeepingMonth');
  input.value = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit' }).formatToParts(new Date()).filter(p => ['year','month'].includes(p.type)).sort((a,b) => a.type === 'year' ? -1 : 1).map(p => p.value).join('-');
  let reservations = [], blocks = [], report;
  function render() {
    report = calculateHousekeeping(reservations, input.value);
    get('housekeepingCsv').disabled = !report;
    if (!report) { get('housekeepingPeriod').textContent = 'Choose a valid month.'; get('housekeepingSummary').replaceChildren(); get('housekeepingTable').replaceChildren(); get('housekeepingCoverage').textContent = ''; return; }
    get('housekeepingPeriod').textContent = new Date(`${report.month}-01T00:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const paid = Object.entries(report.paidByCurrency).map(([currency, cents]) => money(cents / 100, currency)).join(' / ') || (report.rows.length ? 'Unknown' : money(0, 'USD'));
    const metrics = [['Stays with nights', report.stays], ['Guests' + (report.missingGuests ? ' (known)' : ''), report.guests], ['Occupied nights', report.occupiedNights], ['Guest-nights' + (report.missingGuests ? ' (known)' : ''), report.guestNights], ['Cleaning turnovers', report.turnovers], ['Paid toward listed bookings', paid]];
    get('housekeepingSummary').innerHTML = metrics.map(([label, value]) => `<article class="analytics-card"><span>${escape(label)}</span><strong>${escape(value)}</strong></article>`).join('');
    get('housekeepingCoverage').textContent = `${report.missingGuests} stays missing guest counts; ${report.missingPayments} listed bookings missing payment amounts. Unknown values are not counted. Availability-only blocks are excluded.${blocks.length ? ' Imported availability blocks exist and may represent stays missing from this report.' : ''}${report.rows.some(r => r.imported) ? ' Lodgify figures reflect the last import; its guest count may default to 1 and absent payment values may default to zero. Verify imported records before using totals.' : ''} Checkout on the first day appears for cleaning with zero nights in this month.`;
    get('housekeepingTable').innerHTML = report.rows.length ? `<table><caption class="muted">${report.rows.length} bookings with nights or checkout in this month</caption><thead><tr>${headings.map(h => `<th scope="col">${escape(h)}</th>`).join('')}</tr></thead><tbody>${report.rows.map(row => `<tr>${cells(row).map((value, i) => `<td>${escape(i >= 9 && i <= 11 ? money(value, row.currency) : value ?? 'Unknown')}</td>`).join('')}</tr>`).join('')}</tbody></table>` : '<p class="muted">No confirmed stays or cleaning turnovers for this month.</p>';
  }
  input.addEventListener('change', render);
  get('housekeepingCsv').addEventListener('click', () => {
    if (!report) return;
    const url = URL.createObjectURL(new Blob([housekeepingCsv(report)], { type: 'text/csv;charset=utf-8;' }));
    const link = document.createElement('a'); link.href = url; link.download = `sixth14th-housekeeping-${report.month}.csv`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  get('housekeepingPrint').addEventListener('click', () => {
    document.body.classList.add('printing-housekeeping');
    window.print();
    document.body.classList.remove('printing-housekeeping');
  });
  return { update(nextReservations, nextBlocks) { reservations = nextReservations; blocks = nextBlocks; render(); } };
}
