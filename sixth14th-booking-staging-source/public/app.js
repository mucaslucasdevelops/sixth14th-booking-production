const state = {
  config: null,
  availability: new Map(),
  monthCursor: startOfMonth(new Date()),
  arrival: "",
  departure: "",
  quote: null
};

const els = {
  propertyImage: document.querySelector("#propertyImage"),
  arrivalInput: document.querySelector("#arrivalInput"),
  departureInput: document.querySelector("#departureInput"),
  guestsInput: document.querySelector("#guestsInput"),
  calendar: document.querySelector("#calendar"),
  calendarLabel: document.querySelector("#calendarLabel"),
  prevMonth: document.querySelector("#prevMonth"),
  nextMonth: document.querySelector("#nextMonth"),
  quoteEmpty: document.querySelector("#quoteEmpty"),
  quoteContent: document.querySelector("#quoteContent"),
  stayDates: document.querySelector("#stayDates"),
  stayNights: document.querySelector("#stayNights"),
  lineItems: document.querySelector("#lineItems"),
  totalAmount: document.querySelector("#totalAmount"),
  depositAmount: document.querySelector("#depositAmount"),
  balanceAmount: document.querySelector("#balanceAmount"),
  checkInTime: document.querySelector("#checkInTime"),
  checkOutTime: document.querySelector("#checkOutTime"),
  bookingForm: document.querySelector("#bookingForm"),
  submitBooking: document.querySelector("#submitBooking"),
  formMessage: document.querySelector("#formMessage")
};

await init();

async function init() {
  state.config = await getJson("/api/config");
  els.propertyImage.src = state.config.business.imageUrl;
  setInitialDates();
  await loadAvailability();
  renderCalendar();
  await refreshQuote();
  bindEvents();
}

function bindEvents() {
  els.prevMonth.addEventListener("click", async () => {
    state.monthCursor = addMonths(state.monthCursor, -1);
    await loadAvailability();
    renderCalendar();
  });
  els.nextMonth.addEventListener("click", async () => {
    state.monthCursor = addMonths(state.monthCursor, 1);
    await loadAvailability();
    renderCalendar();
  });
  els.arrivalInput.addEventListener("change", handleInputDates);
  els.departureInput.addEventListener("change", handleInputDates);
  els.guestsInput.addEventListener("change", refreshQuote);
  els.bookingForm.addEventListener("submit", submitBooking);
}

function setInitialDates() {
  const earliest = addDays(new Date(), state.config.rules.advanceNoticeDays);
  els.arrivalInput.min = toIsoDate(earliest);
  els.departureInput.min = toIsoDate(addDays(earliest, state.config.rules.minimumStayNights));
  state.monthCursor = startOfMonth(earliest);
}

async function loadAvailability() {
  const start = toIsoDate(startOfWeek(startOfMonth(state.monthCursor)));
  const end = toIsoDate(addDays(startOfWeek(endOfMonth(addMonths(state.monthCursor, 1))), 6));
  const data = await getJson(`/api/availability?start=${start}&end=${end}`);
  for (const day of data.days) {
    state.availability.set(day.date, day.available);
  }
}

function renderCalendar() {
  const months = [state.monthCursor, addMonths(state.monthCursor, 1)];
  els.calendarLabel.textContent = `${monthLabel(months[0])} - ${monthLabel(months[1])}`;
  els.calendar.replaceChildren(...months.map(renderMonth));
}

function renderMonth(monthDate) {
  const month = document.createElement("section");
  month.className = "month";
  const title = document.createElement("h3");
  title.textContent = monthLabel(monthDate);
  const heads = document.createElement("div");
  heads.className = "day-head";
  for (const label of ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]) {
    const span = document.createElement("span");
    span.textContent = label;
    heads.append(span);
  }
  const days = document.createElement("div");
  days.className = "days";

  const first = startOfWeek(startOfMonth(monthDate));
  for (let index = 0; index < 42; index += 1) {
    const date = addDays(first, index);
    const iso = toIsoDate(date);
    const button = document.createElement("button");
    button.type = "button";
    button.className = "day";
    button.textContent = String(date.getDate());
    button.dataset.date = iso;
    if (date.getMonth() !== monthDate.getMonth()) button.classList.add("outside");
    if (isSameDay(date, new Date())) button.classList.add("today");
    if (state.availability.get(iso) === false || date < startOfDay(new Date())) {
      button.classList.add("unavailable");
      button.disabled = true;
    }
    if (iso === state.arrival || iso === state.departure) button.classList.add("selected");
    if (state.arrival && state.departure && iso > state.arrival && iso < state.departure) {
      button.classList.add("range");
    }
    button.addEventListener("click", () => selectDate(iso));
    days.append(button);
  }

  month.append(title, heads, days);
  return month;
}

async function selectDate(iso) {
  if (!state.arrival || state.departure || iso < state.arrival) {
    state.arrival = iso;
    state.departure = "";
  } else {
    state.departure = iso;
  }
  syncInputs();
  renderCalendar();
  await refreshQuote();
}

async function handleInputDates() {
  state.arrival = els.arrivalInput.value;
  state.departure = els.departureInput.value;
  if (state.arrival) {
    els.departureInput.min = addDaysIso(state.arrival, state.config.rules.minimumStayNights);
  }
  renderCalendar();
  await refreshQuote();
}

function syncInputs() {
  els.arrivalInput.value = state.arrival;
  els.departureInput.value = state.departure;
  if (state.arrival) {
    els.departureInput.min = addDaysIso(state.arrival, state.config.rules.minimumStayNights);
  }
}

async function refreshQuote() {
  setMessage("");
  state.quote = null;
  els.submitBooking.disabled = true;
  if (!state.arrival || !state.departure) {
    showEmptyQuote("Pick arrival and departure dates to calculate the stay.");
    return;
  }
  try {
    const quote = await postJson("/api/quote", {
      arrival: state.arrival,
      departure: state.departure,
      guests: Number(els.guestsInput.value || 1)
    });
    state.quote = quote;
    renderQuote(quote);
    els.submitBooking.disabled = false;
  } catch (error) {
    showEmptyQuote(error.message);
  }
}

function renderQuote(quote) {
  els.quoteEmpty.hidden = true;
  els.quoteContent.hidden = false;
  els.stayDates.textContent = `${formatDate(quote.arrival)} to ${formatDate(quote.departure)}`;
  els.stayNights.textContent = `${quote.nights} night${quote.nights === 1 ? "" : "s"}`;
  els.lineItems.replaceChildren(
    ...quote.lineItems.map((item) => {
      const row = document.createElement("div");
      row.innerHTML = `<span>${escapeHtml(item.label)}</span><strong>${money(item.amount, quote.currency)}</strong>`;
      return row;
    })
  );
  els.totalAmount.textContent = money(quote.total, quote.currency);
  els.depositAmount.textContent = money(quote.depositDue, quote.currency);
  els.balanceAmount.textContent = money(quote.balanceDue, quote.currency);
  els.checkInTime.textContent = quote.checkInTime;
  els.checkOutTime.textContent = quote.checkOutTime;
}

function showEmptyQuote(message) {
  els.quoteEmpty.textContent = message;
  els.quoteEmpty.hidden = false;
  els.quoteContent.hidden = true;
}

async function submitBooking(event) {
  event.preventDefault();
  if (!state.quote) return;
  els.submitBooking.disabled = true;
  setMessage("Creating your booking hold...");
  const form = new FormData(els.bookingForm);
  try {
    const result = await postJson("/api/bookings", {
      arrival: state.arrival,
      departure: state.departure,
      guests: Number(els.guestsInput.value || 1),
      name: form.get("name"),
      email: form.get("email"),
      phone: form.get("phone"),
      notes: form.get("notes")
    });
    if (result.checkoutUrl) {
      window.location.href = result.checkoutUrl;
      return;
    }
    setMessage(result.message);
    await loadAvailability();
    renderCalendar();
  } catch (error) {
    setMessage(error.message, true);
    els.submitBooking.disabled = false;
  }
}

function setMessage(message, isError = false) {
  els.formMessage.textContent = message;
  els.formMessage.classList.toggle("error", isError);
}

async function getJson(url) {
  const response = await fetch(url);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function money(amount, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

function formatDate(iso) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  });
}

function monthLabel(date) {
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function endOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

function startOfWeek(date) {
  return addDays(date, -date.getDay());
}

function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function addMonths(date, months) {
  return new Date(date.getFullYear(), date.getMonth() + months, 1);
}

function addDaysIso(iso, days) {
  return toIsoDate(addDays(new Date(`${iso}T00:00:00`), days));
}

function toIsoDate(date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;"
  })[char]);
}
