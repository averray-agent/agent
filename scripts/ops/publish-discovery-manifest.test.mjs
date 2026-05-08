import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  canonicalizeJson,
  hashDiscoveryManifest,
  loadDiscoveryManifest,
  parseArgs,
  runPublishDiscoveryManifestCli
} from "./publish-discovery-manifest.mjs";

test("canonicalizeJson sorts object keys recursively", () => {
  const left = { b: 2, a: { d: true, c: ["z", "a"] } };
  const right = { a: { c: ["z", "a"], d: true }, b: 2 };

  assert.equal(canonicalizeJson(left), '{"a":{"c":["z","a"],"d":true},"b":2}');
  assert.equal(canonicalizeJson(left), canonicalizeJson(right));
});

test("hashDiscoveryManifest is stable across key order", () => {
  const first = hashDiscoveryManifest({ z: 1, a: "manifest" });
  const second = hashDiscoveryManifest({ a: "manifest", z: 1 });

  assert.match(first.hash, /^0x[a-f0-9]{64}$/u);
  assert.equal(first.hash, second.hash);
});

test("loadDiscoveryManifest can fetch a remote manifest", async () => {
  const manifest = await loadDiscoveryManifest({
    manifestUrl: "https://example.test/.well-known/agent-tools.json",
    fetchImpl: async (url, options) => {
      assert.equal(String(url), "https://example.test/.well-known/agent-tools.json");
      assert.equal(options.headers["user-agent"], "averray-discovery-registry-publisher");
      return {
        ok: true,
        async json() {
          return { name: "Averray", version: "test" };
        }
      };
    }
  });

  assert.deepEqual(manifest, { name: "Averray", version: "test" });
});

test("runPublishDiscoveryManifestCli dry-runs without chain config", async () => {
  const dir = await mkdtemp(join(tmpdir(), "averray-discovery-"));
  const path = join(dir, "agent-tools.json");
  await writeFile(path, JSON.stringify({ b: 2, a: 1 }), "utf8");
  let output = "";

  const result = await runPublishDiscoveryManifestCli({
    argv: ["--manifest-path", path, "--dry-run"],
    stdout: {
      write(chunk) {
        output += chunk;
      }
    }
  });

  assert.equal(result.status, "dry_run");
  assert.equal(result.canonicalBytes, 13);
  assert.equal(JSON.parse(output).hash, result.hash);
});

test("runPublishDiscoveryManifestCli skips when publish config is absent and explicitly allowed", async () => {
  let output = "";
  const result = await runPublishDiscoveryManifestCli({
    argv: ["--skip-missing-config"],
    env: {
      DISCOVERY_MANIFEST_URL: "https://example.test/agent-tools.json"
    },
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { name: "Averray" };
      }
    }),
    stdout: {
      write(chunk) {
        output += chunk;
      }
    }
  });

  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "missing_publish_config");
  assert.equal(result.configured.privateKey, false);
  assert.equal(JSON.parse(output).status, "skipped");
});

test("parseArgs normalizes kebab-case flags", () => {
  assert.deepEqual(parseArgs([
    "--manifest-url",
    "https://example.test/manifest.json",
    "--skip-missing-config",
    "--no-wait"
  ]), {
    manifestUrl: "https://example.test/manifest.json",
    skipMissingConfig: true,
    noWait: true
  });
});
