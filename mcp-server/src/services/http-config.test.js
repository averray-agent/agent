import test from "node:test";
import assert from "node:assert/strict";

import { loadHttpConfig } from "./bootstrap.js";

test("loadHttpConfig uses safe defaults when env is empty", () => {
  const config = loadHttpConfig({});
  assert.equal(config.maxBodyBytes, 64 * 1024);
  assert.equal(config.allowedOrigins.size, 0);
  assert.equal(config.allowAllOrigins, false);
  assert.equal(config.allowedMethods, "GET, POST, OPTIONS");
  assert.equal(config.maxAgeSeconds, 600);
});

test("loadHttpConfig parses CORS_ALLOWED_ORIGINS as a comma-separated set", () => {
  const config = loadHttpConfig({
    CORS_ALLOWED_ORIGINS: "https://app.averray.com, http://localhost:5173"
  });
  assert.equal(config.allowedOrigins.size, 2);
  assert.ok(config.allowedOrigins.has("https://app.averray.com"));
  assert.ok(config.allowedOrigins.has("http://localhost:5173"));
  assert.equal(config.allowAllOrigins, false);
});

test("loadHttpConfig detects wildcard origin", () => {
  const config = loadHttpConfig({ CORS_ALLOWED_ORIGINS: "*" });
  assert.equal(config.allowAllOrigins, true);
});

test("loadHttpConfig respects HTTP_MAX_BODY_BYTES", () => {
  const config = loadHttpConfig({ HTTP_MAX_BODY_BYTES: "16384" });
  assert.equal(config.maxBodyBytes, 16 * 1024);
});

test("loadHttpConfig falls back to default when HTTP_MAX_BODY_BYTES is invalid", () => {
  const config = loadHttpConfig({ HTTP_MAX_BODY_BYTES: "not-a-number" });
  assert.equal(config.maxBodyBytes, 64 * 1024);
});
