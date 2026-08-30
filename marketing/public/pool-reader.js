/** Render the public pool page only from existing live API surfaces. */
(function (scope) {
  "use strict";

  var ENDPOINTS = Object.freeze({
    pool: "https://api.averray.com/pool",
    onboarding: "https://api.averray.com/onboarding",
    transparency: "https://api.averray.com/transparency"
  });
  var PERFORMANCE_CLAIM = /\b(?:rate|apy|projection)\b|yield\s+date/iu;

  function record(value, field) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(field + " is missing");
    }
    return value;
  }

  function text(value, field) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(field + " is missing");
    }
    var result = value.trim();
    if (PERFORMANCE_CLAIM.test(result)) {
      throw new Error(field + " contains a forbidden performance claim");
    }
    return result;
  }

  function address(value, field) {
    var result = text(value, field);
    if (!/^0x[0-9a-fA-F]{40}$/u.test(result)) throw new Error(field + " is malformed");
    return result;
  }

  function amount(value, field) {
    var source = record(value, field);
    var raw = text(source.raw, field + ".raw");
    var decimals = Number(source.decimals);
    if (!/^-?[0-9]+$/u.test(raw) || !Number.isSafeInteger(decimals) || decimals < 0) {
      throw new Error(field + " is malformed");
    }
    return { raw: raw, decimals: decimals };
  }

  function publicField(value, field) {
    var source = record(value, field);
    return {
      value: text(source.value, field + ".value"),
      unit: text(source.unit, field + ".unit")
    };
  }

  function parsePool(payload) {
    var source = record(payload, "pool");
    if (source.available !== true) throw new Error("pool is unavailable");
    var venue = record(source.venueMark, "pool.venueMark");
    var caps = record(source.caps, "pool.caps");
    var sharePrice = record(source.sharePrice, "pool.sharePrice");

    return {
      pool: address(source.pool, "pool.pool"),
      assetSymbol: text(record(record(source.units, "pool.units").asset, "pool.units.asset").symbol, "pool.units.asset.symbol"),
      totalAssets: amount(source.totalAssets, "pool.totalAssets"),
      bufferAssets: amount(source.bufferAssets, "pool.bufferAssets"),
      sharePrice: amount(sharePrice.assetsPerShare, "pool.sharePrice.assetsPerShare"),
      totalAssetCap: amount(caps.totalAssetCap, "pool.caps.totalAssetCap"),
      perAgentAssetCap: amount(caps.perAgentAssetCap, "pool.caps.perAgentAssetCap"),
      poolHeadroom: amount(caps.poolHeadroom, "pool.caps.poolHeadroom"),
      yieldStatus: text(source.yieldStatus, "pool.yieldStatus"),
      yieldStatusText: text(source.yieldStatusText, "pool.yieldStatusText"),
      disclosure: text(record(source.disclosure, "pool.disclosure").statement, "pool.disclosure.statement"),
      capitalSignal: text(record(source.capitalSignal, "pool.capitalSignal").statement, "pool.capitalSignal.statement"),
      withdrawal: text(record(source.withdrawal, "pool.withdrawal").note, "pool.withdrawal.note"),
      venue: {
        status: text(venue.status, "pool.venueMark.status"),
        statement: text(venue.statement, "pool.venueMark.statement"),
        depositsBlocked: venue.depositsBlocked === true
      }
    };
  }

  function parseOnboarding(payload) {
    var source = record(payload, "onboarding");
    var products = record(source.products, "onboarding.products");
    var locked = record(products.lockedDeposits, "onboarding.products.lockedDeposits");
    if (locked.enabled !== true || !Array.isArray(locked.tiers) || locked.tiers.length === 0) {
      throw new Error("locked deposit terms are unavailable");
    }
    return {
      priority: text(locked.priority, "onboarding.products.lockedDeposits.priority"),
      tiers: locked.tiers.map(function (tier, index) {
        var item = record(tier, "onboarding tier");
        var termDays = Number(item.termDays);
        if (!Number.isSafeInteger(termDays) || termDays <= 0) {
          throw new Error("onboarding tier term is malformed");
        }
        if (!Array.isArray(item.perks) || item.perks.length === 0) {
          throw new Error("onboarding tier perks are missing");
        }
        return {
          tier: text(item.tier, "onboarding tier name " + index),
          termDays: termDays,
          perks: item.perks.map(function (perk) { return text(perk, "onboarding tier perk"); })
        };
      })
    };
  }

  function parseTransparency(payload) {
    var source = record(payload, "transparency");
    var pools = record(source.depositPools, "transparency.depositPools");
    function generation(name) {
      var item = record(pools[name], "transparency.depositPools." + name);
      return {
        label: publicField(item.label, name + ".label"),
        address: publicField(item.address, name + ".address"),
        totalAssets: publicField(item.totalAssets, name + ".totalAssets"),
        bufferAssets: publicField(item.bufferAssets, name + ".bufferAssets"),
        deployedStatus: publicField(item.deployedStatus, name + ".deployedStatus")
      };
    }
    var live = generation("live");
    var legacy = generation("legacy");
    address(live.address.value, "live.address.value");
    address(legacy.address.value, "legacy.address.value");
    return { live: live, legacy: legacy };
  }

  function formatAmount(value, unit) {
    var negative = value.raw.startsWith("-");
    var digits = negative ? value.raw.slice(1) : value.raw;
    var padded = digits.padStart(value.decimals + 1, "0");
    var whole = value.decimals === 0 ? padded : padded.slice(0, -value.decimals);
    var fraction = value.decimals === 0 ? "" : padded.slice(-value.decimals).replace(/0+$/u, "");
    var grouped = BigInt(whole).toLocaleString("en-US");
    return (negative ? "−" : "") + grouped + (fraction ? "." + fraction : "") + " " + unit;
  }

  function setText(selector, value, root) {
    var host = (root || document).querySelector(selector);
    if (host) host.textContent = value;
  }

  function displayStatus(value) {
    return value.replace(/_/gu, " ");
  }

  function renderPool(value) {
    var root = document.querySelector("[data-public-pool]");
    if (!root) return;
    var noCurrentEarnings = value.yieldStatus === "not_yet_earning";
    setText(
      "[data-pool-yield-heading]",
      noCurrentEarnings ? "A deposit today earns nothing." : "Read the current earning state before depositing."
    );
    setText("[data-pool-yield-state]", displayStatus(value.yieldStatus));
    setText("[data-pool-yield-text]", value.yieldStatusText);
    setText("[data-pool-risk-statement]", value.disclosure);
    setText("[data-pool-total-assets]", formatAmount(value.totalAssets, value.assetSymbol));
    setText("[data-pool-buffer]", formatAmount(value.bufferAssets, value.assetSymbol));
    setText("[data-pool-share-price]", formatAmount(value.sharePrice, value.assetSymbol));
    setText("[data-pool-total-cap]", formatAmount(value.totalAssetCap, value.assetSymbol));
    setText("[data-pool-agent-cap]", formatAmount(value.perAgentAssetCap, value.assetSymbol));
    setText("[data-pool-headroom]", formatAmount(value.poolHeadroom, value.assetSymbol));
    setText("[data-pool-venue-status]", displayStatus(value.venue.status));
    setText("[data-pool-venue-statement]", value.venue.statement);
    setText("[data-pool-capital-signal]", value.capitalSignal);
    setText("[data-pool-withdrawal]", value.withdrawal);
    root.dataset.poolPageState = "live";
    var actions = root.querySelector("[data-pool-cta]");
    if (actions) actions.hidden = value.venue.depositsBlocked;
  }

  function renderOnboarding(value) {
    setText("[data-pool-priority]", value.priority);
    var host = document.querySelector("[data-pool-tiers]");
    if (!host) return;
    var cards = value.tiers.map(function (tier) {
      var article = document.createElement("article");
      article.className = "pool-tier";
      var eyebrow = document.createElement("p");
      eyebrow.className = "pillar__eyebrow";
      eyebrow.textContent = tier.tier.toUpperCase();
      var heading = document.createElement("h3");
      heading.className = "pillar__title";
      heading.textContent = tier.termDays.toLocaleString("en-US") + " day commitment";
      var list = document.createElement("ul");
      list.className = "pool-tier__perks";
      tier.perks.forEach(function (perk) {
        var item = document.createElement("li");
        item.textContent = perk;
        list.appendChild(item);
      });
      article.append(eyebrow, heading, list);
      return article;
    });
    host.replaceChildren.apply(host, cards);
  }

  function renderTransparency(value, pool) {
    ["live", "legacy"].forEach(function (name) {
      var item = value[name];
      var host = document.querySelector('[data-pool-generation="' + name + '"]');
      if (!host) return;
      setText("[data-pool-generation-label]", item.label.value, host);
      setText("[data-pool-generation-address]", item.address.value, host);
      setText("[data-pool-generation-total]", item.totalAssets.value + " " + item.totalAssets.unit, host);
      setText("[data-pool-generation-buffer]", item.bufferAssets.value + " " + item.bufferAssets.unit, host);
      setText("[data-pool-generation-deployment]", displayStatus(item.deployedStatus.value), host);
      if (name === "live") {
        var isCurrent = item.address.value.toLowerCase() === pool.pool.toLowerCase();
        setText(
          "[data-pool-generation-role]",
          isCurrent && !pool.venue.depositsBlocked
            ? "Current pool · open to new deposits"
            : "Current pool · deposits are not open",
          host
        );
      }
    });
  }

  function showPrimaryFailure() {
    var root = document.querySelector("[data-public-pool]");
    if (!root) return;
    root.dataset.poolPageState = "unavailable";
    setText("[data-pool-yield-state]", "live read unavailable");
    setText("[data-pool-yield-heading]", "Do not deposit from a stale page.");
    setText("[data-pool-yield-text]", "Read GET /pool directly before acting.");
    setText("[data-pool-risk-statement]", "Live risk disclosure unavailable. Read GET /pool directly before acting.");
    var actions = root.querySelector("[data-pool-cta]");
    if (actions) actions.hidden = true;
  }

  async function load() {
    if (!scope.AverrayReaderFetch || typeof document === "undefined") return;
    var options = { credentials: "omit", headers: { Accept: "application/json" } };
    var pool;
    try {
      pool = parsePool(await scope.AverrayReaderFetch.readJsonWithRetry(ENDPOINTS.pool, options));
      renderPool(pool);
    } catch (_error) {
      showPrimaryFailure();
      return;
    }

    var secondary = await Promise.allSettled([
      scope.AverrayReaderFetch.readJsonWithRetry(ENDPOINTS.onboarding, options),
      scope.AverrayReaderFetch.readJsonWithRetry(ENDPOINTS.transparency, options)
    ]);
    if (secondary[0].status === "fulfilled") {
      try { renderOnboarding(parseOnboarding(secondary[0].value)); } catch (_error) { /* keep named loading copy */ }
    }
    if (secondary[1].status === "fulfilled") {
      try { renderTransparency(parseTransparency(secondary[1].value), pool); } catch (_error) { /* keep unavailable slots */ }
    }
  }

  scope.AverrayPublicPool = Object.freeze({
    ENDPOINTS: ENDPOINTS,
    parseOnboarding: parseOnboarding,
    parsePool: parsePool,
    parseTransparency: parseTransparency,
    renderPool: renderPool,
    renderTransparency: renderTransparency
  });

  load();
})(window);
