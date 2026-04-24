/* ================================================================
   Averray homepage — live-feel console stream.
   Renders a faux SSE feed of a run moving through the lifecycle:
   claimed → submitted → verified → settled, then cycles.
   Topics mirror the operator app's real SSE channel names.
   No network, deterministic, respects prefers-reduced-motion.
   ================================================================ */
(function () {
  const streamEl = document.getElementById("stream");
  const rail = document.getElementById("lifecycle-rail");
  if (!streamEl || !rail) return;

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- realistic-looking identifiers ------------------------------
  const WALLETS = [
    "0xFd2EAE…6519",
    "0x9A13C2…0cb2",
    "0x72aA41…d110",
    "0x4e12C9…b11e",
  ];
  const JOBS = [
    { id: "starter-coding-001", schema: "schemas/jobs/coding.v2", policy: "deps/sec-only" },
    { id: "ops-schema-dual-014", schema: "schemas/jobs/ops.v1",    policy: "ops/schema-dual-sign" },
    { id: "writer-docs-v3-082", schema: "schemas/jobs/writer.v1",  policy: "writer/no-external-links" },
    { id: "gov-review-2-007",   schema: "schemas/jobs/review.v1",  policy: "gov/co-sign-required" },
  ];

  // ---- lifecycle rail state --------------------------------------
  function setStep(step, state, value) {
    const node = rail.querySelector(`[data-step="${step}"]`);
    if (!node) return;
    node.classList.remove("is-active", "is-done");
    if (state === "active") node.classList.add("is-active");
    if (state === "done")   node.classList.add("is-done");
    const valEl = node.querySelector(".lifestep__value");
    if (valEl && value !== undefined) valEl.textContent = value;
  }
  function resetRail() {
    ["claimed", "submitted", "verified", "settled"].forEach(s => setStep(s, "idle", "—"));
  }

  // ---- time helpers -----------------------------------------------
  function fmt(d) {
    const p = n => String(n).padStart(2, "0");
    return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
  }
  let clock = new Date(Date.UTC(2026, 3, 24, 14, 8, 0)); // deterministic start
  function tickClock(ms) {
    clock = new Date(clock.getTime() + ms);
    return fmt(clock);
  }

  // ---- event row factory -----------------------------------------
  function addEvent({ topic, tone = "ok", body, wait = 300 }) {
    return new Promise(resolve => {
      const row = document.createElement("div");
      row.className = "ev";
      const toneClass = tone === "warn" ? "ev__topic--warn" : tone === "info" ? "ev__topic--info" : "";
      row.innerHTML = `
        <span class="ev__ts">${fmt(clock)}</span>
        <div class="ev__body">
          <span class="ev__topic ${toneClass}">${topic}</span>
          &nbsp;${body}
        </div>`;
      streamEl.appendChild(row);
      streamEl.scrollTop = streamEl.scrollHeight;
      trimStream();
      setTimeout(resolve, reduced ? 60 : wait);
    });
  }

  function addReceipt({ runId, job, wallet, cosigner, hash }) {
    return new Promise(resolve => {
      const row = document.createElement("div");
      row.className = "ev";
      row.innerHTML = `
        <span class="ev__ts">${fmt(clock)}</span>
        <div class="ev__body">
          <span class="ev__topic">receipt.signed</span>
          <dl class="receipt">
            <div class="receipt__head">
              <h5>${runId} · ${job.policy}</h5>
              <span class="receipt__pill"><span class="lifestep__dot" style="background:#8ee0b4"></span>Verified</span>
            </div>
            <dt>job</dt>        <dd class="ev__hash">${job.id}</dd>
            <dt>schema</dt>     <dd class="ev__hash">${job.schema}</dd>
            <dt>signer</dt>     <dd class="ev__hash">${wallet}</dd>
            <dt>verifier</dt>   <dd class="ev__hash">${cosigner}</dd>
            <dt>hash</dt>       <dd class="ev__hash">${hash}</dd>
          </dl>
        </div>`;
      streamEl.appendChild(row);
      streamEl.scrollTop = streamEl.scrollHeight;
      trimStream();
      setTimeout(resolve, reduced ? 80 : 520);
    });
  }

  function trimStream() {
    // Keep the last ~14 rows so the feed stays lively but not heavy.
    while (streamEl.childElementCount > 14) streamEl.removeChild(streamEl.firstElementChild);
  }

  // ---- one full run cycle -----------------------------------------
  function shortHash() {
    return "0x" + Math.random().toString(16).slice(2, 6) + "…" + Math.random().toString(16).slice(2, 6);
  }
  function runId() {
    return "run-" + (2700 + Math.floor(Math.random() * 80));
  }

  async function cycle() {
    resetRail();
    const job = JOBS[Math.floor(Math.random() * JOBS.length)];
    const wallet = WALLETS[Math.floor(Math.random() * WALLETS.length)];
    let cosigner = WALLETS[Math.floor(Math.random() * WALLETS.length)];
    while (cosigner === wallet) cosigner = WALLETS[Math.floor(Math.random() * WALLETS.length)];
    const rid = runId();
    const h = shortHash();

    // 1. discover / claim
    tickClock(1000);
    await addEvent({
      topic: "session.claim.opened",
      tone: "info",
      body: `<span class="ev__meta">job</span> <span class="ev__hash">${job.id}</span> <span class="ev__meta">wallet</span> <span class="ev__hash">${wallet}</span>`,
      wait: 420,
    });
    setStep("claimed", "active", job.id.slice(0, 22));

    tickClock(2400);
    await addEvent({
      topic: "siwe.signature.accepted",
      tone: "ok",
      body: `<span class="ev__meta">run</span> <span class="ev__hash">${rid}</span> <span class="ev__meta">stake</span> <span class="ev__hash">12.0 DOT · locked</span>`,
      wait: 480,
    });
    setStep("claimed", "done", wallet);
    setStep("submitted", "active", "—");

    // 2. submit output
    tickClock(3600);
    await addEvent({
      topic: "session.output.submitted",
      tone: "info",
      body: `<span class="ev__meta">schema</span> <span class="ev__hash">${job.schema}</span> <span class="ev__meta">size</span> <span class="ev__hash">4.1 KB</span>`,
      wait: 500,
    });
    setStep("submitted", "done", job.schema);
    setStep("verified", "active", job.policy);

    // 3. verifier checks + signs
    tickClock(1800);
    await addEvent({
      topic: "verifier.policy.loaded",
      tone: "info",
      body: `<span class="ev__meta">policy</span> <span class="ev__hash">${job.policy}</span>`,
      wait: 380,
    });
    tickClock(900);
    await addEvent({
      topic: "verifier.checks.passing",
      tone: "ok",
      body: `<span class="ev__meta">3/3</span> <span class="ev__hash">schema · signer · co-signer</span>`,
      wait: 420,
    });
    setStep("verified", "done", "3/3 passed");
    setStep("settled", "active", "writing…");

    // 4. the receipt itself
    tickClock(1100);
    await addReceipt({ runId: rid, job, wallet, cosigner, hash: h });

    // 5. settle on polkadot
    tickClock(2100);
    await addEvent({
      topic: "settle.xcm.submitted",
      tone: "info",
      body: `<span class="ev__meta">para</span> <span class="ev__hash">asset-hub</span> <span class="ev__meta">hash</span> <span class="ev__hash">${h}</span>`,
      wait: 460,
    });
    tickClock(1600);
    await addEvent({
      topic: "settle.finalized",
      tone: "ok",
      body: `<span class="ev__meta">block</span> <span class="ev__hash">#5,471,${Math.floor(100 + Math.random()*900)}</span> <span class="ev__meta">in</span> <span class="ev__hash">12.4s</span>`,
      wait: 800,
    });
    setStep("settled", "done", "finalized");

    // pause and loop (unless reduced motion — then stop after one cycle)
    if (reduced) return;
    await new Promise(r => setTimeout(r, 2400));
    cycle();
  }

  // kick it off
  if (reduced) {
    // one static pass only
    cycle();
  } else {
    // small initial delay so it feels like it loaded
    setTimeout(cycle, 400);
  }
})();
