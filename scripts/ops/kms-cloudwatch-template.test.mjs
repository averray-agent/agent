// Unit tests for deploy/iac/cloudwatch/kms-signing-alarms.yaml.

import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";
import yaml from "js-yaml";

const TEMPLATE_PATH = new URL("../../deploy/iac/cloudwatch/kms-signing-alarms.yaml", import.meta.url);

async function templateText() {
  return readFile(TEMPLATE_PATH, "utf8");
}

function assertIncludesAll(text, snippets) {
  for (const snippet of snippets) {
    assert.ok(text.includes(snippet), `expected template to include: ${snippet}`);
  }
}

function cloudFormationSchema() {
  const scalar = (tag) => new yaml.Type(tag, { kind: "scalar", construct: (data) => data });
  const sequence = (tag) => new yaml.Type(tag, { kind: "sequence", construct: (data) => data });
  return yaml.DEFAULT_SCHEMA.extend([
    scalar("!Ref"),
    scalar("!Sub"),
    scalar("!GetAtt"),
    sequence("!If"),
    sequence("!Not"),
    sequence("!Equals"),
  ]);
}

test("KMS CloudWatch template is valid YAML with CloudFormation intrinsics", async () => {
  const text = await templateText();
  const parsed = yaml.load(text, { schema: cloudFormationSchema() });
  assert.equal(parsed.AWSTemplateFormatVersion, "2010-09-09");
  assert.ok(parsed.Resources.KmsAuditTrail, "expected KmsAuditTrail resource");
});

test("KMS CloudWatch template keeps KMS management events enabled", async () => {
  const text = await templateText();
  assertIncludesAll(text, [
    "Type: AWS::CloudTrail::Trail",
    "AdvancedEventSelectors:",
    "Field: eventCategory",
    "- Management",
    "Field: eventSource",
    "- kms.amazonaws.com",
    "- Sign",
    "- GetPublicKey",
    "- DescribeKey",
    "- Encrypt",
    "- Decrypt",
    "EnableLogFileValidation: true",
    "RetentionInDays: 90",
    "ExpirationInDays: 90",
  ]);
  assert.equal(
    text.includes("ExcludeManagementEventSources"),
    false,
    "the trail must not exclude kms.amazonaws.com management events",
  );
});

test("KMS CloudWatch template separates blockchain and JWT signer alarms", async () => {
  const text = await templateText();
  assertIncludesAll(text, [
    "BlockchainSignerKeyArn:",
    "JwtSignerKeyArn:",
    "BlockchainKMSSignCallCount",
    "JwtKMSSignCallCount",
    "BlockchainKMSSignErrorCount",
    "JwtKMSSignErrorCount",
    "Key: ErrorCode",
    "Value: $.errorCode",
    "BlockchainKMSAccessDeniedCount",
    "JwtKMSAccessDeniedCount",
    "BlockchainKMSGetPublicKeyCallCount",
    "JwtKMSGetPublicKeyCallCount",
    "averray-${EnvironmentName}-blockchain-kms-sign-error",
    "averray-${EnvironmentName}-jwt-kms-sign-error",
    "averray-${EnvironmentName}-blockchain-kms-access-denied",
    "averray-${EnvironmentName}-jwt-kms-access-denied",
  ]);
});

test("KMS CloudWatch template requires baseline-derived spike thresholds", async () => {
  const text = await templateText();
  for (const parameterName of [
    "BlockchainSignSpikeThresholdPer5Min",
    "JwtSignSpikeThresholdPer5Min",
    "AuthFailureThresholdPer5Min",
  ]) {
    const parameterBlock = text.match(new RegExp(`  ${parameterName}:\\n(?<body>(?:    .+\\n)+)`))?.groups?.body ?? "";
    assert.ok(parameterBlock.includes("Type: Number"), `${parameterName} should be a Number parameter`);
    assert.ok(parameterBlock.includes("Intentionally no default."), `${parameterName} should document no default`);
    assert.equal(parameterBlock.includes("Default:"), false, `${parameterName} must not guess a default threshold`);
  }
});

test("KMS CloudWatch template captures backend signer latency and auth anomalies", async () => {
  const text = await templateText();
  assertIncludesAll(text, [
    "BackendLogGroupName:",
    "FilterPattern: '{ ($.event = \"kms.sign.duration\") && ($.signer = \"blockchain\") && ($.success = true) }'",
    "FilterPattern: '{ ($.event = \"kms.sign.duration\") && ($.signer = \"jwt\") && ($.success = true) }'",
    "MetricName: BlockchainKMSSignDurationMs",
    "MetricName: JwtKMSSignDurationMs",
    "AuthFailureCount",
    "AuthRefreshReplayDetectedCount",
    "\"stat\": \"p50\"",
    "\"stat\": \"p95\"",
    "\"stat\": \"p99\"",
  ]);
});
