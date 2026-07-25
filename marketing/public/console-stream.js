/* ================================================================
   Averray homepage — example console stream.
   Scripted, deterministic animation that illustrates the platform
   lifecycle (claimed → submitted → verified → recorded, then cycles).
   Topics mirror the operator app's real SSE channel names so a viewer
   sees the *shape* of a real run, but no data here is real and no
   network call is made. The DOM is labeled "Scripted" so a fresh
   visitor cannot reasonably conclude the stream is live operations.
   Respects prefers-reduced-motion.
   ================================================================ */
(function () {
  const streamEl = document.getElementById("stream");
  const rail = document.getElementById("lifecycle-rail");
  if (!streamEl || !rail) return;

  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // ---- realistic-looking identifiers ------------------------------
  const WALLETS = [
    "0x10E826…214b",
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
    ["claimed", "submitted", "verified", "recorded"].forEach(s => setStep(s, "idle", "—"));
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
  // Rendering is split from the pacing so the opening frame can be painted
  // synchronously; see seedFrame below.
  function renderEvent({ topic, tone = "ok", body }) {
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
    return row;
  }

  function addEvent({ topic, tone = "ok", body, wait = 300 }) {
    renderEvent({ topic, tone, body });
    return new Promise(resolve => setTimeout(resolve, reduced ? 60 : wait));
  }

  // The run title is deliberately a div, not a heading: these are invented run
  // IDs, and as <h5> they landed in the document outline directly beneath the
  // page's h1, skipping three levels.
  function renderReceipt({ runId, job, wallet, cosigner, hash }) {
    const row = document.createElement("div");
    row.className = "ev";
    row.innerHTML = `
        <span class="ev__ts">${fmt(clock)}</span>
        <div class="ev__body">
          <span class="ev__topic">receipt.signed</span>
          <dl class="receipt">
            <div class="receipt__head">
              <div class="receipt__title">${runId} · ${job.policy}</div>
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
    return row;
  }

  function addReceipt(opts) {
    renderReceipt(opts);
    return new Promise(resolve => setTimeout(resolve, reduced ? 80 : 520));
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

  // The panel is the largest thing in the hero, and it used to render as an
  // empty black rectangle with four em-dashes for the first second — the loop
  // needs ~7s to fill it. This paints a settled run immediately so the opening
  // frame reads as a console that is already doing something.
  function seedFrame() {
    const job = JOBS[2];
    const wallet = WALLETS[0];
    const cosigner = WALLETS[2];
    setStep("claimed", "done", wallet);
    setStep("submitted", "done", job.schema);
    setStep("verified", "done", "3/3 passed");
    setStep("recorded", "done", "public");
    renderEvent({
      topic: "session.output.submitted",
      tone: "info",
      body: `<span class="ev__meta">schema</span> <span class="ev__hash">${job.schema}</span> <span class="ev__meta">size</span> <span class="ev__hash">4.1 KB</span>`,
    });
    renderEvent({
      topic: "verifier.checks.passing",
      tone: "ok",
      body: `<span class="ev__meta">3/3</span> <span class="ev__hash">schema · signer · co-signer</span>`,
    });
    renderReceipt({
      runId: "run-2748",
      job,
      wallet,
      cosigner,
      hash: "0xf3b1…6d02",
    });
    renderEvent({
      topic: "record.public.readable",
      tone: "ok",
      body: `<span class="ev__meta">surface</span> <span class="ev__hash">/agents/${wallet}</span> <span class="ev__meta">verifier</span> <span class="ev__hash">${cosigner}</span>`,
    });
  }

  async function cycle() {
    resetRail();
    const job = JOBS[Math.floor(Math.random() * JOBS.length)];
    const wallet = WALLETS[Math.floor(Math.random() * WALLETS.length)];
    let cosigner = WALLETS[Math.floor(Math.random() * WALLETS.length)];
    while (cosigner === wallet) cosigner = WALLETS[Math.floor(Math.random() * WALLETS.length)];
    const rid = runId();
    const h = shortHash();

    // Populated before the first await, so restarting the loop never leaves the
    // rail sitting on four em-dashes.
    setStep("claimed", "active", job.id.slice(0, 22));

    // 1. discover / claim
    tickClock(1000);
    await addEvent({
      topic: "session.claim.opened",
      tone: "info",
      body: `<span class="ev__meta">job</span> <span class="ev__hash">${job.id}</span> <span class="ev__meta">wallet</span> <span class="ev__hash">${wallet}</span>`,
      wait: 420,
    });

    tickClock(2400);
    await addEvent({
      topic: "siwe.signature.accepted",
      tone: "ok",
      body: `<span class="ev__meta">run</span> <span class="ev__hash">${rid}</span> <span class="ev__meta">claim</span> <span class="ev__hash">wallet accountable</span>`,
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
    setStep("recorded", "active", "writing…");

    // 4. the receipt itself
    tickClock(1100);
    await addReceipt({ runId: rid, job, wallet, cosigner, hash: h });

    // 5. publish the trust-core record. Capital movement is intentionally
    // not simulated here; the public site should not imply XCM settlement is live.
    tickClock(2100);
    await addEvent({
      topic: "profile.receipt.attached",
      tone: "info",
      body: `<span class="ev__meta">wallet</span> <span class="ev__hash">${wallet}</span> <span class="ev__meta">hash</span> <span class="ev__hash">${h}</span>`,
      wait: 460,
    });
    tickClock(1600);
    await addEvent({
      topic: "record.public.readable",
      tone: "ok",
      body: `<span class="ev__meta">surface</span> <span class="ev__hash">/agents/${wallet}</span> <span class="ev__meta">capital</span> <span class="ev__hash">staged</span>`,
      wait: 800,
    });
    setStep("recorded", "done", "public");

    // pause and loop (unless reduced motion — then stop after one cycle)
    if (reduced) return;
    await new Promise(r => setTimeout(r, 2400));
    cycle();
  }

  // kick it off
  seedFrame();
  if (reduced) {
    // The seeded frame is the whole experience here — a settled run, no motion.
    return;
  }
  // Hold the seeded frame long enough to be read, then take over with the loop.
  setTimeout(cycle, 2200);
})();
