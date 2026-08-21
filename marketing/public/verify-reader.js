/** Render Verify profile facts only from the live public profile endpoint. */
(function () {
  "use strict";

  var ENDPOINT = "https://api.averray.com/verify/profiles";
  var FALLBACK = "Pricing is served live; it could not be loaded just now — query /verify/profiles directly.";

  function text(value) {
    return value === undefined || value === null ? "—" : String(value);
  }

  function appendFact(host, label, value) {
    var item = document.createElement("p");
    item.className = "pillar__body";
    var strong = document.createElement("strong");
    strong.textContent = label + ": ";
    item.appendChild(strong);
    item.appendChild(document.createTextNode(text(value)));
    host.appendChild(item);
  }

  function renderProfile(profile) {
    var card = document.createElement("article");
    card.className = "pillar";

    var name = document.createElement("h3");
    name.className = "pillar__title";
    name.textContent = text(profile.name);
    card.appendChild(name);

    appendFact(card, "Version", profile.version);
    appendFact(card, "Handler", text(profile.handler) + "@" + text(profile.handlerVersion));

    var price = profile.price || {};
    appendFact(card, "Price", text(price.amount) + " " + text(price.asset) + " per run");

    var limits = profile.limits && typeof profile.limits === "object" ? profile.limits : {};
    Object.keys(limits).sort().forEach(function (key) {
      appendFact(card, key, limits[key]);
    });

    return card;
  }

  async function loadProfiles() {
    var root = document.getElementById("verify-profiles");
    if (!root) return;
    var status = root.querySelector("[data-profile-status]");
    var list = root.querySelector("[data-profile-list]");

    try {
      var payload = await window.AverrayReaderFetch.readJsonWithRetry(ENDPOINT, {
        credentials: "omit",
        headers: { Accept: "application/json" }
      });
      if (!payload || !Array.isArray(payload.profiles) || payload.profiles.length === 0) {
        throw new Error("profile read was empty");
      }

      list.replaceChildren.apply(list, payload.profiles.map(renderProfile));
      status.hidden = true;
    } catch (_error) {
      list.replaceChildren();
      status.hidden = false;
      status.textContent = FALLBACK;
    }
  }

  loadProfiles();
})();
