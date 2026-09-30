import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { RedisStateStore, MemoryStateStore, createStateStore, waitForStateStoreAtBoot } from "./state-store.js";
import { MetricRegistry } from "./metrics.js";
import { resolveServiceHealth } from "./health-capability.js";

function parseCommand(buffer) {
  const headerEnd = buffer.indexOf("\r\n");
  if (headerEnd < 0) return;
  assert.equal(buffer[0], "*");
  const count = Number(buffer.slice(1, headerEnd));
  const args = [];
  let cursor = headerEnd + 2;
  for (let index = 0; index < count; index++) {
    const end = buffer.indexOf("\r\n", cursor);
    if (end < 0) return;
    assert.equal(buffer[cursor], "$");
    const size = Number(buffer.slice(cursor + 1, end));
    if (buffer.length < end + 2 + size + 2) return;
    args.push(buffer.slice(end + 2, end + 2 + size));
    cursor = end + 2 + size + 2;
  }
  return { args, consumed: cursor };
}

async function respServer(t) {
  const sockets = new Set();
  let reply = true;
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
    let buffer = "";
    socket.on("data", (bytes) => {
      buffer += bytes.toString();
      let command;
      while ((command = parseCommand(buffer))) {
        buffer = buffer.slice(command.consumed);
        if (!reply) continue;
        const name = command.args[0].toUpperCase();
        socket.write(name === "PING" ? "+PONG\r\n" : ["GET", "HGET"].includes(name) ? "$-1\r\n" : "+OK\r\n");
      }
    });
  });
  const listen = (port) => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  await listen(0);
  const port = server.address().port;
  const drop = () => { for (const socket of sockets) socket.destroy(); };
  const stop = async () => {
    drop();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  };
  t.after(stop);
  return { port, url: `redis://user:s3cret@127.0.0.1:${port}`, drop, stop,
    start: () => listen(port), silence: () => { reply = false; }, resume: () => { reply = true; } };
}

async function eventually(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("readiness deadline reached");
    await delay(20);
  }
}

function makeStore(t, fixture, options = {}) {
  const logs = [];
  const logger = Object.fromEntries(["warn", "info", "error"].map((level) => [level, (...args) => logs.push({ level, args })]));
  const metrics = new MetricRegistry();
  const store = new RedisStateStore(fixture.url, "synthetic", { logger, metrics, ...options });
  t.after(() => { if (store.client.isOpen) store.client.destroy(); });
  return { store, logs, metrics };
}

test("Redis client keeps its process running across socket reconnects", { timeout: 15_000 }, async (t) => {
  const server = await respServer(t);
  const root = await mkdtemp(join(tmpdir(), "redis-resilience-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, "client.mjs");
  await writeFile(script, `import { RedisStateStore } from ${JSON.stringify(new URL("./state-store.js", import.meta.url).href)};
const logger = Object.fromEntries(["info","warn","error"].map(level => [level, (...args) => process.send({kind:"log",args})]));
const store = new RedisStateStore(process.argv[2], "synthetic", {logger});
process.on("message", async message => {
  if(message === "read") {
    try { await store.getSession("synthetic-session"); process.send({kind:"read",ok:true}); }
    catch { process.send({kind:"read",ok:false}); }
  }
});
await store.getSession("synthetic-session");
process.send({kind:"started"});
`);
  const child = fork(script, [server.url], { execPath: process.execPath, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const logs = [];
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("message", (message) => { if (message.kind === "log") logs.push(message.args); });
  const message = (kind) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("child response deadline reached")), 6000);
    const exit = (code) => finish(new Error(`client exited ${code}`));
    const receive = (value) => { if (value.kind === kind) finish(null, value); };
    function finish(error, value) {
      clearTimeout(timer); child.off("exit", exit); child.off("message", receive);
      error ? reject(error) : resolve(value);
    }
    child.on("exit", exit); child.on("message", receive);
  });
  await message("started");
  await server.stop();
  await delay(2000);
  assert.equal(child.exitCode, null, "client stays alive during reconnects");
  await server.start();
  await eventually(() => logs.filter((args) => args[1] === "state_store.redis_ready").length >= 2);
  const read = message("read");
  child.send("read");
  assert.equal((await read).ok, true);
  assert.doesNotMatch(JSON.stringify(logs) + stderr, /s3cret/);
});

test("Redis client retries after an initial connection deadline", { timeout: 10_000 }, async (t) => {
  const server = await respServer(t);
  await server.stop();
  const { store } = makeStore(t, server);
  const started = Date.now();
  await assert.rejects(store.getSession("synthetic-session"), { code: "state_store_unavailable" });
  assert.ok(Date.now() - started < 1000);
  await server.start();
  await eventually(() => store.client.isReady);
  assert.equal(await store.getSession("synthetic-session"), undefined);
});

test("Redis health probe answers within its deadline when replies pause", { timeout: 5000 }, async (t) => {
  const server = await respServer(t);
  const { store } = makeStore(t, server);
  await store.connect();
  server.silence();
  const started = Date.now();
  const result = await store.healthCheck();
  assert.ok(Date.now() - started < 2000);
  assert.deepEqual(result, { ok: false, backend: "redis", mode: "durable", reason: "redis_timeout" });
});

test("Redis session reads fail promptly during reconnects without an offline queue", { timeout: 5000 }, async (t) => {
  const server = await respServer(t);
  const { store } = makeStore(t, server);
  await store.connect();
  await server.stop();
  await eventually(() => !store.client.isReady);
  const started = Date.now();
  await assert.rejects(store.getSession("synthetic-session"), { code: "state_store_unavailable" });
  assert.ok(Date.now() - started < 1000);
  assert.equal(store.client.options.disableOfflineQueue, true);
  await Promise.race([
    assert.rejects(store.client.get("synthetic-session")),
    delay(900).then(() => assert.fail("disconnected commands must fail promptly"))
  ]);
});

test("Redis error logs redact credentials and throttle each code while metrics count every error", async (t) => {
  const server = await respServer(t);
  const { store, logs, metrics } = makeStore(t, server);
  await store.connect();
  const error = Object.assign(new Error(`Connection ${server.url} user s3cret`), { code: "ECONNREFUSED" });
  store.client.emit("error", error);
  store.client.emit("error", error);
  assert.equal(logs.filter(({ level }) => level === "warn").length, 1);
  assert.doesNotMatch(JSON.stringify(logs), /s3cret|redis:\/\//);
  assert.match(metrics.serialize(), /state_store_redis_errors_total\{code="ECONNREFUSED"\} 2/);
  assert.match(metrics.serialize(), /state_store_redis_ready 1/);
  await server.stop();
  await eventually(() => !store.client.isReady);
  assert.match(metrics.serialize(), /state_store_redis_ready 0/);
  await eventually(() => /state_store_redis_reconnects_total [1-9]/.test(metrics.serialize()));
  assert.match(metrics.serialize(), /state_store_redis_reconnects_total [1-9]/);
});

test("Redis health failure maps to service unavailability", async (t) => {
  const server = await respServer(t);
  await server.stop();
  const { store } = makeStore(t, server);
  const health = await store.healthCheck();
  const result = resolveServiceHealth({ stateStoreHealth: health, authConfig: { mode: "permissive" } });
  assert.equal(result.ok, false);
  assert.equal(result.components.stateStore.ok, false);
});

test("Redis startup wait retries within its budget and reports exhaustion once", async () => {
  const logs = [];
  const logger = Object.fromEntries(["warn", "error"].map((level) => [level, (...args) => logs.push(args)]));
  let now = 0, calls = 0;
  const store = { connect: async () => { if (++calls < 3) throw new Error("not ready"); } };
  await waitForStateStoreAtBoot(store, { logger, now: () => now, sleep: async (ms) => { now += ms; } });
  assert.equal(calls, 3);
  assert.equal(logs.length, 2);
  logs.length = 0;
  now = 0;
  await assert.rejects(waitForStateStoreAtBoot({ connect: async () => { throw new Error("not ready"); } },
    { logger, timeoutMs: 1000, now: () => now, sleep: async (ms) => { now += ms; } }), { code: "state_store_unavailable" });
  assert.equal(now, 1000);
  assert.equal(logs.filter((args) => args[1] === "state_store.redis_unreachable_at_boot").length, 1);
  await waitForStateStoreAtBoot(new MemoryStateStore());
});

test("Redis factory carries the runtime logger and metrics", async (t) => {
  const server = await respServer(t);
  const logs = [];
  const metrics = new MetricRegistry();
  const store = createStateStore({ REDIS_URL: server.url }, { logger: { info: (...args) => logs.push(args) }, metrics });
  t.after(() => { if (store.client.isOpen) store.client.destroy(); });
  await store.connect();
  assert.ok(logs.some((args) => args[1] === "state_store.redis_ready"));
  assert.match(metrics.serialize(), /state_store_redis_ready 1/);
});

test("Redis startup wait bounds an unfinished connection attempt", async () => {
  const started = Date.now();
  await assert.rejects(waitForStateStoreAtBoot({ connect: () => new Promise(() => {}) },
    { logger: { warn() {}, error() {} }, timeoutMs: 50 }), { code: "state_store_unavailable" });
  assert.ok(Date.now() - started < 200);
});
