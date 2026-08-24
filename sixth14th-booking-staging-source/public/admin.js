const els = {
  stagingStatus: document.querySelector("#stagingStatus"),
  reservationTable: document.querySelector("#reservationTable"),
  refreshAdmin: document.querySelector("#refreshAdmin"),
  syncLodgify: document.querySelector("#syncLodgify"),
  syncMessage: document.querySelector("#syncMessage"),
  blockForm: document.querySelector("#blockForm"),
  blockMessage: document.querySelector("#blockMessage"),
  messageList: document.querySelector("#messageList")
};

await initAdmin();

async function initAdmin() {
  await Promise.all([loadStatus(), loadReservations(), loadMessages()]);
  els.refreshAdmin.addEventListener("click", loadReservations);
  els.syncLodgify.addEventListener("click", syncLodgify);
  els.blockForm.addEventListener("submit", addBlock);
}

async function loadStatus() {
  const status = await getJson("/api/staging/status");
  const items = [
    ["Private access", status.privateAccessEnabled ? "enabled" : "off"],
    ["Stripe", status.stripeConfigured ? status.stripeMode : "not configured"],
    ["Stripe webhook", status.stripeWebhookConfigured ? "configured" : "missing"],
    ["Live Stripe unlock", status.liveStripeUnlocked ? "enabled" : "blocked"],
    ["Lodgify sync", status.lodgifySyncConfigured ? "configured" : "manual/local"],
    ["Email", status.emailConfigured ? "configured" : "not configured"],
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
  renderReservations(store.reservations || [], store.manualBlocks || [], store.availabilityBlocks || []);
}

async function loadMessages() {
  const messages = await getJson("/api/admin/messages");
  els.messageList.replaceChildren(...messages.map(renderMessage));
}

async function syncLodgify() {
  els.syncLodgify.disabled = true;
  setSyncMessage("Syncing Lodgify calendar...");
  try {
    const result = await postJson("/api/admin/sync-lodgify", {});
    const warning = (result.warnings || []).length ? ` Warning: ${result.warnings.join(" ")}` : "";
    setSyncMessage(
      `Synced ${result.importedBookings} booking ${result.importedBookings === 1 ? "summary" : "summaries"} and ${result.availabilityBlocks} availability ${result.availabilityBlocks === 1 ? "block" : "blocks"}.${warning}`,
      Boolean(warning)
    );
    await Promise.all([loadStatus(), loadReservations()]);
  } catch (error) {
    setSyncMessage(error.message, true);
  } finally {
    els.syncLodgify.disabled = false;
  }
}

function renderReservations(reservations, blocks, availabilityBlocks) {
  const rows = [];
  const knownLodgifyIds = new Set(
    reservations
      .filter((reservation) => reservation.source === "lodgify" && reservation.externalId)
      .map((reservation) => String(reservation.externalId))
  );
  const head = document.createElement("div");
  head.className = "data-head";
  head.innerHTML = "<span>Guest or block</span><span>Dates</span><span>Status</span><span>Payment</span><span>Total</span><span>Actions</span>";
  rows.push(head);

  for (const block of blocks) {
    const row = document.createElement("div");
    row.className = "data-row";
    row.innerHTML = `
      <strong>${escapeHtml(block.reason || "Manual block")}</strong>
      <span>${formatDate(block.start)} to ${formatDate(block.end)}</span>
      <span class="status-pill">blocked</span>
      <span>-</span>
      <span>-</span>
      <span>-</span>
    `;
    rows.push(row);
  }

  for (const block of availabilityBlocks) {
    const bookingIds = Array.isArray(block.bookingIds) ? block.bookingIds.map(String) : [];
    if (bookingIds.length && bookingIds.every((id) => knownLodgifyIds.has(id))) continue;
    const row = document.createElement("div");
    row.className = "data-row";
    row.innerHTML = `
      <strong>${escapeHtml(block.reason || "Synced Lodgify availability")}</strong>
      <span>${formatDate(block.start)} to ${formatDate(block.displayEnd || block.end)}</span>
      <span class="status-pill">lodgify_blocked</span>
      <span>synced</span>
      <span>-</span>
      <span>-</span>
    `;
    rows.push(row);
  }

  for (const reservation of reservations) {
    const row = document.createElement("div");
    row.className = "data-row";
    row.dataset.reservationId = reservation.id;
    row.innerHTML = `
      <div><strong>${escapeHtml(reservation.guest?.name || "Guest")}</strong><br><span class="muted">${escapeHtml(reservation.guest?.email || "")}</span></div>
      <span>${formatDate(reservation.arrival)} to ${formatDate(reservation.departure)}</span>
      <span class="status-pill">${escapeHtml(displayReservationStatus(reservation))}</span>
      <span>${paymentSummary(reservation)}</span>
      <strong>${money(reservation.quote?.total || 0, reservation.quote?.currency || "USD")}</strong>
      <span>${reservationAction(reservation)}</span>
    `;
    const cancelButton = row.querySelector("[data-action='cancel-hold']");
    if (cancelButton) {
      cancelButton.addEventListener("click", () => cancelHold(reservation.id, cancelButton));
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

function displayReservationStatus(reservation) {
  if (reservation.status === "pending_payment" && isExpiredHold(reservation)) {
    return "hold_expired";
  }
  return reservation.status;
}

function paymentSummary(reservation) {
  const status = escapeHtml(reservation.paymentStatus || "-");
  if (!reservation.holdExpiresAt || reservation.status !== "pending_payment") {
    return status;
  }
  const label = isExpiredHold(reservation) ? "Hold expired" : "Hold expires";
  return `${status}<br><span class="muted">${label} ${escapeHtml(formatDateTime(reservation.holdExpiresAt))}</span>`;
}

function reservationAction(reservation) {
  if (reservation.status !== "pending_payment") {
    return "-";
  }
  return '<button type="button" class="text-button" data-action="cancel-hold">Cancel hold</button>';
}

function renderMessage(message) {
  const item = document.createElement("article");
  item.className = `message-item${message.enabled ? "" : " disabled"}`;
  item.innerHTML = `
    <strong>${escapeHtml(message.name)}</strong>
    <span>${escapeHtml(message.trigger)} · ${message.enabled ? "enabled" : "disabled"}</span>
  `;
  return item;
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

async function cancelHold(id, button) {
  if (!window.confirm("Cancel this pending payment hold? The dates will become available again.")) {
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
    button.textContent = "Cancel hold";
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

async function patchJson(url, payload) {
  const response = await fetch(url, {
    method: "PATCH",
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
