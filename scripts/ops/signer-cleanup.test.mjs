import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Interface, id } from "ethers";
import YAML from "js-yaml";
import { ADDRESSES, COLD_POSTER, DENYLIST, STRATEGY_ID, EVENTS, assertAllowedId, assertCommit, assertNonceIdle,
  buildPlan, classify, executePlan, hash, parseArgs, receiptEvidence, retirementFor, validateManifest } from "./signer-cleanup.mjs";
import { parseArgs as rescueArgs, runRescueBatch, rescueBatchHash } from "./rescue-open-job.mjs";

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
        : bucket === "D" ? (state === 2 ? "ready" : [1, 4, 6, 7].includes(state) ? "already_done" : "blocked")
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
  for (const bucket of ["A", "D"]) assert.equal(classify(row(bucket), snapshot(bucket, { retired: false })).reason, "persisted_catalogue_retirement_required");
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

test("workflow serializes signer/deploy jobs, default dry-run, two restart layers, evidence always", async () => {
  const workflow = YAML.load(await readFile(new URL(".github/workflows/hosted-signer-cleanup.yml", root), "utf8"));
  assert.equal(workflow.on.workflow_dispatch.inputs.commit.default, false);
  for (const name of ["deploy-production", "hosted-signer-cleanup", "hosted-signer-liquidity-funding", "hosted-worker-canary", "hosted-dispute-verdict-proof", "hosted-external-schema-proof"]) {
    const w = YAML.load(await readFile(new URL(`.github/workflows/${name}.yml`, root), "utf8"));
    assert.equal(w.concurrency.group, "production", name); assert.equal(w.concurrency["cancel-in-progress"], false);
  }
  const restart = workflow.jobs.cleanup.steps.find(s => s.name.startsWith("Independently restart"));
  assert.match(restart.if, /always\(\).*inputs.commit/); assert.match(restart.run, /--recover/);
  assert.ok(workflow.jobs.cleanup.steps.some(s => s.if === "always()" && s.uses?.startsWith("actions/upload-artifact@")));
  const script = await readFile(new URL("./run-signer-cleanup-host.sh", import.meta.url), "utf8");
  assert.match(script, /averray-production-deploy.lock/); assert.match(script, /flock -n 9/);
  assert.match(script, /sleep 900/); assert.match(script, /timeout --foreground.*840s/);
  assert.match(script, /trap finish EXIT/); assert.match(script, /rewardBank.readable == true/);
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
  await put(path.join(bin, "docker"), `echo "$*" >> "$TEST_LOG"\nif [[ "$*" == *--nonce-check* ]]; then echo '{"latest":"5","pending":"5"}'; fi\nexit 0`);
  await put(path.join(bin, "timeout"), `if [[ "$*" == *--commit* ]]; then exit ${mode.sendExit ?? 0}; fi\nshift; exec "$@"`);
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
