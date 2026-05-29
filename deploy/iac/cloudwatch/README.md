# KMS Signing Alarms

This directory is the first CloudWatch/CloudTrail IaC foundation for the hosted
stack. The template is intentionally additive: it does not create or modify KMS
keys, IAM roles, Roles Anywhere trust anchors, or key policies.

## Template

- `kms-signing-alarms.yaml`

The stack creates:

- a regional CloudTrail trail for KMS API management events
- a 90-day S3 log bucket for CloudTrail files
- a CloudWatch Logs group for CloudTrail delivery
- metric filters for the blockchain signer key and JWT signer key
- alarms for non-zero KMS signing errors, non-zero KMS access denied, KMS sign
  call spikes, auth failure spikes, and refresh-token replay detection
- backend log metric filters for `kms.sign.duration` events
- a dashboard with KMS sign call/error counts, GetPublicKey counts, auth
  failures, and p50/p95/p99 signer latency

AWS KMS API calls such as `Sign`, `GetPublicKey`, and `DescribeKey` are
CloudTrail management events. The template therefore uses an advanced
management-event selector restricted to `kms.amazonaws.com` and deliberately
does not set `ExcludeManagementEventSources` for KMS.

## Deploy

Pass the two signer key ARNs and threshold values from live baseline data. The
spike thresholds intentionally have no defaults so operators do not accidentally
ship guessed values.

```bash
aws cloudformation deploy \
  --region eu-central-2 \
  --stack-name averray-testnet-kms-signing-alarms \
  --template-file deploy/iac/cloudwatch/kms-signing-alarms.yaml \
  --capabilities CAPABILITY_IAM \
  --parameter-overrides \
    EnvironmentName=testnet \
    BlockchainSignerKeyArn="arn:aws:kms:eu-central-2:079209845430:key/<blockchain-signer-key-id>" \
    JwtSignerKeyArn="arn:aws:kms:eu-central-2:079209845430:key/<jwt-signer-key-id>" \
    BlockchainSignSpikeThresholdPer5Min="<baseline-derived-threshold>" \
    JwtSignSpikeThresholdPer5Min="<baseline-derived-threshold>" \
    AuthFailureThresholdPer5Min="<baseline-derived-threshold>" \
    PageTopicArn="<sns-topic-for-page-on-call>" \
    AlertTopicArn="<sns-topic-for-slack-alert-channel>"
```

If the alert SNS topics are not ready yet, omit `PageTopicArn` and
`AlertTopicArn`; the alarms will still be created without actions and can be
wired later by updating the stack.

## Proof

The roadmap row is not proofed by this template alone. To close it, capture a
sanitized operator evidence artifact after the stack is deployed with
baseline-derived thresholds and at least one alarm notification reaches the
operator alert channel.

Recommended file name:

```text
docs/evidence/kms-cloudwatch-alarms-YYYY-MM-DD.json
```

Validate the artifact before asking the roadmap steward to mark the row
`Proofed`:

```bash
node scripts/ops/check-kms-cloudwatch-alarm-proof.mjs \
  --file docs/evidence/kms-cloudwatch-alarms-YYYY-MM-DD.json \
  --max-completed-age-hours 24
```

The evidence must show:

- CloudFormation stack status is `CREATE_COMPLETE` or `UPDATE_COMPLETE` for
  `deploy/iac/cloudwatch/kms-signing-alarms.yaml`, including the template SHA.
- CloudTrail is actively logging KMS management events for `Sign`,
  `GetPublicKey`, `DescribeKey`, `Encrypt`, and `Decrypt`, with log-file
  validation and at least 90-day retention.
- Recent CloudTrail events include both `Sign` and `GetPublicKey` activity.
- Spike thresholds are derived from a real CloudWatch baseline window, not
  guessed defaults.
- All required alarms exist, are back in `OK`, have actions enabled, and point
  at the page or alert SNS destination.
- CloudWatch metrics include KMS call/error/access-denied counts, auth anomaly
  counts, and backend `kms.sign.duration` percentile data.
- A synthetic or controlled alarm notification reached the operator channel and
  was reset to `OK`.

Keep the artifact sanitized. Do not include bearer tokens, AWS access keys,
Slack webhook URLs, private keys, or raw 1Password values.
