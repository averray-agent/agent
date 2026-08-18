#!/usr/bin/env node
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { GitPatchTestsRunner } from "../../mcp-server/src/services/git-patch-tests-runner.js";

const queueRoot = resolve(process.env.WITNESS_VERIFY_QUEUE_ROOT ?? "");
if (!process.env.WITNESS_VERIFY_QUEUE_ROOT) {
  throw new Error("WITNESS_VERIFY_QUEUE_ROOT is required.");
}
const runner = new GitPatchTestsRunner();
await Promise.all(["inbox", "processing", "requests", "results"].map((name) =>
  mkdir(resolve(queueRoot, name), { recursive: true, mode: 0o700 })
));
await runner.initialize();

async function heartbeat() {
  const path = resolve(queueRoot, "worker-heartbeat.json");
  const staged = `${path}.tmp`;
  await writeFile(staged, JSON.stringify({
    worker: "averray-witness-git-patch-tests-v1",
    pid: process.pid,
    at: new Date().toISOString()
  }), { mode: 0o600 });
  await rename(staged, path);
}

async function processOne(name, { alreadyClaimed = false } = {}) {
  if (!/^verify_[a-f0-9]{64}\.json$/u.test(name)) return;
  const queued = resolve(queueRoot, "inbox", name);
  const claimed = resolve(queueRoot, "processing", name);
  if (!alreadyClaimed) {
    try {
      await rename(queued, claimed);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
  }
  let task;
  let result;
  try {
    task = JSON.parse(await readFile(claimed, "utf8"));
    if (`${task.runId}.json` !== name) throw new Error("Queue filename/runId mismatch.");
    result = await runner.run({
      runId: task.runId,
      profile: task.profile,
      target: task.target,
      inputs: task.inputs,
      artifactBaseDirectory: task.requestDirectory
    });
  } catch (error) {
    result = {
      status: "inconclusive",
      reason: "runner_fault",
      reasonCode: "RUNNER_FAULT",
      detail: error?.message ?? "The offline Witness worker failed."
    };
  }
  const destination = resolve(queueRoot, "results", name);
  const staged = `${destination}.tmp`;
  await writeFile(staged, JSON.stringify(result), { mode: 0o600 });
  await rename(staged, destination);
  await rm(claimed, { force: true });
}

await heartbeat();
setInterval(() => void heartbeat(), 5_000).unref();
while (true) {
  // A host-worker restart may leave a claimed deterministic task behind.
  // Resume it before taking new work; rerunning the same pinned contract is
  // safe and prevents a process death from silently discarding a request.
  const claimedNames = await readdir(resolve(queueRoot, "processing"));
  for (const name of claimedNames.sort()) await processOne(name, { alreadyClaimed: true });
  const names = await readdir(resolve(queueRoot, "inbox"));
  for (const name of names.sort()) await processOne(name);
  await new Promise((next) => setTimeout(next, 250));
}
