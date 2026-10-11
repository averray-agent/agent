import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { Interface, id } from "ethers";
import YAML from "js-yaml";
import { ESCROW_CORE_ABI } from "../../mcp-server/src/blockchain/abis.js";
import { ADDRESSES, COLD_POSTER, DENYLIST, STRATEGY_ID, EVENTS, assertAllowedId, assertCommit, assertNonceIdle,
  buildPlan, classify, executePlan, hash, parseArgs, receiptEvidence, retirementFor, validateManifest,
  readRejectionEvidence, slashDistribution, createReader } from "./signer-cleanup.mjs";
import { parseArgs as rescueArgs, runRescueBatch, rescueBatchHash, sendCall } from "./rescue-open-job.mjs";

const exec = promisify(execFile);
const root = new URL("../../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("./signer-cleanup-2026-10.json", import.meta.url)));
const row = bucket => manifest.rows.find(r => r.bucket === bucket);
const now = 2_000_000;
const position = { liquid: "100", reserved: "999999999" };
const snapshot = (bucket, patch = {}) => bucket === "C" ? {
  now, shares: 37n, totalAssets: 1000n, totalShares: 100n, buffer: 1000n,
  active: true, async: false, paused: false, bindingsValid: true, ...patch
} : {
  now, paused: false, bindingsValid: true, retired: true, createdAt: 1, minOpenAge: 3600, disputeWindow: 604800,
  job: { state: { A: 1, B: 4, "B'": 4, D: 2 }[bucket], poster: bucket === "B'" ? COLD_POSTER : ADDRESSES.signer,
    worker: `0x${"1".repeat(40)}`, asset: ADDRESSES.asset, reward: "400000", released: "0", protocolFee: "100", protocolFeeReleased: "0",
    opsReserve: "30", contingencyReserve: "20", claimStake: "77", claimFee: "11", rejectedAt: 100, claimExpiry: 200,
    ...(patch.job ?? {}) }, ...Object.fromEntries(Object.entries(patch).filter(([k]) => k !== "job"))
};
const ready = bucket => classify(row(bucket), snapshot(bucket));
const commitArgs = plan => ({ expectedPlanHash: plan.planHash, confirm: `CLEANUP ${plan.planHash.slice(0, 12)}` });
function harness(rows = [ready("A"), ready("B")]) {
  const plan = buildPlan(rows, position), sent = [], logs = [];
  const io = { now: () => 0, read: async r => rows.find(x => x.row === r), position: async () => position,
    log: v => logs.push(v), assertNonceIdle: async () => {},
    send: async call => { sent.push(call); return { hash: "0xtx", nonce: 8, wait: async (confirmations, timeout) => {
      assert.equal(confirmations, 1); assert.ok(timeout > 0 && timeout <= 60_000); return { status: 1 };
    } }; },
    receiptEvidence: (receipt, r) => { assert.equal(receipt.status, 1); return { row: r.row, txHash: "0xtx", event: EVENTS[r.row.bucket] }; } };
  return { plan, sent, logs, io };
}

test("packet manifest pins exact IDs, order and scope; no target discovery", () => {
  validateManifest(manifest);
  assert.equal(manifest.rows.length, 29);
  assert.deepEqual(manifest.rows.reduce((r, v) => ({ ...r, [v.bucket]: (r[v.bucket] ?? 0) + 1 }), {}), { A: 3, B: 18, "B'": 1, C: 1, D: 6 });
  assert.equal(manifest.rescueJobIds.length, 7);
  assert.deepEqual(manifest.rescueJobIds.slice(1), manifest.rows.filter(r => r.bucket === "D").map(r => r.jobId));
  assert.equal(hash(manifest), "77554763ce10b4b8e34b783f7fdf2691d71d2e201c548fc94969acab15e1aee4");
  for (const prefix of Object.keys(DENYLIST)) {
    const denied = `${prefix}${"0".repeat(66 - prefix.length)}`;
    assert.throws(() => validateManifest({ ...manifest, rows: [{ ...row("A"), jobId: denied }] }), /Denied/);
    assert.throws(() => assertAllowedId(denied), /Denied/);
  }
  for (const patch of [{ function: "autoResolveOnTimeout" }, { escrow: "CreditBook" }, { escrow: "base" }]) {
    assert.throws(() => validateManifest({ ...manifest, rows: [{ ...row("A"), ...patch }] }), /outside cleanup scope/);
  }
  assert.throws(() => validateManifest({ ...manifest, rows: [{ ...row("C"), strategy: "OTHER_POOL" }] }), /outside cleanup scope/);
});

for (const bucket of ["A", "B", "B'", "D"]) {
  test(`${bucket}: every job state is classified, unknown/disputed/submitted never sent`, () => {
    for (let state = 0; state <= 8; state++) {
      const expected = bucket === "A" ? (state === 1 ? "ready" : state === 7 ? "already_done" : "blocked")
        : bucket === "D" ? ([1, 4, 6, 7].includes(state) ? "already_done" : "blocked")
          : state === 4 ? "ready" : state === 6 ? "already_done" : "blocked";
      assert.equal(classify(row(bucket), snapshot(bucket, { job: { state } })).status, expected, `${bucket} state ${state}`);
    }
    assert.equal(classify(row(bucket), snapshot(bucket, { paused: true })).reason, "paused");
    assert.equal(classify(row(bucket), snapshot(bucket, { bindingsValid: false })).reason, "contract_or_asset_mismatch");
    assert.equal(classify(row(bucket), snapshot(bucket, { job: { poster: `0x${"3".repeat(40)}` } })).reason, "poster_mismatch");
  });
}
test("windows, delisting and contract bindings fail closed", () => {
  assert.equal(classify(row("A"), snapshot("A", { createdAt: now })).reason, "open_floor_active");
  for (const bucket of ["B", "B'"]) assert.equal(classify(row(bucket), snapshot(bucket, { job: { rejectedAt: now - 604800 } })).reason, "dispute_window_active");
  assert.equal(classify(row("D"), snapshot("D", { job: { claimExpiry: now } })).reason, "claim_not_expired");
  assert.equal(classify(row("A"), snapshot("A", { retired: false })).reason, "persisted_catalogue_retirement_required");
  for (const retired of [true, false]) assert.equal(classify(row("D"), snapshot("D", { retired })).reason, "same_session_rescue_required");
  assert.equal(retirementFor([{ schemaVersion: 1, jobId: "legacy", lifecycle: { status: "archived" } }], id("legacy")), true);
  assert.equal(retirementFor([{ schemaVersion: 1, jobId: "legacy", lifecycle: { status: "open" } }], id("legacy")), false);
});
test("C full value from shares, rounding and buffer; zero shares is done; inactive/async/bad binding refused", () => {
  const c = ready("C"); assert.equal(c.call.args[2], "370"); assert.equal(c.heldRaw, "370");
  assert.deepEqual(c.call.args.slice(0, 2), [ADDRESSES.signer, STRATEGY_ID]);
  for (const [patch, reason] of [[{ active: false }, "strategy_inactive"], [{ async: true }, "strategy_async"],
    [{ paused: true }, "paused"], [{ bindingsValid: false }, "strategy_binding_mismatch"], [{ buffer: 369 }, "buffer_short"],
    [{ totalShares: 0 }, "invalid_strategy_totals"], [{ totalAssets: 0 }, "invalid_strategy_totals"], [{ totalAssets: 1 }, "dust_has_no_withdrawable_value"]]) {
    assert.equal(classify(row("C"), snapshot("C", patch)).reason, reason);
  }
  assert.equal(classify(row("C"), snapshot("C", { shares: 0 })).status, "already_done");
});
test("refund totals separate cold AAC, bank AAC and slashes; D has no immediate refund", () => {
  const plan = buildPlan([ready("A"), ready("B"), ready("B'"), ready("C"), ready("D")], position);
  assert.deepEqual(plan.totals, { bankLiquidRaw: "800670", bankReservedRaw: "-800300", coldLiquidRaw: "400150" });
  assert.equal(ready("D").slashStakeRaw, "77"); assert.equal(ready("D").slashFeeRaw, "11");
});
test("changed pre-state changes hash, observation time alone does not; mismatched hash/confirmation refused", () => {
  const first = buildPlan([ready("B")], position);
  assert.notEqual(first.planHash, buildPlan([classify(row("B"), snapshot("B", { job: { claimFee: "12" } }))], position).planHash);
  assert.equal(first.planHash, buildPlan([classify(row("B"), snapshot("B", { now: now + 12 }))], position).planHash);
  assert.throws(() => assertCommit(first, { ...commitArgs(first), expectedPlanHash: "bad" }), /hash mismatch/);
  assert.throws(() => assertCommit(first, { ...commitArgs(first), confirm: "CLEANUP" }), /Confirmation/);
});
test("already-done row at send is skipped; fresh C shares determine send amount", async () => {
  const h = harness([ready("A"), ready("C")]);
  h.io.read = async r => classify(r, r.bucket === "A" ? snapshot("A", { job: { state: 7 } }) : snapshot("C", { shares: 40 }));
  await executePlan(h.plan, commitArgs(h.plan), h.io);
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0].args[2], "400");
  assert.equal(h.logs.find(l => l.type === "skipped").status, "already_done");
});
test("stop on first revert, failed receipt, or timed-out wait; report done and not done", async () => {
  for (const mode of ["revert", "receipt", "timeout"]) {
    const h = harness();
    h.io.send = async call => { h.sent.push(call); if (mode === "revert") throw new Error("reverted"); return { hash: "0xbroadcast", wait: async () => {
      if (mode === "timeout") throw new Error("wait timed out"); return { status: 0 };
    } }; };
    await assert.rejects(executePlan(h.plan, commitArgs(h.plan), h.io));
    assert.equal(h.sent.length, 1); assert.equal(h.logs.at(-1).notDone.length, 2); assert.equal(h.logs.at(-1).done.length, 0);
  }
});
test("second fresh commit is a no-op with every row already_done", async () => {
  const all = ["A", "B", "B'", "C", "D"].map(b => classify(row(b), snapshot(b, b === "C" ? { shares: 0 } : { job: { state: { A: 7, B: 6, "B'": 6, D: 1 }[b] } })));
  assert.ok(all.every(r => r.status === "already_done"));
  const h = harness(all); await executePlan(h.plan, commitArgs(h.plan), h.io); assert.equal(h.sent.length, 0);
});
test("commit pre-state drift, a newly short C buffer, and the stopped-window deadline prevent sends", async () => {
  const h = harness([ready("B"), ready("C")]);
  h.io.read = async r => classify(r, r.bucket === "B" ? snapshot("B", { job: { claimStake: "999" } }) : snapshot("C", { buffer: 0 }));
  const result = await executePlan(h.plan, commitArgs(h.plan), h.io);
  assert.equal(h.sent.length, 0); assert.equal(result.skipped.length, 2);
  const timed = harness(); let ticks = 0; timed.io.now = () => ticks++ === 0 ? 0 : 15 * 60_000;
  await assert.rejects(executePlan(timed.plan, commitArgs(timed.plan), timed.io), /budget_exhausted/);
  assert.equal(timed.sent.length, 0);
});
test("pending nonce refuses all sending; wrong profile and unconfirmed commit refuse", async () => {
  const tags = [];
  await assert.rejects(assertNonceIdle({ send: async (method, params) => { assert.equal(method, "eth_getTransactionCount"); tags.push(params[1]); return params[1] === "latest" ? "0x4" : "0x5"; } }), /signer_nonce_busy/);
  assert.deepEqual(tags, ["latest", "pending"]);
  const h = harness(); h.io.assertNonceIdle = async () => { throw new Error("signer_nonce_busy"); };
  await assert.rejects(executePlan(h.plan, commitArgs(h.plan), h.io), /nonce_busy/); assert.equal(h.sent.length, 0);
  assert.equal(parseArgs(["--profile", "mainnet"]).commit, false);
  assert.throws(() => parseArgs(["--profile", "testnet"]));
  assert.throws(() => parseArgs(["--profile", "mainnet", "--commit"]));
});
test("receipt must match expected event, contract and job", () => {
  const iface = new Interface(["event JobCancelled(bytes32 indexed jobId,address indexed poster,uint256 refundedRaw)"]);
  const r = ready("A"), encoded = iface.encodeEventLog(iface.getEvent("JobCancelled"), [r.row.jobId, ADDRESSES.signer, 400150]);
  const receipt = { status: 1, hash: "0xtx", blockNumber: 123, logs: [{ address: ADDRESSES.v3, ...encoded }] };
  assert.equal(receiptEvidence(receipt, r).event, "JobCancelled");
  assert.throws(() => receiptEvidence({ ...receipt, status: 0 }, r), /reverted/);
  assert.throws(() => receiptEvidence({ ...receipt, logs: [{ address: ADDRESSES.v2, ...encoded }] }, r), /expected/);
  assert.throws(() => receiptEvidence(receipt, { ...r, row: { ...r.row, jobId: id("other") } }), /expected/);
});
test("batch rescue combines every plan, refuses drift and stops on first failure", async () => {
  const ids = manifest.rescueJobIds.slice(0, 2), calls = [], plans = ids.map((jobId, n) => ({ planHash: `0x${String(n).repeat(64)}`, target: ADDRESSES.v2,
    expectedSigner: ADDRESSES.signer, snapshot: { job: { jobId, state: 1 }, paused: false, workerClaimCount: 0, waiverClaimCount: 10 }, tombstone: { hash: id("tombstone") } }));
  const args = rescueArgs(["--profile", "mainnet", "--escrow", "legacy", "--job-ids", ids.join(","), "--janitor", `0x${"1".repeat(40)}`]);
  const singleRun = async a => { calls.push(a); if (a.execute) throw new Error("reverted"); return plans[ids.indexOf(a.jobId)]; };
  const preview = await runRescueBatch(args, { singleRun, log: () => {} }); assert.equal(preview.planHash, rescueBatchHash(plans));
  assert.notEqual(preview.planHash, rescueBatchHash(plans.slice(0, 1)));
  await assert.rejects(runRescueBatch({ ...args, execute: true, useKms: true, expectedPlanHash: preview.planHash, confirm: `RESCUE ${preview.planHash}` }, { singleRun, log: () => {} }), /reverted/);
  assert.equal(calls.filter(c => c.execute).length, 1);
  plans[0].snapshot.waiverClaimCount = 1;
  await assert.rejects(runRescueBatch(args, { singleRun, log: () => {} }), /remaining waiver claim capacity/);
});

test("signer queue cannot displace pending production deploy; dry-run, restart layers and durable evidence", async () => {
  const workflow = YAML.load(await readFile(new URL(".github/workflows/hosted-signer-cleanup.yml", root), "utf8"));
  assert.equal(workflow.on.workflow_dispatch.inputs.commit.default, false);
  const deploy = YAML.load(await readFile(new URL(".github/workflows/deploy-production.yml", root), "utf8"));
  assert.equal(deploy.concurrency.group, "production");
  for (const name of ["hosted-signer-cleanup", "hosted-signer-liquidity-funding", "hosted-worker-canary", "hosted-dispute-verdict-proof", "hosted-external-schema-proof"]) {
    const w = YAML.load(await readFile(new URL(`.github/workflows/${name}.yml`, root), "utf8"));
    assert.equal(w.concurrency.group, "production-signer-5a6836", name); assert.notEqual(w.concurrency.group, deploy.concurrency.group);
    assert.equal(w.concurrency["cancel-in-progress"], false);
  }
  const restart = workflow.jobs.cleanup.steps.find(s => s.name.startsWith("Independently restart"));
  assert.match(restart.if, /always\(\).*inputs.commit/); assert.match(restart.run, /--recover/);
  assert.ok(workflow.jobs.cleanup.steps.some(s => s.if === "always()" && s.uses?.startsWith("actions/upload-artifact@")));
  const script = await readFile(new URL("./run-signer-cleanup-host.sh", import.meta.url), "utf8");
  assert.match(script, /averray-production-deploy.lock/); assert.match(script, /flock -n 9/);
  assert.match(script, /sleep 900/); assert.match(script, /timeout --foreground.*840s/);
  assert.match(script, /trap finish EXIT/); assert.match(script, /rewardBank.readable == true/);
  assert.match(script, /trap '' PIPE/); assert.match(script, /tee --output-error=warn-nopipe -a/);
  assert.match(script, /\(\n  exec 9>&-/);
  assert.match(script, /wait "\$timer"\n  restart\n  log/);
  assert.ok(workflow.jobs.cleanup.steps.some(s => s.if === "always()" && s.run?.includes("-host.log")));
  assert.doesNotMatch(script, /--remove-orphans|compose.*\bdown\b/);
});

async function hostFixture(t, mode = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "signer-cleanup-test-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const bin = path.join(dir, "bin"), app = path.join(dir, "app");
  await mkdir(bin); await mkdir(path.join(app, "scripts/ops"), { recursive: true }); await mkdir(path.join(app, "deployments")); await mkdir(path.join(dir, ".deploy-state"));
  await writeFile(path.join(app, "deployments/mainnet.json"), JSON.stringify({ verifier: ADDRESSES.signer }));
  const put = async (file, body) => { await writeFile(file, `#!/bin/bash\n${body}\n`); await chmod(file, 0o755); };
  await put(path.join(app, "scripts/ops/run-caddy-network-selection.sh"), `if [[ $1 == status ]]; then echo '{"consistent":true}'; else echo '{"network":"mainnet","composeFile":"fixture.yml","projectDirectory":"fixture","backendService":"mainnet-backend","backendContainer":"agent-mainnet-backend"}'; fi`);
  await put(path.join(bin, "sudo"), 'exec "$@"');
  await put(path.join(bin, "flock"), `exit ${mode.lockHeld ? 1 : 0}`);
  await put(path.join(bin, "curl"), `echo '{"rewardBank":{"readable":true}}'`);
  await put(path.join(bin, "docker"), `echo "$*" >> "$TEST_LOG"
if [[ "$*" == *"stop --timeout"* ]]; then touch "$STACK_ROOT/stopped"; fi
if [[ "$*" == *--nonce-check* ]]; then
  if [[ ${mode.busyPre ? 1 : 0} == 1 || ( ${mode.busyPost ? 1 : 0} == 1 && -f "$STACK_ROOT/stopped" ) ]]; then echo 'signer_nonce_busy latest=5 pending=6'; exit 1; fi
  echo '{"latest":"5","pending":"5"}'
fi
exit 0`);
  await put(path.join(bin, "timeout"), `if [[ "$*" == *--commit* ]]; then
echo commit-send >> "$TEST_LOG"
${mode.disconnect ? 'echo disconnect-now; /bin/sleep 0.3; for ((i=0;i<2000;i++)); do echo after-disconnect; done' : ''}
exit ${mode.sendExit ?? 0}; fi
shift; exec "$@"`);
  await put(path.join(bin, "date"), `if [[ "$1" == +%s ]]; then
if [[ -f "$STACK_ROOT/clock" ]]; then echo 121; else touch "$STACK_ROOT/clock"; echo 0; fi
else /bin/date "$@"; fi`);
  // Production uses GNU tee. macOS fixtures emulate its warn-nopipe contract.
  if (process.platform === "darwin") {
    await writeFile(path.join(bin, "tee"), `#!${process.execPath}\nconst fs = require('node:fs'); const file = process.argv.at(-1); process.stdout.on('error', () => {}); process.stdin.on('data', b => { fs.appendFileSync(file, b); process.stdout.write(b); });\n`);
    await chmod(path.join(bin, "tee"), 0o755);
  }
  // A real long sleep is killed by the watchdog's TERM handler after the main trap.
  const logFile = path.join(dir, "calls.log"); await writeFile(logFile, "");
  const hash = "a".repeat(64);
  return { dir, logFile, args: [new URL("./run-signer-cleanup-host.sh", import.meta.url).pathname],
    env: { ...process.env, PATH: `${bin}:/opt/homebrew/bin:/usr/bin:/bin`, STACK_ROOT: dir, TEST_LOG: logFile,
      DEPLOY_LOCK_FILE: path.join(dir, "lock"), CLEANUP_RUN_ID: "123-1", CLEANUP_COMMIT: mode.commit ? "1" : "0", CLEANUP_PLAN_HASH: hash, CLEANUP_CONFIRM: `CLEANUP ${hash.slice(0, 12)}` } };
}
test("host dry-run never stops, starts or invokes KMS", async t => {
  const h = await hostFixture(t); await exec("bash", h.args, { env: h.env });
  const calls = await readFile(h.logFile, "utf8"); assert.doesNotMatch(calls, /\bstop\b|\bstart\b|--use-kms|--commit/); assert.match(calls, /run --rm --no-deps/);
});
test("host refuses held deploy lock and leaves backend running", async t => {
  const h = await hostFixture(t, { commit: true, lockHeld: true });
  await assert.rejects(exec("bash", h.args, { env: h.env }), e => /lock held/.test(e.stdout));
  assert.equal(await readFile(h.logFile, "utf8"), "");
});
for (const sendExit of [1, 124]) test(`host restart runs after ${sendExit === 124 ? "timed out" : "failed"} send`, async t => {
  const h = await hostFixture(t, { commit: true, sendExit });
  await assert.rejects(exec("bash", h.args, { env: h.env, timeout: 5000 }), e => e.code === sendExit);
  const calls = await readFile(h.logFile, "utf8");
  assert.match(calls, /stop --timeout 30 mainnet-backend/); assert.match(calls, /start mainnet-backend/);
  assert.ok(calls.indexOf("rm -f signer-cleanup-123-1") < calls.indexOf("start mainnet-backend"));
});

test("host pre-stop nonce drain refuses busy signer without stop or marker", async t => {
  const h = await hostFixture(t, { commit: true, busyPre: true });
  await assert.rejects(exec("bash", h.args, { env: h.env, timeout: 5000 }), e => e.code === 1 && /did not drain/.test(e.stdout));
  assert.doesNotMatch(await readFile(h.logFile, "utf8"), /\bstop\b|\bstart\b|commit-send/);
  await assert.rejects(readFile(path.join(h.dir, ".deploy-state/signer-cleanup-123-1.stopped")), { code: "ENOENT" });
});
test("host post-stop nonce race restarts backend without sending", async t => {
  const h = await hostFixture(t, { commit: true, busyPost: true });
  await assert.rejects(exec("bash", h.args, { env: h.env, timeout: 5000 }), e => e.code === 1);
  const calls = await readFile(h.logFile, "utf8");
  assert.match(calls, /stop --timeout 30/); assert.match(calls, /start mainnet-backend/); assert.doesNotMatch(calls, /commit-send/);
  await assert.rejects(readFile(path.join(h.dir, ".deploy-state/signer-cleanup-123-1.stopped")), { code: "ENOENT" });
});
test("dropped SSH stdout cannot interrupt failed-send restart; evidence survives on host", async t => {
  const h = await hostFixture(t, { commit: true, disconnect: true, sendExit: 124 });
  const child = spawn("bash", h.args, { env: h.env, stdio: ["ignore", "pipe", "pipe"] });
  let closed = false;
  child.stdout.on("data", data => { if (data.toString().includes("disconnect-now")) { closed = true; child.stdout.destroy(); } });
  child.stderr.resume();
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  const result = await new Promise(resolve => child.on("close", (code, signal) => resolve({ code, signal })));
  clearTimeout(timer);
  assert.equal(closed, true); assert.deepEqual(result, { code: 124, signal: null });
  assert.match(await readFile(h.logFile, "utf8"), /start mainnet-backend/);
  const durable = await readFile(path.join(h.dir, ".deploy-state/signer-cleanup-123-1.log"), "utf8");
  assert.match(durable, /backend stopped/); assert.match(durable, /backend started/); assert.match(durable, /health HTTP 200/);
  await assert.rejects(readFile(path.join(h.dir, ".deploy-state/signer-cleanup-123-1.stopped")), { code: "ENOENT" });
});
test("denylist is rechecked at cleanup send after plan validation", async () => {
  for (const target of ["row", "call"]) {
    const fresh = structuredClone(ready("B")), h = harness([fresh]);
    const denied = `0x1ca6302b${"0".repeat(56)}`;
    h.io.assertNonceIdle = async () => { if (target === "row") fresh.row.jobId = denied; else fresh.call.args[0] = denied; };
    await assert.rejects(executePlan(h.plan, commitArgs(h.plan), h.io), /Denied/);
    assert.equal(h.sent.length, 0);
  }
});
test("rescue refuses post-validation denied metadata or encoded job ID at send", async () => {
  const iface = new Interface(["function finalizeRejectedJob(bytes32)"]), allowed = row("B").jobId, denied = `0xfd4fdf36${"0".repeat(56)}`;
  assertAllowedId(allowed);
  for (const [metadata, encoded] of [[denied, allowed], [allowed, denied]]) {
    let sends = 0;
    await assert.rejects(sendCall({ sendTransaction: async () => { sends++; } },
      { args: [metadata], data: iface.encodeFunctionData("finalizeRejectedJob", [encoded]) }, () => {}), /Denied/);
    assert.equal(sends, 0);
  }
});
test("deadline expires during nonce check: no send; expires during broadcast: no unbounded wait", async () => {
  for (const stage of ["nonce", "broadcast"]) {
    const h = harness(); let time = 0, waited = 0;
    h.io.now = () => time;
    h.io.assertNonceIdle = async () => { if (stage === "nonce") time = 14 * 60_000; };
    h.io.send = async call => { h.sent.push(call); time = 14 * 60_000; return { hash: "0xpending", nonce: 1, wait: async () => { waited++; return { status: 1 }; } }; };
    await assert.rejects(executePlan(h.plan, commitArgs(h.plan), h.io), /budget_exhausted/);
    assert.equal(h.sent.length, stage === "nonce" ? 0 : 1); assert.equal(waited, 0);
    if (stage === "broadcast") assert.equal(h.logs.find(l => l.type === "broadcast").txHash, "0xpending");
  }
});
test("fairness prints rejection event evidence and backend verdict, with actual slash destinations", async () => {
  const r = row("B"), job = snapshot("B", { job: { rejectingVerifier: ADDRESSES.signer, rejectedAt: 100 } }).job;
  const iface = new Interface(["event Verified(bytes32 indexed jobId,address indexed verifier,bool approved,bytes32 reasonCode,bytes32 reasoningHash)", "event JobRejected(bytes32 indexed jobId,bytes32 reasonCode)"]);
  const reason = id("footer_missing"), reasoningHash = id("reasoning"), queries = [];
  const logs = [iface.encodeEventLog(iface.getEvent("Verified"), [r.jobId, ADDRESSES.signer, false, reason, reasoningHash]),
    iface.encodeEventLog(iface.getEvent("JobRejected"), [r.jobId, reason])].map((l, index) => ({ ...l, index, address: ADDRESSES.v3, blockNumber: 10, transactionHash: id("tx") }));
  const provider = { getBlock: async number => ({ number, timestamp: number * 10 }),
    getTransactionReceipt: async () => ({ hash: id("tx"), blockNumber: 10, logs }),
    getLogs: async query => { queries.push(query); return logs; } };
  const evidence = await readRejectionEvidence(provider, r, job, { number: 20 }, async () => ({ sessionId: "session", verification: { reason: "footer missing", reasonCode: "footer_missing" } }));
  assert.equal(evidence.chain.status, "available"); assert.equal(evidence.backend.sessionId, "session"); assert.equal(evidence.backend.verdictReason, "footer missing");
  assert.deepEqual(queries[0], { address: ADDRESSES.v3, fromBlock: 10, toBlock: 10, topics: [[iface.getEvent("Verified").topicHash, iface.getEvent("JobRejected").topicHash], r.jobId] });
  assert.deepEqual(evidence.chain.events[0], { event: "Verified", reasonCode: reason, reasoningHash, verifier: ADDRESSES.signer,
    verifierSource: "event", block: 10, blockTime: "1970-01-01T00:01:40.000Z", logIndex: 0, transactionHash: id("tx") });
  const treasury = `0x${"7".repeat(40)}`, split = slashDistribution(r, job, treasury, 7000);
  assert.deepEqual(split.stake, { totalRaw: "77", posterWallet: job.poster, posterWalletRaw: "38", treasuryAccount: treasury, treasuryAacRaw: "39" });
  assert.deepEqual(split.fee, { totalRaw: "11", verifierWallet: ADDRESSES.signer, verifierWalletRaw: "7", treasuryAccount: treasury, treasuryAacRaw: "4" });
  assert.equal(slashDistribution(row("D"), job, treasury, 7000).fee.treasuryAacRaw, "11");
  const missing = await readRejectionEvidence({ ...provider, getLogs: async () => { throw new Error("RPC unavailable"); } }, r, job, { number: 20 });
  assert.equal(missing.chain.status, "unavailable"); assert.equal(missing.backend.status, "unavailable");
  const d = await readRejectionEvidence({}, row("D"), { ...job, rejectedAt: 0 }, { number: 20 });
  assert.equal(d.chain.reason, "no_current_rejection"); assert.deepEqual(d.chain.events, []);
});

test("chain reader binds per-row fairness and live slash policy into the reviewed plan", async () => {
  const policy = `0x${"5".repeat(40)}`, treasury = `0x${"7".repeat(40)}`;
  const iface = new Interface([...ESCROW_CORE_ABI, "function policy() view returns (address)",
    "function paused() view returns (bool)", "function treasuryAccount() view returns (address)",
    "function claimFeeVerifierBps() view returns (uint16)", "function DISPUTE_WINDOW() view returns (uint256)"]);
  const components = iface.getFunction("jobs").outputs[0].components;
  const fixture = snapshot("B", { job: { rejectingVerifier: ADDRESSES.signer } }).job;
  const job = Object.fromEntries(components.map(c => [c.name, fixture[c.name] ?? (c.type === "bool" ? false : c.type === "bytes32" ? id(c.name) : 0)]));
  const reads = [];
  const provider = { getBlock: async n => ({ number: n === "latest" ? 200000 : n, timestamp: n === "latest" ? now : n * 10 }),
    getLogs: async () => [], call: async tx => {
      const fn = iface.parseTransaction(tx).name; reads.push(fn);
      const values = { jobs: job, accounts: ADDRESSES.aac, policy, paused: false, treasuryAccount: treasury,
        claimFeeVerifierBps: 7000, DISPUTE_WINDOW: 604800 };
      assert.ok(fn in values, fn); return iface.encodeFunctionResult(fn, [values[fn]]);
    } };
  const reader = await createReader(provider, { contracts: { treasuryPolicy: policy }, deploymentBlocks: { escrowCore: 1 } },
    { readSession: async () => ({ sessionId: "session", verification: { reasonCode: "REJECTED" } }) });
  const result = await reader.read(row("B"));
  assert.equal(result.fairness.backend.sessionId, "session"); assert.equal(result.fairness.backend.verdictReasonCode, "REJECTED");
  assert.equal(result.fairness.chain.status, "incomplete");
  assert.equal(result.fairness.slashes.fee.verifierWalletRaw, "7"); assert.equal(result.fairness.slashes.stake.treasuryAccount, treasury);
  const { phantomLogsDropped, ...canonicalFairness } = result.fairness;
  assert.equal(phantomLogsDropped, 0);
  assert.deepEqual(result.preState.fairness, canonicalFairness);
  assert.ok(reads.includes("claimFeeVerifierBps")); assert.ok(reads.includes("treasuryAccount"));
});

test("phantom and duplicate rejection logs cannot change the reviewed plan or send-time pre-state", async () => {
  const r = manifest.rows.find(r => r.jobId?.startsWith("0x3aacf564"));
  const tx = "0x6219133188f307f431c708eb0b70e8c8461e5b5ffd426c647f8ce9be86ae0f4a";
  const receiptBlock = 19347505, phantomBlock = 19347500, blockHash = id("receipt block");
  const iface = new Interface(ESCROW_CORE_ABI);
  const s = snapshot("B", { job: { rejectingVerifier: ADDRESSES.signer } });
  const logs = [iface.encodeEventLog(iface.getEvent("Verified"), [r.jobId, ADDRESSES.signer, false, id("reason"), id("reasoning")]),
    iface.encodeEventLog(iface.getEvent("JobRejected"), [r.jobId, id("reason")])]
    .map((l, i) => ({ ...l, address: ADDRESSES.v2, transactionHash: tx, index: 45 + i, blockNumber: receiptBlock, blockHash }));
  const phantom = logs.map(l => ({ ...l, blockNumber: phantomBlock, blockHash: id("phantom block") }));
  let noise = false, receiptReads = 0;
  const provider = {
    getBlock: async tag => {
      const number = tag === blockHash ? receiptBlock : tag;
      return { number, hash: number === receiptBlock ? blockHash : id(String(number)),
        timestamp: number < phantomBlock ? 99 : number <= receiptBlock ? 100 : 101 };
    },
    getTransactionReceipt: async hash => { assert.equal(hash, tx); receiptReads++; return { hash: tx, blockNumber: receiptBlock, blockHash, logs }; },
    getLogs: async () => noise ? [phantom[1], logs[1], logs[0], phantom[0], logs[0]] : logs
  };
  const read = async () => classify(r, { ...s, fairness: await readRejectionEvidence(provider, r, s.job,
    { number: receiptBlock + 10 }, undefined, phantomBlock - 10) });
  const clean = await read(); noise = true; const noisy = await read();
  assert.equal(receiptReads, 2, "one receipt read per transaction per observation");
  assert.equal(clean.phantomLogsDropped, 0); assert.equal(noisy.phantomLogsDropped, 2);
  assert.deepEqual(noisy.fairness.chain.events.map(e => [e.block, e.logIndex, e.blockTime]),
    [[receiptBlock, 45, "1970-01-01T00:01:40.000Z"], [receiptBlock, 46, "1970-01-01T00:01:40.000Z"]]);
  assert.deepEqual(noisy.preState.job, s.job, "job chain state remains fully bound");
  assert.equal(buildPlan([clean], position).planHash, buildPlan([noisy], position).planHash);
  const h = harness([clean]); h.io.read = async () => noisy;
  await executePlan(h.plan, commitArgs(h.plan), h.io);
  assert.equal(h.sent.length, 1, "RPC noise must not skip a reviewed ready row");
  const changed = structuredClone(noisy); changed.preState.job.claimStake = "999";
  assert.notEqual(h.plan.planHash, buildPlan([changed], position).planHash);
});
