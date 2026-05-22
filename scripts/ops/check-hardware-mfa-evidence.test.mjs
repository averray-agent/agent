import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { SCHEMA_VERSION, validateEvidence } from "./check-hardware-mfa-evidence.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "check-hardware-mfa-evidence.mjs"
);

function account(id, overrides = {}) {
  const base = {
    id,
    provider: id.replaceAll("_", " "),
    accountLabel: `${id} admin`,
    status: "hardware_key_enrolled",
    primaryKeyLabel: "YK1-primary",
    backupKeyLabel: "YK2-backup-safe",
    backupKeyLoginTested: true,
    recoveryPathDocumented: true,
    recoveryCodesStored: true,
    recoveryLocation: "op://prod-critical/yubikey-recovery-runbook/notes",
    lastVerifiedAt: "2026-05-22T12:30:00.000Z",
    evidence: {
      method: "operator_attestation",
      reference: `${id} security settings inspected by operator`
    }
  };
  if (id === "domain_registrar") {
    base.fido2Supported = true;
  }
  if (id === "github_org_admin") {
    base.memberAuditCompleted = true;
    base.orgTwoFactorRequirementEnabled = true;
  }
  if (id === "aws_iam_admins") {
    base.subjects = [
      {
        username: "pkuriger",
        hardwareKeyEnrolled: true,
        backupKeyLoginTested: true
      }
    ];
  }
  return {
    ...base,
    ...overrides
  };
}

function validEvidence(overrides = {}) {
  return {
    schemaVersion: SCHEMA_VERSION,
    completedAt: "2026-05-22T13:00:00.000Z",
    operator: {
      name: "Pascal",
      signature: "PK"
    },
    hardwareKeys: [
      {
        label: "YK1-primary",
        serialFingerprint: "yk-primary-1234",
        physicalCustodyConfirmed: true
      },
      {
        label: "YK2-backup-safe",
        serialFingerprint: "yk-backup-5678",
        physicalCustodyConfirmed: true
      }
    ],
    accounts: [
      account("one_password_admin"),
      account("aws_root"),
      account("aws_iam_admins"),
      account("github_org_admin"),
      account("domain_registrar"),
      account("vps_provider")
    ],
    recoveryRunbook: {
      location: "op://prod-critical/yubikey-recovery-runbook/notes",
      backupKeyTestedAcrossAllAccounts: true,
      noRawRecoveryCodesInEvidence: true
    },
    ...overrides
  };
}

async function writeEvidenceFile(doc) {
  const dir = await mkdtemp(join(tmpdir(), "hardware-mfa-evidence-"));
  const file = join(dir, "evidence.json");
  await writeFile(file, JSON.stringify(doc, null, 2), "utf8");
  return file;
}

test("validateEvidence accepts complete hardware MFA evidence", () => {
  const result = validateEvidence(validEvidence());
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.summary.hardwareKeyCount, 2);
  assert.equal(result.summary.accountCount, 6);
});

test("validateEvidence rejects missing trust-chain accounts", () => {
  const doc = validEvidence({
    accounts: validEvidence().accounts.filter((entry) => entry.id !== "domain_registrar")
  });
  const result = validateEvidence(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("accounts must include domain_registrar"));
});

test("validateEvidence rejects duplicate trust-chain accounts", () => {
  const doc = validEvidence({
    accounts: [
      account("one_password_admin"),
      account("one_password_admin"),
      account("aws_root"),
      account("aws_iam_admins"),
      account("github_org_admin"),
      account("domain_registrar"),
      account("vps_provider")
    ]
  });
  const result = validateEvidence(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("accounts must not contain duplicate id one_password_admin"));
});

test("validateEvidence rejects single-key or untested backup-key evidence", () => {
  const doc = validEvidence({
    hardwareKeys: [validEvidence().hardwareKeys[0]],
    accounts: [
      account("one_password_admin", {
        backupKeyLabel: "YK1-primary",
        backupKeyLoginTested: false
      }),
      account("aws_root"),
      account("aws_iam_admins"),
      account("github_org_admin"),
      account("domain_registrar"),
      account("vps_provider")
    ]
  });
  const result = validateEvidence(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("hardwareKeys must include at least two keys"));
  assert.ok(result.errors.includes("accounts[0].primaryKeyLabel and accounts[0].backupKeyLabel must be different"));
  assert.ok(result.errors.includes("accounts[0].backupKeyLoginTested must be true"));
});

test("validateEvidence rejects GitHub and registrar safety gaps", () => {
  const doc = validEvidence({
    accounts: [
      account("one_password_admin"),
      account("aws_root"),
      account("aws_iam_admins"),
      account("github_org_admin", {
        memberAuditCompleted: false,
        orgTwoFactorRequirementEnabled: false
      }),
      account("domain_registrar", {
        fido2Supported: false
      }),
      account("vps_provider")
    ]
  });
  const result = validateEvidence(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("accounts[3].memberAuditCompleted must be true before org-wide 2FA enforcement"));
  assert.ok(result.errors.includes("accounts[3].orgTwoFactorRequirementEnabled must be true"));
  assert.ok(result.errors.includes("accounts[4].fido2Supported must be true; migrate registrar before mainnet if unavailable"));
});

test("validateEvidence rejects IAM admin users without tested backup-key login", () => {
  const doc = validEvidence({
    accounts: [
      account("one_password_admin"),
      account("aws_root"),
      account("aws_iam_admins", {
        subjects: [
          {
            username: "pkuriger",
            hardwareKeyEnrolled: true,
            backupKeyLoginTested: false
          }
        ]
      }),
      account("github_org_admin"),
      account("domain_registrar"),
      account("vps_provider")
    ]
  });
  const result = validateEvidence(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.includes("accounts[2].subjects[0].backupKeyLoginTested must be true"));
});

test("validateEvidence rejects raw secret-looking values", () => {
  const doc = validEvidence({
    recoveryRunbook: {
      ...validEvidence().recoveryRunbook,
      accidentalSecret: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    }
  });
  const result = validateEvidence(doc);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("appears to contain a secret value")));
});

test("CLI exits zero and prints JSON for valid evidence", async () => {
  const file = await writeEvidenceFile(validEvidence());
  const { stdout } = await execFileAsync(process.execPath, [scriptPath, "--file", file, "--json"]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.status, "ok");
  assert.equal(parsed.summary.operator, "Pascal");
});

test("CLI exits non-zero for invalid evidence", async () => {
  const file = await writeEvidenceFile(validEvidence({
    accounts: [
      account("one_password_admin", {
        status: "totp_only"
      }),
      account("aws_root"),
      account("aws_iam_admins"),
      account("github_org_admin"),
      account("domain_registrar"),
      account("vps_provider")
    ]
  }));
  await assert.rejects(
    () => execFileAsync(process.execPath, [scriptPath, "--file", file]),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /accounts\[0\]\.status must be hardware_key_enrolled/u);
      return true;
    }
  );
});
