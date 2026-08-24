const els = {
  stagingStatus: document.querySelector("#stagingStatus"),
  operationsDashboard: document.querySelector("#operationsDashboard"),
  adminCalendar: document.querySelector("#adminCalendar"),
  adminCalendarLabel: document.querySelector("#adminCalendarLabel"),
  adminCalendarPrev: document.querySelector("#adminCalendarPrev"),
  adminCalendarNext: document.querySelector("#adminCalendarNext"),
  reservationTable: document.querySelector("#reservationTable"),
  showArchivedActivity: document.querySelector("#showArchivedActivity"),
  refreshAdmin: document.querySelector("#refreshAdmin"),
  syncLodgify: document.querySelector("#syncLodgify"),
  syncMessage: document.querySelector("#syncMessage"),
  blockForm: document.querySelector("#blockForm"),
  blockMessage: document.querySelector("#blockMessage"),
  messageList: document.querySelector("#messageList"),
  sendMessages: document.querySelector("#sendMessages"),
  refreshMessages: document.querySelector("#refreshMessages"),
  messageQueueMessage: document.querySelector("#messageQueueMessage"),
  messageQueue: document.querySelector("#messageQueue"),
  messagePreview: document.querySelector("#messagePreview"),
  auditLog: document.querySelector("#auditLog"),
  refreshAudit: document.querySelector("#refreshAudit")
};

let latestReservations = [];
let latestManualBlocks = [];
let latestAvailabilityBlocks = [];
let latestMessageQueue = [];
let latestMessages = [];
let adminCalendarMonth = firstOfMonth(todayIso());

await initAdmin();

async function initAdmin() {
  await Promise.all([loadStatus(), loadReservations(), loadMessages(), loadMessageQueue(), loadAuditLog()]);
  els.refreshAdmin.addEventListener("click", loadReservations);
  els.refreshMessages.addEventListener("click", loadMessageQueue);
  els.refreshAudit.addEventListener("click", loadAuditLog);
  els.sendMessages.addEventListener("click", sendDueMessages);
  els.syncLodgify.addEventListener("click", syncLodgify);
  els.blockForm.addEventListener("submit", addBlock);
  els.showArchivedActivity.addEventListener("change", () => renderReservations(latestReservations, latestManualBlocks, latestAvailabilityBlocks));
  els.adminCalendarPrev.addEventListener("click", () => changeAdminCalendarMonth(-1));
  els.adminCalendarNext.addEventListener("click", () => changeAdminCalendarMonth(1));
}

async function loadStatus() {
  const status = await getJson("/api/staging/status");
  const emailStatus = status.emailSendingEnabled
    ? `${status.emailProvider} sending`
    : status.emailConfigured
      ? `${status.emailProvider} ready/off`
      : "not configured";
  const items = [
    ["Private access", status.privateAccessEnabled ? "enabled" : "off"],
    ["Public booking", status.publicBookingEnabled ? "enabled" : "off"],
    ["Stripe", status.stripeConfigured ? status.stripeMode : "not configured"],
    ["Stripe webhook", status.stripeWebhookConfigured ? "configured" : "missing"],
    ["Live Stripe unlock", status.liveStripeUnlocked ? "enabled" : "blocked"],
    ["Lodgify sync", status.lodgifySyncConfigured ? "configured" : "manual/local"],
    ["Email", emailStatus],
    ["Google Calendar", status.googleCalendarSyncEnabled ? `${status.googleCalendarAttendee} synced` : status.googleCalendarConfigured ? "ready/off" : "not configured"],
    ["Owner alerts", status.ownerNotificationsEnabled ? status.ownerNotifyEmail : "off"],
    ["Storage", status.storage],
    ["Payment hold", `${status.paymentHoldMinutes} min`]
  ];
  els.stagingStatus.replaceChildren(
    ...items.map(([label, value]) => {
      const item = document.createElement("div");
      item.className = "status-card";
      item.innerHTML = `<span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong>`;
      return item;
    })
  );
}

async function loadReservations() {
  const store = await getJson("/api/admin/reservations");
  latestReservations = store.reservations || [];
  latestManualBlocks = store.manualBlocks || [];
  latestAvailabilityBlocks = store.availabilityBlocks || [];
  renderAdminCalendar();
  renderReservations(latestReservations, latestManualBlocks, latestAvailabilityBlocks);
  renderMessages();
  renderOperationsDashboard();
}

async function loadMessages() {
  const messages = await getJson("/api/admin/messages");
  latestMessages = messages || [];
  renderMessages();
}

async function loadMessageQueue() {
  const { queue } = await getJson("/api/admin/message-queue");
  latestMessageQueue = queue || [];
  renderMessageQueue(queue || []);
  renderMessages();
  renderOperationsDashboard();
}

async function loadAuditLog() {
  const { auditEvents } = await getJson("/api/admin/audit");
  renderAuditLog(auditEvents || []);
}

async function sendDueMessages() {
  const label = els.sendMessages.textContent;
  els.sendMessages.disabled = true;
  els.sendMessages.textContent = "Sending...";
  setMessageQueueMessage("Checking due guest messages...");
  try {
    const result = await postJson("/api/admin/message-queue/send-due", {});
    renderMessageQueue(result.queue || []);
    setMessageQueueMessage(result.message || "Message queue checked.", Boolean(result.failed));
    await loadStatus();
  } catch (error) {
    setMessageQueueMessage(error.message, true);
  } finally {
    els.sendMessages.disabled = false;
    els.sendMessages.textContent = label;
  }
}

async function syncLodgify() {
  els.syncLodgify.disabled = true;
  setSyncMessage("Syncing Lodgify calendar...");
  try {
    const result = await postJson("/api/admin/sync-lodgify", {});
    const summary = formatLodgifySyncResult(result);
    setSyncMessage(summary.message, summary.isError);
    await Promise.all([loadStatus(), loadReservations()]);
  } catch (error) {
    setSyncMessage(error.message, true);
  } finally {
    els.syncLodgify.disabled = false;
  }
}

function formatLodgifySyncResult(result) {
  const importedBookings = Number(result.importedBookings || 0);
  const availabilityBlocks = Number(result.availabilityBlocks || 0);
  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  const base = `Synced ${importedBookings} booking ${importedBookings === 1 ? "summary" : "summaries"} and ${availabilityBlocks} availability ${availabilityBlocks === 1 ? "block" : "blocks"}.`;

  if (!warnings.length) {
    return { message: base, isError: false };
  }

  if (availabilityBlocks > 0) {
    return {
      message: `${base} Lodgify reservation details unavailable, but calendar availability synced successfully.`,
      isError: false
    };
  }

  if (importedBookings > 0) {
    return {
      message: `${base} Lodgify calendar availability details were limited, but booking summaries synced.`,
      isError: false
    };
  }

  return {
    message: `${base} Warning: ${warnings.join(" ")}`,
    isError: true
  };
}

function changeAdminCalendarMonth(delta) {
  const date = new Date(`${adminCalendarMonth}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + delta);
  adminCalendarMonth = date.toISOString().slice(0, 10);
  renderAdminCalendar();
}

function renderAdminCalendar() {
  const monthStart = new Date(`${adminCalendarMonth}T00:00:00Z`);
  const year = monthStart.getUTCFullYear();
  const month = monthStart.getUTCMonth();
  const firstGridDate = new Date(monthStart);
  firstGridDate.setUTCDate(firstGridDate.getUTCDate() - firstGridDate.getUTCDay());
  els.adminCalendarLabel.textContent = monthStart.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  const eventsByDate = buildAdminCalendarEvents(year, month);
  const rows = [];
  rows.push(...["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label) => {
    const head = document.createElement("div");
    head.className = "admin-calendar-head";
    head.textContent = label;
    return head;
  }));
  for (let i = 0; i < 42; i += 1) {
    const date = new Date(firstGridDate);
    date.setUTCDate(firstGridDate.getUTCDate() + i);
    const iso = date.toISOString().slice(0, 10);
    const cell = document.createElement("article");
    cell.className = `admin-calendar-day${date.getUTCMonth() === month ? "" : " outside"}`;
    const events = eventsByDate.get(iso) || [];
    cell.innerHTML = `
      <div class="admin-calendar-date">${date.getUTCDate()}</div>
      <div class="admin-calendar-items">
        ${events.length ? events.map(calendarEventChip).join("") : ""}
      </div>
    `;
    rows.push(cell);
  }
  els.adminCalendar.replaceChildren(...rows);
}

function buildAdminCalendarEvents(year, month) {
  const eventsByDate = new Map();
  const addEvent = (iso, event) => {
    const list = eventsByDate.get(iso) || [];
    list.push(event);
    eventsByDate.set(iso, list);
  };
  for (const reservation of latestReservations) {
    if (reservation.archivedAt) continue;
    if (["canceled", "declined"].includes(reservation.status)) continue;
    const isLodgify = reservation.source === "lodgify" || String(reservation.status || "").startsWith("lodgify_");
    const label = isLodgify ? "Lodgify booking" : reservation.guest?.name || "Guest";
    eachDate(reservation.arrival, reservation.departure, (iso) => {
      if (isSameMonth(iso, year, month)) {
        addEvent(iso, { type: isLodgify ? "lodgify" : "booked", label });
      }
    });
    if (!isLodgify) {
      const cleaningDay = reservation.departure;
      if (isSameMonth(cleaningDay, year, month)) {
        addEvent(cleaningDay, { type: "cleaning", label: `Clean after ${reservation.guest?.name || "Guest"}` });
      }
    }
  }
  for (const block of latestManualBlocks) {
    if (block.archivedAt) continue;
    eachDate(block.start, block.end, (iso) => {
      if (isSameMonth(iso, year, month)) {
        addEvent(iso, { type: "block", label: block.reason || "Manual block" });
      }
    });
  }
  for (const block of latestAvailabilityBlocks) {
    eachDate(block.start, block.end, (iso) => {
      if (isSameMonth(iso, year, month)) {
        addEvent(iso, { type: "lodgify", label: block.reason || "Lodgify booking" });
      }
    });
  }
  return eventsByDate;
}

function calendarEventChip(event) {
  return `<span class="admin-calendar-chip ${escapeHtml(event.type)}">${escapeHtml(event.label)}</span>`;
}

function renderReservations(reservations, blocks, availabilityBlocks) {
  const rows = [];
  const showArchived = els.showArchivedActivity.checked;
  const knownLodgifyIds = new Set(
    reservations
      .filter((reservation) => reservation.source === "lodgify" && reservation.externalId)
      .map((reservation) => String(reservation.externalId))
  );
  const head = document.createElement("div");
  head.className = "data-head";
  head.innerHTML = "<span>Guest or block</span><span>Dates</span><span>Status</span><span>Payment</span><span>Total</span><span>Actions</span>";
  rows.push(head);

  for (const block of blocks.filter((item) => showArchived || !item.archivedAt)) {
    const row = document.createElement("div");
    row.className = `data-row${block.archivedAt ? " archived-row" : ""}`;
    row.innerHTML = `
      <strong>${escapeHtml(block.reason || "Manual block")}</strong>
      <span>${formatDate(block.start)} to ${formatDate(block.end)}</span>
      <span class="status-pill">${block.archivedAt ? "archived block" : "blocked"}</span>
      <span>-</span>
      <span>-</span>
      <span class="row-actions">
        ${block.archivedAt ? "" : '<button type="button" class="text-button" data-action="edit-block">Edit</button>'}
        <button type="button" class="text-button" data-action="${block.archivedAt ? "unarchive-block" : "archive-block"}">${block.archivedAt ? "Unarchive" : "Archive"}</button>
        <button type="button" class="text-button danger-button" data-action="delete-block">Delete</button>
      </span>
    `;
    const editBlockButton = row.querySelector("[data-action='edit-block']");
    if (editBlockButton) {
      editBlockButton.addEventListener("click", () => editManualBlock(block));
    }
    const archiveBlockButton = row.querySelector("[data-action='archive-block'], [data-action='unarchive-block']");
    if (archiveBlockButton) {
      archiveBlockButton.addEventListener("click", () => archiveManualBlock(block, !block.archivedAt));
    }
    row.querySelector("[data-action='delete-block']").addEventListener("click", () => deleteManualBlock(block));
    rows.push(row);
  }

  const syncedBlocks = availabilityBlocks.filter((block) => {
    const bookingIds = Array.isArray(block.bookingIds) ? block.bookingIds.map(String) : [];
    return !(bookingIds.length && bookingIds.every((id) => knownLodgifyIds.has(id)));
  });
  if (syncedBlocks.length) {
    const summary = summarizeSyncedBlocks(syncedBlocks);
    const row = document.createElement("div");
    row.className = "data-row";
    row.innerHTML = `
      <strong>Synced Lodgify calendar</strong>
      <span>${escapeHtml(summary)}</span>
      <span class="status-pill">synced_blocks</span>
      <span>synced</span>
      <span>-</span>
      <span>-</span>
    `;
    rows.push(row);
  }

  for (const reservation of reservations.filter((item) => showArchived || !item.archivedAt)) {
    const row = document.createElement("div");
    row.className = `data-row${reservation.archivedAt ? " archived-row" : ""}`;
    row.dataset.reservationId = reservation.id;
    row.innerHTML = `
      ${renderGuestCell(reservation)}
      <span>${formatDate(reservation.arrival)} to ${formatDate(reservation.departure)}</span>
      <span class="status-pill">${escapeHtml(displayReservationStatus(reservation))}</span>
      <span>${paymentSummary(reservation)}</span>
      <strong>${money(reservation.quote?.total || 0, reservation.quote?.currency || "USD")}</strong>
      <span>${reservationAction(reservation)}</span>
    `;
    const cancelButton = row.querySelector("[data-action='cancel-reservation']");
    if (cancelButton) {
      cancelButton.addEventListener("click", () => cancelReservation(reservation.id, cancelButton));
    }
    const approveButton = row.querySelector("[data-action='approve-request']");
    if (approveButton) {
      approveButton.addEventListener("click", () => approveReservation(reservation.id, approveButton));
    }
    const declineButton = row.querySelector("[data-action='decline-request']");
    if (declineButton) {
      declineButton.addEventListener("click", () => declineReservation(reservation.id, declineButton));
    }
    const balanceButton = row.querySelector("[data-action='create-balance-link']");
    if (balanceButton) {
      balanceButton.addEventListener("click", () => createBalanceLink(reservation.id, balanceButton));
    }
    for (const copyButton of row.querySelectorAll("[data-action='copy-payment-link']")) {
      copyButton.addEventListener("click", () => copyPaymentLink(copyButton.dataset.url, copyButton));
    }
    const editGuestButton = row.querySelector("[data-action='edit-guest']");
    if (editGuestButton) {
      editGuestButton.addEventListener("click", () => editGuestDetails(reservation, editGuestButton));
    }
    const archiveButton = row.querySelector("[data-action='archive-reservation']");
    if (archiveButton) {
      archiveButton.addEventListener("click", () => archiveReservation(reservation.id, true, archiveButton));
    }
    const unarchiveButton = row.querySelector("[data-action='unarchive-reservation']");
    if (unarchiveButton) {
      unarchiveButton.addEventListener("click", () => archiveReservation(reservation.id, false, unarchiveButton));
    }
    const deleteButton = row.querySelector("[data-action='delete-reservation']");
    if (deleteButton) {
      deleteButton.addEventListener("click", () => deleteReservation(reservation.id, deleteButton));
    }
    rows.push(row);
  }

  if (rows.length === 1) {
    const empty = document.createElement("div");
    empty.className = "data-row";
    empty.innerHTML = "<span>No reservations or blocks yet.</span><span></span><span></span><span></span><span></span><span></span>";
    rows.push(empty);
  }

  els.reservationTable.replaceChildren(...rows);
}

function renderOperationsDashboard() {
  const today = todayIso();
  const soon = addDaysIso(today, 14);
  const reservations = latestReservations.filter((reservation) => reservation && reservation.source !== "lodgify");
  const activeReservations = reservations.filter((reservation) => !["canceled", "declined"].includes(reservation.status));
  const pendingRequests = reservations
    .filter((reservation) => reservation.status === "pending_host_approval")
    .sort(compareCreated);
  const expiredHolds = reservations
    .filter((reservation) => reservation.status === "pending_payment" && isExpiredHold(reservation))
    .sort(compareArrival);
  const unpaidBalances = activeReservations
    .filter((reservation) => reservation.status === "booked" && reservation.paymentStatus !== "paid_in_full" && remainingBalance(reservation) > 0)
    .sort(compareArrival);
  const arrivals = activeReservations
    .filter((reservation) => reservation.status === "booked" && reservation.arrival >= today && reservation.arrival <= soon)
    .sort(compareArrival);
  const departures = activeReservations
    .filter((reservation) => reservation.status === "booked" && reservation.departure >= today && reservation.departure <= soon)
    .sort((a, b) => a.departure.localeCompare(b.departure));
  const dueMessages = latestMessageQueue
    .filter((delivery) => delivery.status === "due")
    .sort(compareDueAt);
  const failedMessages = latestMessageQueue
    .filter((delivery) => delivery.status === "failed")
    .sort(compareDueAt);

  const cards = [
    dashboardCard("Pending requests", pendingRequests.length, pendingRequests.map(reservationLine).slice(0, 3), "Requests waiting for approval."),
    dashboardCard("Expired holds", expiredHolds.length, expiredHolds.map(reservationLine).slice(0, 3), "Payment holds that should be canceled or followed up."),
    dashboardCard("Unpaid balances", unpaidBalances.length, unpaidBalances.map(balanceLine).slice(0, 3), "Booked stays with money still due."),
    dashboardCard("Messages due", dueMessages.length, dueMessages.map(messageLine).slice(0, 3), "Guest messages ready to send."),
    dashboardCard("Failed messages", failedMessages.length, failedMessages.map(messageLine).slice(0, 3), "Emails that need attention."),
    dashboardCard("Arrivals", arrivals.length, arrivals.map(arrivalLine).slice(0, 3), "Booked arrivals in the next 14 days."),
    dashboardCard("Departures", departures.length, departures.map(departureLine).slice(0, 3), "Booked departures in the next 14 days.")
  ];

  els.operationsDashboard.replaceChildren(...cards);
}

function dashboardCard(title, count, lines, emptyText) {
  const card = document.createElement("article");
  card.className = count ? "ops-card attention" : "ops-card";
  const items = lines.length
    ? lines.map((line) => `<li>${line}</li>`).join("")
    : `<li class="muted">${escapeHtml(emptyText)}</li>`;
  card.innerHTML = `
    <div class="ops-card-heading">
      <span>${escapeHtml(title)}</span>
      <strong>${escapeHtml(count)}</strong>
    </div>
    <ul>${items}</ul>
  `;
  return card;
}

function reservationLine(reservation) {
  return `<strong>${escapeHtml(reservation.guest?.name || "Guest")}</strong><br><span class="muted">${escapeHtml(formatDate(reservation.arrival))} to ${escapeHtml(formatDate(reservation.departure))}</span>`;
}

function balanceLine(reservation) {
  return `<strong>${escapeHtml(reservation.guest?.name || "Guest")}</strong> ${escapeHtml(money(remainingBalance(reservation), reservation.quote?.currency || "USD"))}<br><span class="muted">${escapeHtml(formatDate(reservation.arrival))} arrival</span>`;
}

function messageLine(delivery) {
  return `<strong>${escapeHtml(delivery.messageName || "Guest message")}</strong><br><span class="muted">${escapeHtml(delivery.recipientName || "Guest")} · ${escapeHtml(formatDateTime(delivery.dueAt))}</span>`;
}

function arrivalLine(reservation) {
  return `<strong>${escapeHtml(reservation.guest?.name || "Guest")}</strong><br><span class="muted">${escapeHtml(formatDate(reservation.arrival))}</span>`;
}

function departureLine(reservation) {
  return `<strong>${escapeHtml(reservation.guest?.name || "Guest")}</strong><br><span class="muted">${escapeHtml(formatDate(reservation.departure))}</span>`;
}

function compareArrival(a, b) {
  return String(a.arrival || "").localeCompare(String(b.arrival || ""));
}

function compareCreated(a, b) {
  return String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
}

function compareDueAt(a, b) {
  return String(a.dueAt || "").localeCompare(String(b.dueAt || ""));
}

function renderGuestCell(reservation) {
  const guest = reservation.guest || {};
  const phone = guest.phone ? `<span class="muted">${escapeHtml(guest.phone)}</span>` : "";
  const notes = guest.notes ? `<span class="muted">${escapeHtml(guest.notes)}</span>` : "";
  const editButton = canEditGuest(reservation)
    ? '<button type="button" class="text-button inline-edit" data-action="edit-guest">Edit guest</button>'
    : "";
  return `
    <div class="guest-summary">
      <strong>${escapeHtml(guest.name || "Guest")}</strong>
      <span class="muted">${escapeHtml(guest.email || "")}</span>
      ${phone}
      ${notes}
      ${editButton}
    </div>
  `;
}

function canEditGuest(reservation) {
  return reservation.source !== "lodgify" && !String(reservation.status || "").startsWith("lodgify_");
}

async function editGuestDetails(reservation, button) {
  const guest = reservation.guest || {};
  const name = window.prompt("Guest name", guest.name || "");
  if (name === null) return;
  const email = window.prompt("Guest email", guest.email || "");
  if (email === null) return;
  const phone = window.prompt("Guest phone", guest.phone || "");
  if (phone === null) return;
  const notes = window.prompt("Guest notes", guest.notes || "");
  if (notes === null) return;

  const originalLabel = button.textContent;
  button.disabled = true;
  button.textContent = "Saving...";
  try {
    await patchJson(`/api/admin/reservations/${encodeURIComponent(reservation.id)}/guest`, {
      name: name.trim(),
      email: email.trim(),
      phone: phone.trim(),
      notes: notes.trim()
    });
    await loadReservations();
    try {
      await loadMessageQueue();
    } catch (error) {
      console.warn("Guest details were saved, but the message schedule could not refresh.", error);
    }
  } catch (error) {
    button.disabled = false;
    button.textContent = originalLabel;
    window.alert(error.message);
  }
}

function displayReservationStatus(reservation) {
  if (reservation.status === "pending_payment" && isExpiredHold(reservation)) {
    return "hold_expired";
  }
  return reservation.status;
}

function summarizeSyncedBlocks(blocks) {
  const sorted = [...blocks].sort((a, b) => a.start.localeCompare(b.start));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  return `${blocks.length} blocked ${blocks.length === 1 ? "range" : "ranges"} (${formatDateWithYear(first.start)} to ${formatDateWithYear(last.displayEnd || addDaysIso(last.end, -1))})`;
}

function paymentSummary(reservation) {
  const status = escapeHtml(paymentStatusLabel(reservation.paymentStatus));
  const emailStatus = shouldShowEmailSummary(reservation) ? paymentEmailSummary(reservation) : "";
  if (reservation.status === "pending_host_approval") {
    return `${status}<br><span class="muted">No payment link yet</span>`;
  }
  if (reservation.status === "booked" && reservation.paymentStatus === "deposit_paid") {
    const balance = remainingBalance(reservation);
    const balanceNote = balance > 0 ? `<br><span class="muted">Balance remaining ${money(balance, reservation.quote?.currency || "USD")}</span>` : "";
    return `${status}${balanceNote}${emailStatus ? `<br>${emailStatus}` : ""}`;
  }
  if (reservation.status === "booked" && reservation.paymentStatus === "balance_due") {
    const balance = remainingBalance(reservation);
    const balanceNote = balance > 0 ? `<br><span class="muted">Balance due ${money(balance, reservation.quote?.currency || "USD")}</span>` : "";
    return `${status}${balanceNote}${emailStatus ? `<br>${emailStatus}` : ""}`;
  }
  if (!reservation.holdExpiresAt || reservation.status !== "pending_payment") {
    return emailStatus ? `${status}<br>${emailStatus}` : status;
  }
  const label = isExpiredHold(reservation) ? "Hold expired" : "Hold expires";
  return `${status}<br><span class="muted">${label} ${escapeHtml(formatDateTime(reservation.holdExpiresAt))}</span>${emailStatus ? `<br>${emailStatus}` : ""}`;
}

function paymentStatusLabel(status) {
  const labels = {
    awaiting_host_approval: "Awaiting host approval",
    deposit_due: "Deposit due",
    deposit_paid: "Deposit paid",
    balance_due: "Balance due",
    paid_in_full: "Paid in full",
    demo_no_payment: "Demo/no payment",
    canceled: "Canceled",
    declined: "Declined",
    synced: "Synced"
  };
  return labels[status] || status || "-";
}

function shouldShowEmailSummary(reservation) {
  if (["canceled", "declined"].includes(reservation.status)) return false;
  if (["canceled", "declined", "paid_in_full"].includes(reservation.paymentStatus)) return false;
  return true;
}

function paymentEmailSummary(reservation) {
  return [
    emailStatusSummary(reservation.depositEmail, "Deposit email"),
    emailStatusSummary(reservation.balanceEmail, "Balance email")
  ].filter(Boolean).join("<br>");
}

function emailStatusSummary(email, label) {
  if (!email) return "";
  if (email.status === "sent") {
    return `<span class="muted">${escapeHtml(label)} sent</span>`;
  }
  if (email.status === "failed") {
    const error = email.error ? `<br><span class="email-error-detail">${escapeHtml(email.error)}</span>` : "";
    return `<span class="muted">${escapeHtml(label)} failed</span>${error}`;
  }
  return `<span class="muted">${escapeHtml(label)} ready</span>`;
}

function reservationAction(reservation) {
  const activityActions = canEditGuest(reservation)
    ? `<button type="button" class="text-button" data-action="${reservation.archivedAt ? "unarchive-reservation" : "archive-reservation"}">${reservation.archivedAt ? "Unarchive" : "Archive"}</button><button type="button" class="text-button danger-button" data-action="delete-reservation">Delete</button>`
    : "";
  if (reservation.status === "pending_host_approval") {
    const currentTotal = Number(reservation.quote?.total || 0);
    const preferredPlaceholder = Number.isFinite(currentTotal) && currentTotal > 0 ? currentTotal.toFixed(2) : "";
    return `
      <span class="row-actions approval-actions">
        <label class="special-offer-control">
          Preferred total
          <input data-special-offer-total type="number" min="1" step="0.01" inputmode="decimal" placeholder="${escapeHtml(preferredPlaceholder)}" aria-label="Optional preferred total for ${escapeHtml(reservation.guest?.name || "guest")}">
        </label>
        <button type="button" class="text-button" data-action="approve-request">Approve request</button>
        <button type="button" class="text-button" data-action="decline-request">Decline</button>
        ${activityActions}
      </span>
    `;
  }
  if (reservation.status === "pending_payment") {
    if (isExpiredHold(reservation)) {
      return `
        <span class="row-actions">
          <button type="button" class="text-button" data-action="cancel-reservation">Cancel expired hold</button>
          ${activityActions}
        </span>
      `;
    }
    const paymentLink = reservation.stripeCheckoutUrl
      ? `<a class="text-button" href="${escapeHtml(paymentPageUrl(reservation, "deposit"))}" target="_blank" rel="noopener">Open deposit link</a>
        <button type="button" class="text-button" data-action="copy-payment-link" data-url="${escapeHtml(paymentPageUrl(reservation, "deposit"))}">Copy deposit link</button>`
      : "";
    const emailLink = emailComposeLink(reservation.depositEmail, "Compose deposit email");
    return `
      <span class="row-actions">
        ${paymentLink}
        ${emailLink}
        <button type="button" class="text-button" data-action="cancel-reservation">Cancel hold</button>
        ${activityActions}
      </span>
    `;
  }
  if (reservation.status === "booked") {
    const balanceDue = remainingBalance(reservation);
    const actions = [];
    if (reservation.paymentStatus !== "paid_in_full" && balanceDue > 0) {
      if (reservation.balanceCheckoutUrl) {
        actions.push(`<a class="text-button" href="${escapeHtml(paymentPageUrl(reservation, "balance"))}" target="_blank" rel="noopener">Open balance link</a>`);
        actions.push(`<button type="button" class="text-button" data-action="copy-payment-link" data-url="${escapeHtml(paymentPageUrl(reservation, "balance"))}">Copy balance link</button>`);
        actions.push(emailComposeLink(reservation.balanceEmail, "Compose balance email"));
      } else {
        actions.push('<button type="button" class="text-button" data-action="create-balance-link">Create balance link</button>');
      }
    }
    actions.push('<button type="button" class="text-button" data-action="cancel-reservation">Cancel booking</button>');
    actions.push(activityActions);
    return `<span class="row-actions">${actions.join("")}</span>`;
  }
  if (reservation.status === "demo_hold") {
    return `<span class="row-actions"><button type="button" class="text-button" data-action="cancel-reservation">Cancel booking</button>${activityActions}</span>`;
  }
  if (String(reservation.status || "").startsWith("lodgify_")) {
    return "-";
  }
  return activityActions ? `<span class="row-actions">${activityActions}</span>` : "-";
}

function emailComposeLink(email, label) {
  if (!email || email.status === "sent" || !email.to || !email.text) return "";
  const href = `mailto:${encodeURIComponent(email.to)}?subject=${encodeURIComponent(email.subject || label)}&body=${encodeURIComponent(email.text)}`;
  return `<a class="text-button" href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

function renderMessages() {
  els.messageList.replaceChildren(...latestMessages.map(renderMessage));
}

function renderMessage(message) {
  const scheduledCount = latestMessageQueue.filter((delivery) => delivery.messageId === message.id).length;
  const item = document.createElement("article");
  item.className = `message-item message-template-editor${message.enabled ? "" : " disabled"}`;
  item.innerHTML = `
    <form class="message-template-form">
      <div class="message-template-heading">
        <div>
          <strong>${escapeHtml(message.name)}</strong>
          <span>${escapeHtml(timingLabel(message.sendOffset || message.trigger))} · ${scheduledCount} scheduled</span>
        </div>
        <label class="message-enabled-toggle">
          <input type="checkbox" name="enabled" ${message.enabled ? "checked" : ""}>
          Enabled
        </label>
      </div>
      <label>
        Send timing
        <select name="sendOffset">
          ${timingOptions(message.sendOffset)}
        </select>
      </label>
      <label>
        Subject
        <input name="subject">
      </label>
      <label>
        Message copy
        <textarea name="body" rows="7"></textarea>
      </label>
      <div class="message-template-tools">
        <label>
          Preview as guest
          <select name="reservationId">
            ${reservationPreviewOptions()}
          </select>
        </label>
        <label>
          Test recipient
          <input name="testEmail" type="email" value="marc@lucasand.co">
        </label>
      </div>
      <div class="message-template-actions">
        <button type="submit" class="text-button">Save template</button>
        <button type="button" class="text-button" data-action="preview-template">Preview</button>
        <button type="button" class="text-button" data-action="send-template-test">Send test</button>
        <span class="form-message" data-template-message></span>
      </div>
      <pre class="message-template-preview" data-template-preview hidden></pre>
    </form>
  `;
  item.querySelector("input[name='subject']").value = message.subject || "";
  item.querySelector("textarea[name='body']").value = message.body || "";
  item.querySelector("form").addEventListener("submit", (event) => saveMessageTemplate(event, message.id));
  item.querySelector("[data-action='preview-template']").addEventListener("click", (event) => previewMessageTemplate(event, message.id));
  item.querySelector("[data-action='send-template-test']").addEventListener("click", (event) => sendMessageTemplateTest(event, message.id));
  return item;
}

function timingOptions(selected) {
  const options = [
    ["immediate", "When booking is confirmed"],
    ["-7d", "7 days before arrival"],
    ["-2d", "2 days before arrival"],
    ["0d", "Arrival day"],
    ["checkout", "Checkout day"],
    ["+2d", "2 days after departure"]
  ];
  return options.map(([value, label]) => `<option value="${escapeHtml(value)}" ${value === selected ? "selected" : ""}>${escapeHtml(label)}</option>`).join("");
}

function timingLabel(value) {
  const labels = {
    immediate: "When booking is confirmed",
    booking_confirmed: "When booking is confirmed",
    "-7d": "7 days before arrival",
    seven_days_before_arrival: "7 days before arrival",
    "-2d": "2 days before arrival",
    two_days_before_arrival: "2 days before arrival",
    "0d": "Arrival day",
    arrival_day: "Arrival day",
    checkout: "Checkout day",
    checkout_day: "Checkout day",
    "+2d": "2 days after departure",
    two_days_after_departure: "2 days after departure"
  };
  return labels[value] || value || "Timing not set";
}

function reservationPreviewOptions() {
  const reservations = latestReservations
    .filter((reservation) => reservation.guest?.email && reservation.source !== "lodgify")
    .sort(compareArrival);
  if (!reservations.length) {
    return '<option value="">No guest reservations available</option>';
  }
  return reservations.map((reservation) => (
    `<option value="${escapeHtml(reservation.id)}">${escapeHtml(reservation.guest?.name || "Guest")} · ${escapeHtml(formatDate(reservation.arrival))} to ${escapeHtml(formatDate(reservation.departure))}</option>`
  )).join("");
}

async function saveMessageTemplate(event, id) {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = form.querySelector("button[type='submit']");
  const status = form.querySelector("[data-template-message]");
  const payload = {
    enabled: form.elements.enabled.checked,
    sendOffset: form.elements.sendOffset.value,
    subject: form.elements.subject.value,
    body: form.elements.body.value
  };

  submit.disabled = true;
  submit.textContent = "Saving...";
  status.textContent = "";
  status.classList.remove("error");

  try {
    await patchJson(`/api/admin/messages/${encodeURIComponent(id)}`, payload);
    form.closest(".message-item")?.classList.toggle("disabled", !payload.enabled);
    status.textContent = "Saved. Unsent scheduled messages were updated.";
    await loadMessages();
    await loadMessageQueue();
  } catch (error) {
    status.textContent = error.message;
    status.classList.add("error");
  } finally {
    submit.disabled = false;
    submit.textContent = "Save template";
  }
}

async function previewMessageTemplate(event, id) {
  const form = event.currentTarget.closest("form");
  const status = form.querySelector("[data-template-message]");
  const preview = form.querySelector("[data-template-preview]");
  status.textContent = "";
  status.classList.remove("error");
  preview.hidden = true;
  try {
    const result = await postJson(`/api/admin/messages/${encodeURIComponent(id)}/preview`, {
      reservationId: form.elements.reservationId.value
    });
    preview.textContent = `To: ${result.recipientName} <${result.to}>\nSubject: ${result.subject}\n\n${result.body}`;
    preview.hidden = false;
  } catch (error) {
    status.textContent = error.message;
    status.classList.add("error");
  }
}

async function sendMessageTemplateTest(event, id) {
  const button = event.currentTarget;
  const form = button.closest("form");
  const status = form.querySelector("[data-template-message]");
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Sending...";
  status.textContent = "";
  status.classList.remove("error");
  try {
    const result = await postJson(`/api/admin/messages/${encodeURIComponent(id)}/test`, {
      reservationId: form.elements.reservationId.value,
      email: form.elements.testEmail.value
    });
    status.textContent = result.status === "sent"
      ? `Test sent to ${result.to}.`
      : `Test ready but not sent: ${result.detail || result.error || result.status}.`;
  } catch (error) {
    status.textContent = error.message;
    status.classList.add("error");
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

function renderMessageQueue(queue) {
  const rows = [];
  const head = document.createElement("div");
  head.className = "message-head";
  head.innerHTML = "<span>Guest</span><span>Message</span><span>Send timing</span><span>Status</span><span>Actions</span>";
  rows.push(head);

  for (const delivery of queue) {
    const row = document.createElement("div");
    row.className = "message-row";
    row.dataset.deliveryId = delivery.id;
    row.innerHTML = `
      <div><strong>${escapeHtml(delivery.recipientName || "Guest")}</strong><br><span class="muted">${escapeHtml(delivery.recipientEmail || "")}</span></div>
      <span>${escapeHtml(delivery.messageName)}</span>
      <span>${escapeHtml(formatDateTime(delivery.dueAt))}</span>
      <span class="status-pill">${escapeHtml(delivery.status)}</span>
      <span class="row-actions">
        <button type="button" class="text-button" data-action="preview-message">Preview</button>
        ${messageComposeLink(delivery)}
        ${["sent", "skipped"].includes(delivery.status) ? "" : '<button type="button" class="text-button" data-action="mark-message-sent">Mark sent</button>'}
      </span>
    `;
    row.querySelector("[data-action='preview-message']").addEventListener("click", () => renderMessagePreview(delivery));
    const markSent = row.querySelector("[data-action='mark-message-sent']");
    if (markSent) {
      markSent.addEventListener("click", () => markMessageSent(delivery.id, markSent));
    }
    rows.push(row);
  }

  if (rows.length === 1) {
    const empty = document.createElement("div");
    empty.className = "message-row";
    empty.innerHTML = "<span>No guest messages are scheduled yet.</span><span></span><span></span><span></span><span></span>";
    rows.push(empty);
  }

  els.messageQueue.replaceChildren(...rows);
}

function renderMessagePreview(delivery) {
  els.messagePreview.innerHTML = `
    <h2>${escapeHtml(delivery.messageName)}</h2>
    <dl class="preview-meta">
      <div><dt>To</dt><dd>${escapeHtml(delivery.recipientName)} &lt;${escapeHtml(delivery.recipientEmail)}&gt;</dd></div>
      <div><dt>Subject</dt><dd>${escapeHtml(delivery.subject)}</dd></div>
      <div><dt>Scheduled</dt><dd>${escapeHtml(formatDateTime(delivery.dueAt))}</dd></div>
      <div><dt>Status</dt><dd>${escapeHtml(delivery.status)}</dd></div>
    </dl>
    ${messageComposeLink(delivery)}
    <pre>${escapeHtml(delivery.body)}</pre>
  `;
}

function messageComposeLink(delivery) {
  if (!delivery || ["sent", "skipped"].includes(delivery.status)) return "";
  if (!delivery.recipientEmail || !delivery.body) return "";
  const href = `mailto:${encodeURIComponent(delivery.recipientEmail)}?subject=${encodeURIComponent(delivery.subject || delivery.messageName)}&body=${encodeURIComponent(delivery.body)}`;
  return `<a class="text-button" href="${escapeHtml(href)}">Compose email</a>`;
}

function renderAuditLog(events) {
  const rows = [];
  const head = document.createElement("div");
  head.className = "audit-head";
  head.innerHTML = "<span>Time</span><span>Event</span><span>Details</span>";
  rows.push(head);

  for (const event of events) {
    const row = document.createElement("div");
    row.className = "audit-row";
    row.innerHTML = `
      <span>${escapeHtml(formatDateTime(event.createdAt))}</span>
      <div><strong>${escapeHtml(event.summary || event.action)}</strong><br><span class="muted">${escapeHtml(event.action || "")}</span></div>
      <span>${escapeHtml(formatAuditMetadata(event.metadata))}</span>
    `;
    rows.push(row);
  }

  if (rows.length === 1) {
    const empty = document.createElement("div");
    empty.className = "audit-row";
    empty.innerHTML = "<span>No audit events yet.</span><span></span><span></span>";
    rows.push(empty);
  }

  els.auditLog.replaceChildren(...rows);
}

function formatAuditMetadata(metadata = {}) {
  return Object.entries(metadata || {})
    .filter(([, value]) => value !== null && value !== undefined && value !== "")
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : value}`)
    .join(" · ");
}

function paymentPageUrl(reservation, paymentType) {
  const token = paymentType === "balance" ? reservation.balancePaymentToken : reservation.depositPaymentToken;
  const identifier = token || reservation.id;
  return `${window.location.origin}/pay/${paymentType}/${encodeURIComponent(identifier)}`;
}

async function copyPaymentLink(url, button) {
  if (!url) return;
  const label = button.textContent;
  try {
    await navigator.clipboard.writeText(url);
    button.textContent = "Copied";
    window.setTimeout(() => {
      button.textContent = label;
    }, 1500);
  } catch {
    window.prompt("Copy this payment link:", url);
  }
}

async function addBlock(event) {
  event.preventDefault();
  setBlockMessage("Adding block...");
  const form = new FormData(els.blockForm);
  try {
    await postJson("/api/admin/blocks", {
      start: form.get("start"),
      end: form.get("end"),
      reason: form.get("reason")
    });
    els.blockForm.reset();
    setBlockMessage("Block added.");
    await loadReservations();
  } catch (error) {
    setBlockMessage(error.message, true);
  }
}

async function editManualBlock(block) {
  const start = window.prompt("Block start date", block.start || "");
  if (start === null) return;
  const end = window.prompt("Block end date", block.end || "");
  if (end === null) return;
  const reason = window.prompt("Block reason", block.reason || "Manual block");
  if (reason === null) return;
  try {
    await patchJson(`/api/admin/blocks/${encodeURIComponent(block.id)}`, {
      start: start.trim(),
      end: end.trim(),
      reason: reason.trim()
    });
    await loadReservations();
  } catch (error) {
    window.alert(error.message);
  }
}

async function deleteManualBlock(block) {
  if (!window.confirm(`Delete this manual block and release ${formatDate(block.start)} to ${formatDate(block.end)}?`)) {
    return;
  }
  try {
    await deleteJson(`/api/admin/blocks/${encodeURIComponent(block.id)}`);
    await loadReservations();
  } catch (error) {
    window.alert(error.message);
  }
}

async function archiveManualBlock(block, archived) {
  const verb = archived ? "archive" : "unarchive";
  if (!window.confirm(`${verb[0].toUpperCase()}${verb.slice(1)} this manual block?`)) {
    return;
  }
  try {
    await patchJson(`/api/admin/blocks/${encodeURIComponent(block.id)}`, {
      archived,
      archiveReason: archived ? "Archived from Admin" : ""
    });
    await loadReservations();
  } catch (error) {
    window.alert(error.message);
  }
}

async function cancelReservation(id, button) {
  const label = button.textContent;
  if (!window.confirm("Cancel this reservation in staging and release its dates? Stripe test charges will remain visible in Stripe, but the staging calendar will become available again.")) {
    return;
  }
  button.disabled = true;
  button.textContent = "Canceling...";
  try {
    await patchJson(`/api/admin/reservations/${encodeURIComponent(id)}`, {
      status: "canceled",
      paymentStatus: "canceled"
    });
    await loadReservations();
  } catch (error) {
    button.disabled = false;
    button.textContent = label;
    window.alert(error.message);
  }
}

async function archiveReservation(id, archived, button) {
  const label = button.textContent;
  const message = archived
    ? "Archive this booking activity? Archived activity is hidden from the default Admin activity list, but existing booked dates are not released."
    : "Unarchive this booking activity and show it in the default Admin activity list?";
  if (!window.confirm(message)) {
    return;
  }
  button.disabled = true;
  button.textContent = archived ? "Archiving..." : "Restoring...";
  try {
    await patchJson(`/api/admin/reservations/${encodeURIComponent(id)}`, {
      archived,
      archiveReason: archived ? "Archived from Admin" : ""
    });
    await loadReservations();
  } catch (error) {
    button.disabled = false;
    button.textContent = label;
    window.alert(error.message);
  }
}

async function deleteReservation(id, button) {
  const label = button.textContent;
  if (!window.confirm("Delete this local booking activity and release its dates? This cannot delete Lodgify bookings or refund Stripe charges.")) {
    return;
  }
  button.disabled = true;
  button.textContent = "Deleting...";
  try {
    await deleteJson(`/api/admin/reservations/${encodeURIComponent(id)}`);
    await Promise.all([loadReservations(), loadMessageQueue()]);
  } catch (error) {
    button.disabled = false;
    button.textContent = label;
    window.alert(error.message);
  }
}

async function approveReservation(id, button) {
  const label = button.textContent;
  const specialOfferInput = button.closest(".row-actions")?.querySelector("[data-special-offer-total]");
  const specialOfferTotal = specialOfferInput?.value?.trim() || "";
  if (specialOfferTotal) {
    const parsed = Number(specialOfferTotal.replace(/[$,]/g, ""));
    if (!Number.isFinite(parsed) || parsed <= 0) {
      window.alert("Preferred total must be a positive dollar amount.");
      return;
    }
  }
  button.disabled = true;
  if (specialOfferInput) specialOfferInput.disabled = true;
  button.textContent = "Approving...";
  try {
    const payload = specialOfferTotal ? { specialOfferTotal } : {};
    const result = await postJson(`/api/admin/reservations/${encodeURIComponent(id)}/approve`, payload);
    await Promise.all([loadReservations(), loadMessageQueue()]);
    if (result.email?.status === "sent") {
      window.alert("Deposit link created and emailed to the guest.");
    } else if (result.email?.status === "failed") {
      const detail = result.email.error ? `\n\nEmail error: ${result.email.error}` : "";
      window.alert(`Deposit link created, but the email could not be sent. Use Open deposit link or Compose email in the reservation row.${detail}`);
    } else if (result.checkoutUrl) {
      window.alert("Deposit link created. Email is ready but not sent yet; use Compose email in the reservation row until sending is enabled.");
    } else {
      window.alert(result.message || "Request approved.");
    }
  } catch (error) {
    button.disabled = false;
    if (specialOfferInput) specialOfferInput.disabled = false;
    button.textContent = label;
    window.alert(error.message);
  }
}

async function createBalanceLink(id, button) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Creating...";
  try {
    const result = await postJson(`/api/admin/reservations/${encodeURIComponent(id)}/balance`, {});
    await Promise.all([loadReservations(), loadMessageQueue()]);
    if (result.email?.status === "sent") {
      window.alert("Balance link created and emailed to the guest.");
    } else if (result.email?.status === "failed") {
      const detail = result.email.error ? `\n\nEmail error: ${result.email.error}` : "";
      window.alert(`Balance link created, but the email could not be sent. Use Open balance link or Compose balance email in the reservation row.${detail}`);
    } else if (result.checkoutUrl) {
      window.alert("Balance link created. Email is ready but not sent yet; use Compose balance email in the reservation row until sending is enabled.");
    } else {
      window.alert(result.message || "Balance link created.");
    }
  } catch (error) {
    button.disabled = false;
    button.textContent = label;
    window.alert(error.message);
  }
}

async function declineReservation(id, button) {
  const label = button.textContent;
  if (!window.confirm("Decline this booking request and release its dates?")) {
    return;
  }
  button.disabled = true;
  button.textContent = "Declining...";
  try {
    await postJson(`/api/admin/reservations/${encodeURIComponent(id)}/decline`, {});
    await loadReservations();
  } catch (error) {
    button.disabled = false;
    button.textContent = label;
    window.alert(error.message);
  }
}

async function markMessageSent(id, button) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = "Saving...";
  try {
    await patchJson(`/api/admin/message-queue/${encodeURIComponent(id)}`, { status: "sent" });
    await loadMessageQueue();
  } catch (error) {
    button.disabled = false;
    button.textContent = label;
    window.alert(error.message);
  }
}

function setBlockMessage(message, isError = false) {
  els.blockMessage.textContent = message;
  els.blockMessage.classList.toggle("error", isError);
}

function setSyncMessage(message, isError = false) {
  els.syncMessage.textContent = message;
  els.syncMessage.classList.toggle("error", isError);
}

function setMessageQueueMessage(message, isError = false) {
  els.messageQueueMessage.textContent = message;
  els.messageQueueMessage.classList.toggle("error", isError);
}

async function getJson(url) {
  const response = await fetch(url);
  return readJsonResponse(response);
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
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

async function deleteJson(url) {
  const response = await fetch(url, { method: "DELETE" });
  return readJsonResponse(response);
}

async function readJsonResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    const text = await response.text();
    const looksLikeHtml = text.trim().startsWith("<");
    const message = looksLikeHtml
      ? "The server returned a web page instead of app data. Refresh after the deploy finishes; if this repeats, check the Render logs."
      : text.trim() || "The server returned an unexpected response.";
    throw new Error(message);
  }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function money(amount, currency = "USD") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount);
}

function remainingBalance(reservation) {
  const total = Number(reservation.quote?.total || 0);
  const paid = Number(reservation.amountPaid || 0);
  return Math.max(total - paid, 0);
}

function formatDate(iso) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC"
  });
}

function formatDateWithYear(iso) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  });
}

function formatDateTime(iso) {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  });
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function firstOfMonth(iso) {
  return `${iso.slice(0, 7)}-01`;
}

function addDaysIso(iso, days) {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
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

function isSameMonth(iso, year, month) {
  const date = new Date(`${iso}T00:00:00Z`);
  return date.getUTCFullYear() === year && date.getUTCMonth() === month;
}

function isExpiredHold(reservation) {
  return reservation.holdExpiresAt && new Date(reservation.holdExpiresAt).getTime() <= Date.now();
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
