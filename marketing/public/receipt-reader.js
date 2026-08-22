(() => {
  const root = document.querySelector("[data-receipt-state]");
  const status = document.querySelector("[data-receipt-status]");
  const receiptRoot = document.querySelector("[data-receipt]");
  const guidance = document.querySelector("[data-receipt-guidance]");
  const guidanceMessage = document.querySelector("[data-receipt-guidance-message]");
  const match = window.location.pathname.match(/^\/receipts\/(0x[a-fA-F0-9]{64})\/?$/u);

  function read(value, path) {
    return path.split(".").reduce((current, key) => current?.[key], value);
  }

  function fail(message) {
    root.dataset.receiptState = "error";
    status.textContent = message;
    if (guidanceMessage) guidanceMessage.textContent = message;
    if (guidance) guidance.hidden = false;
  }

  if (!match) {
    const hasPathId = window.location.pathname.replace(/^\/receipts\/?/u, "").length > 0;
    fail(hasPathId ? "no receipt found for this id" : "no receipt id in the URL");
    return;
  }

  const receiptId = match[1].toLowerCase();
  const endpoint = `https://api.averray.com/receipts/${encodeURIComponent(receiptId)}`;
  const rawLink = document.querySelector("[data-receipt-raw-url]");
  if (rawLink) {
    rawLink.href = endpoint;
    rawLink.textContent = endpoint.replace(/^https:\/\//u, "");
  }

  window.AverrayReaderFetch.readJsonWithRetry(endpoint, {
    headers: { accept: "application/json" }
  }).then((receipt) => {
    document.querySelectorAll("[data-field]").forEach((element) => {
      const value = read(receipt, element.dataset.field);
      element.textContent = value === undefined || value === null ? "—" : String(value);
    });
    document.querySelector("[data-receipt-json]").textContent = JSON.stringify(receipt, null, 2);
    document.querySelector("[data-settlement]").hidden = !receipt.settlement;
    status.hidden = true;
    receiptRoot.hidden = false;
    root.dataset.receiptState = "ready";
  }).catch((error) => fail(error && error.status === 404 ? "no receipt found for this id" : "Receipt is temporarily unavailable."));
})();
