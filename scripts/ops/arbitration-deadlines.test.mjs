import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { planReminders, runReminders, reminderMain, stateKey } from "./arbitration-deadlines.mjs";
import { arbitrationPushText, SIGN_ALL_LIVE } from "./arbitration-push-text.mjs";

const start = Date.parse("2026-01-05T12:00:00Z") / 1000;
const job = { jobId: `0x${"11".repeat(32)}`, escrow: `0x${"22".repeat(20)}`, disputedAt: start, sla: 1209600 };
const chain = (jobs = [job], extra = {}) => ({ jobs, closed: [], unknown: false, parityWarnings: [], failureCount: 0, ...extra });
const capture = () => { const pushes = []; return { pushes, deliver: async (push) => pushes.push(push) }; };

test("arbitration reminders send the first observation once", async () => {
  const c = capture();
  const now = start + 300;
  const result = await runReminders({ chain: chain(), now, ...c });
  assert.equal(c.pushes.length, 1);
  assert.equal(c.pushes[0].priority, 3);
  assert.equal(planReminders({ chain: chain(), now }).due[0].tier.name, "opened");
  assert.equal(result.state[stateKey(job)].tier, "opened");
  await runReminders({ chain: chain(), now: now + 300, state: result.state, ...c });
  assert.equal(c.pushes.length, 1);
});
test("arbitration reminders send the final day observation", async () => {
  const c = capture();
  const result = await runReminders({ chain: chain(), now: start + 13 * 86400 + 3600, ...c });
  assert.equal(result.state[stateKey(job)].tier, "sla_1d");
  assert.equal(c.pushes[0].priority, 5);
});
test("arbitration reminders catch up only the latest observation", async () => {
  const c = capture();
  const now = start + 12 * 86400;
  const result = await runReminders({ chain: chain(), now, ...c });
  assert.equal(result.state[stateKey(job)].tier, "sla_3d");
  assert.equal(c.pushes.length, 1);
  assert.equal(planReminders({ chain: chain(), now }).due.length, 1);
  assert.equal((c.pushes[0].body.match(/Job /g) ?? []).length, 1);
  await runReminders({ chain: chain(), now, state: result.state, ...c });
  assert.equal(c.pushes.length, 1);
});
test("arbitration reminders remove confirmed closed entries without delivery", async () => {
  const c = capture();
  const result = await runReminders({ chain: chain([], { closed: [job] }), now: start,
    state: { [stateKey(job)]: { tier: "opened", sentAt: new Date(start * 1000).toISOString() } }, ...c });
  assert.deepEqual(result.state, {});
  assert.equal(c.pushes.length, 0);
});
test("arbitration reminders aggregate all new observations at their highest priority", async () => {
  const c = capture();
  const recent = { ...job, jobId: `0x${"33".repeat(32)}`, disputedAt: start + 13 * 86400 };
  const result = await runReminders({ chain: chain([job, recent]), now: start + 13 * 86400 + 300, ...c });
  assert.equal(c.pushes.length, 1);
  assert.equal(c.pushes[0].priority, 5);
  assert.equal(Object.keys(result.state).length, 2);
});
test("arbitration reminders report unknown chain status at any hour", async () => {
  const c = capture();
  const result = await runReminders({ chain: chain([], { unknown: true, failureCount: 2 }), now: start - 10 * 3600, ...c });
  assert.equal(c.pushes.length, 1);
  assert.equal(c.pushes[0].priority, 5);
  assert.match(c.pushes[0].body, /Deadline status unknown: chain read failed/);
  assert.equal(result.failed, true);
});
test("arbitration reminders apply quiet hours only to standard observations", async () => {
  const night = Date.parse("2026-01-13T01:00:00Z") / 1000;
  const standard = { ...job, disputedAt: night - 7 * 86400 };
  assert.equal(planReminders({ chain: chain([standard]), now: night }).send, false);
  const morning = night + 6 * 3600;
  assert.equal(planReminders({ chain: chain([standard]), now: morning }).send, true);
  const urgent = { ...job, disputedAt: night - 13 * 86400 };
  assert.equal(planReminders({ chain: chain([urgent]), now: night }).priority, 5);
  assert.equal(planReminders({ chain: chain([urgent]), now: night }).send, true);
});
test("arbitration reminders send one daily digest when no other notification was sent", async () => {
  const c = capture();
  const now = start + 86400;
  const state = { [stateKey(job)]: { tier: "opened", sentAt: new Date(start * 1000).toISOString() } };
  const result = await runReminders({ chain: chain(), state, now, ...c });
  assert.equal(c.pushes.length, 1);
  assert.equal(c.pushes[0].priority, 2);
  await runReminders({ chain: chain(), state: result.state, now: now + 3600, ...c });
  assert.equal(c.pushes.length, 1);
});
test("arbitration reminders preserve delivery state on a failed push", async () => {
  const state = {};
  await assert.rejects(runReminders({ chain: chain(), state, now: start,
    deliver: async () => { throw new Error("delivery unavailable"); } }));
  assert.deepEqual(state, {});
});
test("arbitration reminder state contains only hashed keys and delivery observations", async () => {
  const result = await runReminders({ chain: chain(), now: start, ...capture() });
  const [key] = Object.keys(result.state);
  assert.match(key, /^[\da-f]{64}$/);
  assert.deepEqual(Object.keys(result.state[key]).sort(), ["sentAt", "tier"]);
  assert.ok(!JSON.stringify(result.state).includes(job.jobId));
});
test("arbitration reminder drills leave the state artifact unchanged", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "arbitration-reminder-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "state.json");
  const original = JSON.stringify({ [stateKey(job)]: { tier: "sla_1d", sentAt: new Date(start * 1000).toISOString() } });
  await writeFile(file, original);
  const c = capture();
  const output = [];
  const code = await reminderMain(["--drill", "--simulate-now", new Date(start * 1000).toISOString(), "--state-file", file],
    { loadChain: async () => chain(), deliver: c.deliver, output: (line) => output.push(line) });
  assert.equal(code, 0);
  assert.equal(await readFile(file, "utf8"), original);
  assert.match(c.pushes[0].body, /\[DRILL\]/);
  assert.deepEqual(output, ["reminder check: pass; open=1; notifications=1"]);
  assert.ok(!output.join().includes(job.jobId));
});
test("arbitration reminder phone text reflects the current signing path", () => {
  for (const now of [start, start + 15 * 86400]) {
    const body = arbitrationPushText({ jobs: [job], now });
    assert.ok(body.startsWith("On your Mac:"));
    assert.doesNotMatch(body, /autoResolveOnTimeout|ready|signed/i);
    assert.equal(body.includes("Rulings to sign"), SIGN_ALL_LIVE);
    assert.match(body, /Europe\/Zurich/);
    assert.ok(body.endsWith("A push is a pointer; check the app."));
  }
});
test("arbitration reminders point to the operator overview", async () => {
  const c = capture();
  await runReminders({ chain: chain(), now: start, ...c });
  assert.equal(c.pushes[0].click, "https://app.averray.com/overview");
});
