let adminData = { reservations: [] };
let refreshPromise = null;
let enhanceScheduled = false;

installEnhancementStyles();
await refreshAdminData();
scheduleEnhance();

document.querySelector("#refreshAdmin")?.addEventListener("click", () => {
  refreshAdminData().then(scheduleEnhance).catch(console.warn);
});
document.querySelector("#showArchivedActivity")?.addEventListener("change", scheduleEnhance);
document.querySelector("#adminCalendarPrev")?.addEventListener("click", scheduleEnhance);
document.querySelector("#adminCalendarNext")?.addEventListener("click", scheduleEnhance);

const calendar = document.querySelector("#adminCalendar");
if (calendar) {
  new MutationObserver(scheduleEnhance).observe(calendar, { childList: true, subtree: true });
}

const reservationTable = document.querySelector("#reservationTable");
if (reservationTable) {
  new MutationObserver(scheduleEnhance).observe(reservationTable, { childList: true, subtree: true });
}

async function refreshAdminData() {
  refreshPromise = fetchJson("/api/admin/reservations")
    .then((store) => {
      adminData = {
        reservations: Array.isArray(store.reservations) ? store.reservations : []
      };
    })
    .finally(() => {
      refreshPromise = null;
    });
  return refreshPromise;
}

function scheduleEnhance() {
  if (enhanceScheduled) return;
  enhanceScheduled = true;
  window.requestAnimationFrame(() => {
    enhanceScheduled = false;
    decorateCalendarDoorCodes();
    addMarkPaidActions();
    cleanOperationsDashboard();
  });
}

function decorateCalendarDoorCodes() {
  const calendarLabel = document.querySelector("#adminCalendarLabel")?.textContent?.trim();
  const calendarEl = document.querySelector("#adminCalendar");
  if (!calendarLabel || !calendarEl) return;

  const monthStart = parseCalendarMonth(calendarLabel);
  if (!monthStart) return;

  const eventsByDate = buildDoorCodeEvents(monthStart);
  const firstGridDate = new Date(monthStart);
  firstGridDate.setUTCDate(firstGridDate.getUTCDate() - firstGridDate.getUTCDay());

  const cells = Array.from(calendarEl.querySelectorAll(".admin-calendar-day"));
  cells.forEach((cell, index) => {
    const date = new Date(firstGridDate);
    date.setUTCDate(firstGridDate.getUTCDate() + index);
    const iso = date.toISOString().slice(0, 10);
    const events = eventsByDate.get(iso) || [];
    if (!events.length) return;

    const used = new Set();
    for (const chip of cell.querySelectorAll(".admin-calendar-chip.booked")) {
      if (chip.querySelector(".admin-calendar-chip-detail")) continue;
      const label = calendarChipLabel(chip);
      const matchIndex = events.findIndex((event, eventIndex) => !used.has(eventIndex) && event.label === label && event.detail);
      if (matchIndex === -1) continue;
      used.add(matchIndex);

      const detail = document.createElement("span");
      detail.className = "admin-calendar-chip-detail";
      detail.textContent = events[matchIndex].detail;
      chip.appendChild(detail);
    }
  });
}

function buildDoorCodeEvents(monthStart) {
  const year = monthStart.getUTCFullYear();
  const month = monthStart.getUTCMonth();
  const eventsByDate = new Map();

  for (const reservation of adminData.reservations) {
    if (!reservation || reservation.archivedAt) continue;
    if (["canceled", "declined"].includes(reservation.status)) continue;
    if (reservation.source === "lodgify" || String(reservation.status || "").startsWith("lodgify_")) continue;

    const label = reservation.guest?.name || "Guest";
    const detail = doorCodeLabel(reservation);
    if (!detail) continue;

    eachDate(reservation.arrival, reservation.departure, (iso) => {
      if (!isSameMonth(iso, year, month)) return;
      const list = eventsByDate.get(iso) || [];
      list.push({ label, detail });
      eventsByDate.set(iso, list);
    });
  }

  return eventsByDate;
}

function addMarkPaidActions() {
  const reservationsById = new Map(adminData.reservations.map((reservation) => [reservation.id, reservation]));
  for (const row of document.querySelectorAll("[data-reservation-id]")) {
    if (row.querySelector("[data-enhancement-action='mark-paid-in-full']")) continue;

    const reservation = reservationsById.get(row.dataset.reservationId);
    if (!reservation || reservation.status !== "booked") continue;
    if (reservation.paymentStatus === "paid_in_full" || remainingBalance(reservation) <= 0) continue;

    const actionContainer = row.lastElementChild?.querySelector(".row-actions") || row.lastElementChild;
    if (!actionContainer) continue;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "text-button";
    button.dataset.enhancementAction = "mark-paid-in-full";
    button.textContent = "Mark paid";
    button.addEventListener("click", () => markReservationPaidInFull(reservation, button));
    actionContainer.appendChild(button);
  }
}

function cleanOperationsDashboard() {
  const dashboard = document.querySelector("#operationsDashboard");
  if (!dashboard) return;

  const activeReservations = adminData.reservations
    .filter((reservation) => reservation && !reservation.archivedAt)
    .filter((reservation) => reservation.source !== "lodgify")
    .filter((reservation) => !["canceled", "declined"].includes(reservation.status));

  const unpaidBalances = activeReservations
    .filter((reservation) => reservation.status === "booked")
    .filter((reservation) => reservation.paymentStatus !== "paid_in_full")
    .filter((reservation) => remainingBalance(reservation) > 0)
    .sort((a, b) => String(a.arrival || "").localeCompare(String(b.arrival || "")));

  const card = Array.from(dashboard.querySelectorAll(".ops-card")).find((item) => /unpaid balances/i.test(item.innerText));
  if (!card) return;

  const count = card.querySelector(".ops-card-heading strong");
  if (count) count.textContent = String(unpaidBalances.length);

  const list = card.querySelector("ul");
  if (!list) return;
  list.replaceChildren(...dashboardLines(unpaidBalances));
  card.classList.toggle("attention", unpaidBalances.length > 0);
}

function dashboardLines(reservations) {
  if (!reservations.length) {
    const item = document.createElement("li");
    item.className = "muted";
    item.textContent = "Booked stays with money still due.";
    return [item];
  }

  return reservations.slice(0, 3).map((reservation) => {
    const item = document.createElement("li");
    const name = document.createElement("strong");
    name.textContent = reservation.guest?.name || "Guest";
    const amount = document.createTextNode(` ${money(remainingBalance(reservation), reservation.quote?.currency || "USD")}`);
    const lineBreak = document.createElement("br");
    const arrival = document.createElement("span");
    arrival.className = "muted";
    arrival.textContent = `${formatDate(reservation.arrival)} arrival`;
    item.append(name, amount, lineBreak, arrival);
    return item;
  });
}

function formatDate(iso) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC"
  });
}

async function markReservationPaidInFull(reservation, button) {
  const total = Number(reservation.quote?.total || 0);
  const currency = reservation.quote?.currency || "USD";
  const guestName = reservation.guest?.name || "this guest";
  if (!total) {
    window.alert("This reservation does not have a total amount to mark as paid.");
    return;
  }

  if (!window.confirm(`Mark ${guestName} as paid in full for ${money(total, currency)}? This updates the dashboard only and does not change Stripe.`)) {
    return;
  }

  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Saving...";
  try {
    await patchJson(`/api/admin/reservations/${encodeURIComponent(reservation.id)}`, {
      status: "booked",
      paymentStatus: "paid_in_full",
      amountPaid: total,
      holdExpiresAt: null,
      balancePaidAt: new Date().toISOString()
    });
    await refreshAdminData();
    document.querySelector("#refreshAdmin")?.click();
    scheduleEnhance();
  } catch (error) {
    button.disabled = false;
    button.textContent = label;
    window.alert(error.message);
  }
}

function parseCalendarMonth(label) {
  const date = new Date(`${label} 1 00:00:00 UTC`);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function calendarChipLabel(chip) {
  const clone = chip.cloneNode(true);
  clone.querySelectorAll(".admin-calendar-chip-detail").forEach((node) => node.remove());
  return clone.textContent.trim();
}

function doorCodeLabel(reservation) {
  const digits = String(reservation.guest?.phone || "").replace(/\D/g, "");
  if (digits.length < 4) return "";
  return `Door code ${digits.slice(-4)}`;
}

function installEnhancementStyles() {
  const style = document.createElement("style");
  style.textContent = `
    .admin-calendar-chip-detail {
      display: block;
      font-size: 0.68rem;
      font-weight: 700;
      margin-top: 2px;
      opacity: 0.78;
    }
  `;
  document.head.appendChild(style);
}

async function fetchJson(url) {
  const response = await fetch(url);
  return readJsonResponse(response);
}

async function patchJson(url, payload) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  return readJsonResponse(response);
}

async function readJsonResponse(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function remainingBalance(reservation) {
  const total = Number(reservation.quote?.total || 0);
  const paid = Number(reservation.amountPaid || 0);
  return Math.max(total - paid, 0);
}

function money(amount, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

function eachDate(startIso, endIso, callback) {
  if (!startIso || !endIso) return;
  let cursor = startIso;
  let guard = 0;
  while (cursor < endIso && guard < 1500) {
    callback(cursor);
    cursor = addDaysIso(cursor, 1);
    guard += 1;
  }
}

function addDaysIso(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isSameMonth(iso, year, month) {
  const date = new Date(`${iso}T00:00:00Z`);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month;
}
