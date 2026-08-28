/** Render Verify payment terms only from the live x402 discovery document. */
(function (scope) {
  "use strict";

  var ENDPOINT = "https://api.averray.com/.well-known/x402";
  var VERIFY_RUNS_ENDPOINT = "https://api.averray.com/verify/runs";
  var BASE_USDC_ASSET = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
  var BASE_NETWORK = "eip155:8453";
  var USDC_DECIMALS = 6;
  var FALLBACK = "See live pricing in the discovery document.";

  function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function requiredString(value, field) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(field + " is missing");
    }
    return value.trim();
  }

  function formatUnits(raw, decimals) {
    var padded = raw.padStart(decimals + 1, "0");
    var whole = padded.slice(0, -decimals);
    var fraction = padded.slice(-decimals).replace(/0+$/u, "");
    return fraction ? whole + "." + fraction : whole;
  }

  function parseDiscovery(payload) {
    if (!isRecord(payload) || payload.x402Version === undefined) {
      throw new Error("x402 discovery document is malformed");
    }
    if (!Array.isArray(payload.resources) || payload.resources.length === 0) {
      throw new Error("x402 discovery resources are missing");
    }

    var resource = payload.resources[0];
    if (!isRecord(resource) || requiredString(resource.resource, "resources[0].resource") !== VERIFY_RUNS_ENDPOINT) {
      throw new Error("Verify run resource is missing");
    }
    if (!Array.isArray(resource.accepts) || resource.accepts.length === 0 || !isRecord(resource.accepts[0])) {
      throw new Error("resources[0].accepts[0] is missing");
    }

    var accepted = resource.accepts[0];
    var amountRaw = requiredString(accepted.amount, "resources[0].accepts[0].amount");
    if (!/^[1-9][0-9]*$/u.test(amountRaw)) {
      throw new Error("accepted amount is not an exact positive integer string");
    }

    var network = requiredString(accepted.network, "resources[0].accepts[0].network");
    var asset = requiredString(accepted.asset, "resources[0].accepts[0].asset");
    var payTo = requiredString(accepted.payTo, "resources[0].accepts[0].payTo");
    var scheme = requiredString(accepted.scheme, "resources[0].accepts[0].scheme");
    if (!/^0x[0-9a-fA-F]{40}$/u.test(asset) || !/^0x[0-9a-fA-F]{40}$/u.test(payTo)) {
      throw new Error("accepted asset or recipient is malformed");
    }

    var isBaseUsdc = network === BASE_NETWORK && asset.toLowerCase() === BASE_USDC_ASSET;
    return {
      amount: isBaseUsdc ? formatUnits(amountRaw, USDC_DECIMALS) : amountRaw + " base units",
      asset: asset,
      assetLabel: isBaseUsdc ? "USDC" : asset,
      network: network,
      networkLabel: network === BASE_NETWORK ? "Base" : network,
      payTo: payTo,
      scheme: scheme,
      x402Version: String(payload.x402Version)
    };
  }

  function showFallback(root, status, panel) {
    root.dataset.verifyPricingState = "fallback";
    panel.hidden = true;
    status.hidden = false;
    var link = document.createElement("a");
    link.href = ENDPOINT;
    link.textContent = "Open live pricing.";
    status.replaceChildren(document.createTextNode(FALLBACK + " "), link);
  }

  async function loadPricing() {
    var root = document.getElementById("verify-pricing");
    if (!root) return;
    var status = root.querySelector("[data-verify-pricing-status]");
    var panel = root.querySelector("[data-verify-pricing]");
    if (!status || !panel) return;

    try {
      var payload = await scope.AverrayReaderFetch.readJsonWithRetry(ENDPOINT, {
        credentials: "omit",
        headers: { Accept: "application/json" }
      });
      var terms = parseDiscovery(payload);

      root.querySelector("[data-verify-price]").textContent = terms.amount + " " + terms.assetLabel + " per run";
      root.querySelector("[data-verify-protocol]").textContent = terms.scheme + " payment · x402 version " + terms.x402Version;
      root.querySelector("[data-verify-network]").textContent = terms.networkLabel + " (" + terms.network + ")";
      root.querySelector("[data-verify-asset]").textContent = terms.asset;
      root.querySelector("[data-verify-pay-to]").textContent = terms.payTo;
      root.dataset.verifyPricingState = "live";
      panel.hidden = false;
      status.hidden = true;
    } catch (_error) {
      showFallback(root, status, panel);
    }
  }

  scope.AverrayVerifyDiscovery = Object.freeze({
    ENDPOINT: ENDPOINT,
    FALLBACK: FALLBACK,
    parseDiscovery: parseDiscovery
  });

  if (typeof document !== "undefined") loadPricing();
})(window);
