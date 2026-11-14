import { createHash } from "node:crypto";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { arbitrationPushText } from "./arbitration-push-text.mjs";
import { readArbitrationChain } from "./escrow-chain-lib.mjs";

export const TIERS = [
  { name: "opened", after: 0, priority: 3, quiet: true },
  { name: "target", after: 3 * 86400, priority: 3, quiet: true },
  { name: "sla_7d", after: 7 * 86400, priority: 3, quiet: true },
  { name: "sla_3d", after: 11 * 86400, priority: 4, quiet: false },
  { name: "sla_1d", after: 13 * 86400, priority: 5, quiet: false },
  { name: "sla_lapsed", after: 14 * 86400, priority: 5, quiet: false },
];
export const stateKey = ({ escrow, jobId }) => createHash("sha256").update(`${escrow.toLowerCase()}:${jobId.toLowerCase()}`).digest("hex");
const localDate = (now) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Zurich" }).format(new Date(now * 1000));
export function insideDeliveryWindow(now) {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Zurich", hour: "2-digit", hourCycle: "h23" }).format(new Date(now * 1000)));
  return hour >= 8 && hour < 21;
}

export function planReminders({ chain, state = {}, now, drill = false }) {
  const nextState = drill ? {} : structuredClone(state);
  for (const job of chain.closed) delete nextState[stateKey(job)];
  const due = [];
  for (const job of chain.jobs) {
    const tier = TIERS.findLast((candidate) => now >= job.disputedAt + candidate.after);
    if (!tier || (tier.quiet && !insideDeliveryWindow(now))) continue;
    const previous = nextState[stateKey(job)];
    if (previous && TIERS.findIndex(({ name }) => name === previous.tier) >= TIERS.indexOf(tier)) continue;
    due.push({ ...job, tier });
  }
  const todaySent = Object.values(nextState).some(({ sentAt }) => localDate(Date.parse(sentAt) / 1000) === localDate(now));
  const digest = !chain.unknown && !due.length && chain.jobs.length > 0 && !todaySent && insideDeliveryWindow(now);
  const send = chain.unknown || due.length > 0 || digest;
  return { nextState, due, digest, send,
    priority: chain.unknown ? 5 : digest ? 2 : Math.max(0, ...due.map(({ tier }) => tier.priority)) };
}

export async function deliverPhonePush({ body, priority, click }) {
  await new Promise((resolve, reject) => {
    const child = spawn("bash", [fileURLToPath(new URL("./phone-push.sh", import.meta.url)),
      "Averray arbitration", String(priority), "warning", click], { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => reject(new Error("phone_delivery_failed")));
    child.on("close", (code) => code === 0 ? resolve() : reject(new Error("phone_delivery_failed")));
    child.stdin.on("error", () => {});
    child.stdin.end(body);
  });
}

export async function runReminders({ chain, state = {}, now, drill = false, runUrl = "", deliver = deliverPhonePush }) {
  const plan = planReminders({ chain, state, now, drill });
  if (plan.send) {
    await deliver({ priority: plan.priority, click: "https://app.averray.com/overview", body: arbitrationPushText({
      jobs: plan.digest ? chain.jobs : plan.due, now, unknown: chain.unknown,
      digest: plan.digest, parityWarnings: chain.parityWarnings, drill, runUrl,
    }) });
    if (!drill) for (const job of plan.digest ? chain.jobs : plan.due) {
      plan.nextState[stateKey(job)] = { tier: plan.digest ? (plan.nextState[stateKey(job)]?.tier ?? "opened") : job.tier.name,
        sentAt: new Date(now * 1000).toISOString() };
    }
  }
  return { state: drill ? state : plan.nextState, sent: Number(plan.send), failed: chain.failureCount > 0 };
}

export async function reminderMain(args = process.argv.slice(2), { loadChain = readArbitrationChain,
  deliver = deliverPhonePush, output = console.log } = {}) {
  const value = (flag) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  const drill = args.includes("--drill");
  const simulated = value("--simulate-now");
  if (simulated && !drill) throw new Error("simulation_requires_drill");
  const now = Math.floor((simulated ? Date.parse(simulated) : Date.now()) / 1000);
  if (!Number.isSafeInteger(now)) throw new Error("clock_invalid");
  const stateFile = value("--state-file");
  let state = {};
  if (!drill && stateFile) {
    try { state = JSON.parse(await readFile(stateFile, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw new Error("reminder_state_invalid"); }
    for (const [key, entry] of Object.entries(state)) {
      if (!/^[\da-f]{64}$/.test(key) || !TIERS.some(({ name }) => name === entry.tier)
        || !Number.isFinite(Date.parse(entry.sentAt))) throw new Error("reminder_state_invalid");
    }
  }
  const manifest = JSON.parse(await readFile(new URL("../../deployments/mainnet.json", import.meta.url), "utf8"));
  const chain = await loadChain(manifest);
  const result = await runReminders({ chain, state, now, drill, runUrl: value("--run-url"), deliver });
  if (!drill && stateFile) {
    await mkdir(dirname(stateFile), { recursive: true });
    await writeFile(`${stateFile}.tmp`, JSON.stringify(result.state), { mode: 0o600 });
    await rename(`${stateFile}.tmp`, stateFile);
  }
  output(`reminder check: ${result.failed ? "fail" : "pass"}; open=${chain.jobs.length}; notifications=${result.sent}`);
  return result.failed ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  reminderMain().then((code) => { process.exitCode = code; }).catch(() => {
    console.error("reminder check: fail");
    process.exitCode = 1;
  });
}
