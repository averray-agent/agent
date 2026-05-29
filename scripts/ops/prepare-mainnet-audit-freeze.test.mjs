import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  collectAuditPackageChecks,
  defaultAuditTag,
  buildFreezePreflight,
  findMissingLocalMarkdownLinks,
  parseArgs,
  parseMarkdownLinks,
  validateAuditTag
} from "./prepare-mainnet-audit-freeze.mjs";

const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OTHER = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

test("defaultAuditTag uses the UTC date", () => {
  assert.equal(
    defaultAuditTag(new Date("2026-05-29T23:59:59Z")),
    "audit/mainnet-2026-05-29"
  );
});

test("parseArgs defaults to today's audit tag and read-only mode", () => {
  const args = parseArgs([], { now: new Date("2026-05-29T12:00:00Z") });
  assert.equal(args.tag, "audit/mainnet-2026-05-29");
  assert.equal(args.createTag, false);
  assert.equal(args.json, false);
});

test("parseArgs accepts create-tag, evidence, json, and guard overrides", () => {
  const args = parseArgs([
    "--tag",
    "audit/mainnet-2026-06-01",
    "--create-tag",
    "--evidence",
    "docs/evidence/mainnet-audit-freeze-2026-06-01.json",
    "--json",
    "--allow-dirty",
    "--skip-origin-main-check"
  ]);
  assert.equal(args.tag, "audit/mainnet-2026-06-01");
  assert.equal(args.createTag, true);
  assert.equal(args.evidencePath, "docs/evidence/mainnet-audit-freeze-2026-06-01.json");
  assert.equal(args.json, true);
  assert.equal(args.allowDirty, true);
  assert.equal(args.skipOriginMainCheck, true);
});

test("validateAuditTag accepts only audit/mainnet calendar tags", () => {
  assert.deepEqual(validateAuditTag("audit/mainnet-2026-05-29"), []);
  assert.match(validateAuditTag("mainnet-2026-05-29").join("\n"), /audit\/mainnet/u);
  assert.match(validateAuditTag("audit/mainnet-2026-02-31").join("\n"), /valid calendar/u);
});

test("parseMarkdownLinks returns only local links", () => {
  const links = parseMarkdownLinks([
    "[local](./A.md)",
    "[fragment](./B.md#heading)",
    "[web](https://example.com)",
    "[mail](mailto:ops@example.com)",
    "[hash](#local-heading)"
  ].join("\n"));
  assert.deepEqual(links, ["./A.md", "./B.md"]);
});

test("findMissingLocalMarkdownLinks catches missing and outside-root links", () => {
  const root = mkdtempSync(join(tmpdir(), "audit-freeze-links-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "OK.md"), "ok\n");
  const missing = findMissingLocalMarkdownLinks({
    root,
    markdownPath: "docs/AUDIT_PACKAGE.md",
    markdown: [
      "[ok](./OK.md)",
      "[missing](./MISSING.md)",
      "[outside](../../outside.md)"
    ].join("\n")
  });
  assert.deepEqual(missing, ["./MISSING.md", "../../outside.md"]);
});

test("collectAuditPackageChecks validates links, docs paths, commands, and required files", () => {
  const root = mkdtempSync(join(tmpdir(), "audit-freeze-package-"));
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "LOCAL.md"), "local\n");
  writeFileSync(join(root, "docs", "AUDIT_PACKAGE.md"), [
    "[local](./LOCAL.md)",
    "reference/polkadot-hub/smart-contracts.md",
    "smart-contracts/precompiles/erc20.md",
    "smart-contracts/for-eth-devs/accounts.md",
    "smart-contracts/explorers.md",
    "npm install",
    "forge build",
    "forge test",
    "npm --workspace mcp-server test",
    "npm test",
    "npm run typecheck:app",
    "npm run build:frontend",
    "npm run build:site",
    "npm run typecheck:indexer",
    "npm run check:sdk-types"
  ].join("\n"));

  const checks = collectAuditPackageChecks({
    root,
    requiredFiles: ["docs/AUDIT_PACKAGE.md", "docs/LOCAL.md"]
  });

  assert.equal(checks.every((check) => check.ok), true);
  assert.equal(checks.some((check) => check.name === "auditPackage.localLinks"), true);
  assert.equal(checks.some((check) => check.name === "auditPackage.noObviousSecrets"), true);
});

test("buildFreezePreflight passes for a clean head on origin/main with available tag", () => {
  const result = buildFreezePreflight({
    tag: "audit/mainnet-2026-05-29",
    headCommit: HEAD,
    originMainCommit: HEAD,
    statusPorcelain: "",
    tagCommit: "",
    packageChecks: [{ name: "auditPackage.exists", ok: true }]
  });

  assert.equal(result.ok, true);
  assert.equal(result.commit, HEAD);
  assert.equal(result.nextActions[0], "git push origin refs/tags/audit/mainnet-2026-05-29");
});

test("buildFreezePreflight fails closed on dirty worktree, moving base, and reused tag", () => {
  const result = buildFreezePreflight({
    tag: "audit/mainnet-2026-05-29",
    headCommit: HEAD,
    originMainCommit: OTHER,
    statusPorcelain: " M docs/AUDIT_PACKAGE.md\n",
    tagCommit: OTHER,
    packageChecks: [{ name: "auditPackage.exists", ok: true }]
  });

  assert.equal(result.ok, false);
  const failed = result.checks.filter((check) => !check.ok).map((check) => check.name);
  assert.deepEqual(failed, [
    "git.headMatchesOriginMain",
    "git.worktreeClean",
    "git.tagAvailable"
  ]);
  assert.deepEqual(result.nextActions, []);
});

test("buildFreezePreflight allows explicit dirty/origin-main overrides", () => {
  const result = buildFreezePreflight({
    tag: "audit/mainnet-2026-05-29",
    headCommit: HEAD,
    originMainCommit: OTHER,
    statusPorcelain: " M docs/AUDIT_PACKAGE.md\n",
    tagCommit: "",
    packageChecks: [{ name: "auditPackage.exists", ok: true }],
    allowDirty: true,
    skipOriginMainCheck: true
  });

  assert.equal(result.ok, true);
  assert.equal(result.checks.find((check) => check.name === "git.headMatchesOriginMain").skipped, true);
});
