#!/usr/bin/env node

/**
 * Phase 3 prep — derive the EVM address from an AWS KMS asymmetric key.
 *
 * The KMS signer's "address" is the keccak256 of its uncompressed
 * secp256k1 public key, last 20 bytes (per the EIP-55 / EIP-155 path
 * that every EVM signer uses). To get the public key we call
 * `kms:GetPublicKey`, which returns it as a DER-encoded
 * SubjectPublicKeyInfo (SPKI).
 *
 * Usage:
 *   AWS_REGION=eu-central-2 \
 *     node scripts/ops/derive-kms-signer-address.mjs <key-arn-or-id>
 *
 * Or, for offline testing against a captured fixture (no AWS creds
 * needed):
 *   node scripts/ops/derive-kms-signer-address.mjs --spki-file /tmp/captured.der
 *
 * Notes:
 *   - The SPKI structure for a secp256k1 EC key has a known shape, but
 *     the doc (docs/SECRETS_MIGRATION.md §3c) warns against slicing
 *     fixed offsets because the algorithm OID encoding can vary. We
 *     do a small hand-rolled ASN.1 walk and validate every length
 *     byte; any structural surprise fails loudly with a specific error.
 *   - `kms:GetPublicKey` does NOT require `kms:Sign` permission, so
 *     this script is safe to run against a key that the caller can
 *     only read.
 *
 * Exit codes:
 *   0  Address derived and printed.
 *   1  Bad input (missing key id, malformed SPKI, etc.).
 *   2  AWS error (auth, network, key not found).
 */

import { readFile } from "node:fs/promises";
import {
  parseSecp256k1Spki,
  addressFromUncompressedPoint,
} from "../../mcp-server/src/blockchain/spki.js";

const HELP = `Usage:
  AWS_REGION=eu-central-2 node scripts/ops/derive-kms-signer-address.mjs <key-arn-or-id>
  node scripts/ops/derive-kms-signer-address.mjs --spki-file <path-to-der>

Flags:
  --spki-file <path>   Skip AWS; read SPKI bytes from a local DER file.
                       For offline test fixtures.
  --json               Emit JSON output {address, publicKeyHex, keyId}.
  --help, -h           This message.
`;

// ─── CLI ─────────────────────────────────────────────────────────────
//
// SPKI parsing + address derivation now live in
// mcp-server/src/blockchain/spki.js, shared between this script and
// the runtime KmsSigner. Below: just the CLI plumbing.

function parseArgs(argv) {
  const out = { positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (a === "--spki-file") {
      out.spkiFile = argv[++i];
    } else if (a === "--json") {
      out.json = true;
    } else if (a.startsWith("--")) {
      throw new Error(`Unknown flag: ${a}`);
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    console.error(HELP);
    process.exit(1);
  }
  if (args.help) {
    console.log(HELP);
    return;
  }

  // Two paths: AWS (default) or fixture file (--spki-file).
  let der;
  let keyId = null;
  if (args.spkiFile) {
    try {
      der = new Uint8Array(await readFile(args.spkiFile));
    } catch (err) {
      console.error(`Could not read ${args.spkiFile}: ${err.message}`);
      process.exit(1);
    }
  } else {
    keyId = args.positional[0];
    if (!keyId) {
      console.error("Missing key id. Provide an AWS KMS key id/ARN or use --spki-file.");
      console.error(HELP);
      process.exit(1);
    }
    const region = process.env.AWS_REGION;
    if (!region) {
      console.error("AWS_REGION is required when fetching from KMS.");
      process.exit(1);
    }
    // Lazy-import the AWS SDK so the script also works in offline /
    // CI environments that haven't installed @aws-sdk/* yet.
    let KMSClient, GetPublicKeyCommand;
    try {
      ({ KMSClient, GetPublicKeyCommand } = await import("@aws-sdk/client-kms"));
    } catch (err) {
      console.error(`@aws-sdk/client-kms not installed: ${err.message}`);
      console.error("Run `npm install` at the repo root, or pass --spki-file for offline test.");
      process.exit(1);
    }
    const kms = new KMSClient({ region });
    try {
      const { PublicKey } = await kms.send(new GetPublicKeyCommand({ KeyId: keyId }));
      if (!PublicKey) throw new Error("KMS returned empty PublicKey");
      der = new Uint8Array(PublicKey);
    } catch (err) {
      console.error(`KMS GetPublicKey failed: ${err.message}`);
      process.exit(2);
    }
  }

  let point, address;
  try {
    point = parseSecp256k1Spki(der);
    address = addressFromUncompressedPoint(point);
  } catch (err) {
    console.error(`Could not derive address: ${err.message}`);
    process.exit(1);
  }

  if (args.json) {
    process.stdout.write(JSON.stringify({
      address,
      publicKeyHex: "0x" + Buffer.from(point).toString("hex"),
      keyId
    }) + "\n");
  } else {
    console.log(`EVM address: ${address}`);
    console.log(`Public key:  0x${Buffer.from(point).toString("hex")}`);
    if (keyId) console.log(`KMS key id:  ${keyId}`);
  }
}

// Run only when invoked as a script (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
