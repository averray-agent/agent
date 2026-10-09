import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { createCredentialsHealthProvider } from "./credentials-health.js";

test("credential health reads all configured public certs, uses earliest expiry, and never reads keys", async () => {
  const dir = mkdtempSync(join(tmpdir(), "credential-health-"));
  try {
    const certPath = join(dir, "fixture-cert.pem");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
      "-subj", "/CN=fixture-only", "-keyout", join(dir, "fixture-key.pem"), "-out", certPath], { stdio: "ignore" });
    const bytes = readFileSync(certPath), cert = new X509Certificate(bytes);
    const profiles = ["averray-signer", "averray-jwt-signer", "averray-badge-receipt-signer"];
    const config = profiles.map((profile) => `[profile ${profile}]\ncredential_process = helper --certificate "/certs/${profile}.pem" --private-key /never/read-this\n`).join("\n");
    let now = new Date(Date.parse(cert.validFrom) + 1000), reads = [];
    const get = createCredentialsHealthProvider({ env: { AWS_CONFIG_FILE: "/config" }, now: () => now,
      read: async (path) => { reads.push(path); assert.notEqual(path, "/never/read-this"); return path === "/config" ? config : bytes; },
      gateway: { signer: { getHealth: () => ({ ok: true, lastSignAt: "2026-10-08T10:00:00Z" }) } },
      badgeReceiptSigner: { getHealth: () => ({ kid: "badge-1", ok: true }) }
    });
    const result = await get();
    assert.deepEqual(result.rolesAnywhere, { ok: true, notAfter: new Date(cert.validTo).toISOString() });
    assert.deepEqual(result.kms, { ok: true, lastSignAt: "2026-10-08T10:00:00Z" });
    assert.deepEqual(result.badgeReceiptSigner, { kid: "badge-1", ok: true });
    assert.equal(reads.length, 4);
    await get();
    assert.equal(reads.length, 4, "certificate reads cached for 60 seconds");
    now = new Date(cert.validTo);
    assert.equal((await get()).rolesAnywhere.ok, false, "expired certificates are not healthy");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("missing/malformed credential files and never-used signers report unknown/unhealthy without paths or error text", async () => {
  const get = createCredentialsHealthProvider({ env: { AWS_CONFIG_FILE: "/private/config" },
    read: async () => { throw new Error("secret-path-fixture"); } });
  assert.deepEqual(await get(), { rolesAnywhere: { notAfter: null, ok: false, reason: "certificate_unavailable" },
    badgeReceiptSigner: { kid: null, ok: false, reason: "signer_unconfigured" }, kms: { ok: false, lastSignAt: null, reason: "signer_unconfigured" } });
});
