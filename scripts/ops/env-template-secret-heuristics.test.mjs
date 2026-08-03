import assert from 'node:assert/strict';
import test from 'node:test';

import { findRawSecretHeuristics } from './env-template-secret-heuristics.mjs';

const HEX_32_BYTES = `0x${'98'.repeat(32)}`;

test('public ACCOUNT_ID32 literals do not trip raw-secret heuristics', () => {
  const varName = 'BANK_LANE_FEED_HYDRATION_ACCOUNT_ID32';
  assert.deepEqual(
    findRawSecretHeuristics(`${varName}=${HEX_32_BYTES}`, {
      varName,
      value: HEX_32_BYTES,
    }),
    [],
  );
});

test('a real 32-byte hex secret still fails under a secret key name', () => {
  const varName = 'SIGNER_PRIVATE_KEY';
  const findings = findRawSecretHeuristics(`${varName}=${HEX_32_BYTES}`, {
    varName,
    value: HEX_32_BYTES,
  });
  assert.ok(findings.includes('hex private key (32+ bytes)'));
  assert.ok(findings.includes('long base64-ish secret'));
});

test('ACCOUNT_ID32 suffix does not exempt a non-AccountId32 secret shape', () => {
  const varName = 'MALFORMED_ACCOUNT_ID32';
  const value = 'eyHeaderHeaderHeaderHeader.PayloadPayloadPayloadPayload.SignatureSignatureSignature';
  assert.deepEqual(
    findRawSecretHeuristics(`${varName}=${value}`, { varName, value }),
    ['JWT'],
  );
});
