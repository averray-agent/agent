import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("shutdown flushes arrival alerts with a bound and a second signal exits", async () => {
  const source = await readFile(new URL("./server.js", import.meta.url), "utf8");
  const start = source.indexOf("async function shutdown");
  const end = source.indexOf("for (const signal of", start);
  const shutdown = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(shutdown, /if \(shuttingDown\) process\.exit\(0\)/);
  assert.match(shutdown, /Promise\.race\(\[\s*arrivalAlerts\.stop\(\)/);
  assert.match(shutdown, /ALERT_SHUTDOWN_FLUSH_MS/);
  assert.match(source, /const ALERT_SHUTDOWN_FLUSH_MS = 2_000/);
  assert.match(source, /for \(const signal of \["SIGINT", "SIGTERM"\]\)/);
  assert.match(source, /process\.on\(signal, \(\) => \{\s*void shutdown\(signal\);/);
});
