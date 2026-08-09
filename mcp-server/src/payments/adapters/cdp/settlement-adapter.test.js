import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { Wallet } from "ethers";

import { CdpSettlementAdapter } from "./settlement-adapter.js";

const PAYER = Wallet.createRandom().address;
const TX = `0x${"a".repeat(64)}`;
const REQUIREMENTS = {
  scheme: "exact",
  network: "eip155:8453",
  asset: "0x1111111111111111111111111111111111111111",
  amount: "1050000",
  payTo: "0x2222222222222222222222222222222222222222",
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" }
};

function proof() {
  return Buffer.from(JSON.stringify({
    x402Version: 2,
    accepted: REQUIREMENTS,
    payload: {
      signature: `0x${"1".repeat(130)}`,
      authorization: {
        from: PAYER,
        to: REQUIREMENTS.payTo,
        value: REQUIREMENTS.amount,
        validAfter: "0",
        validBefore: "1999999999",
        nonce: `0x${"b".repeat(64)}`
      }
    }
  })).toString("base64");
}

function adapter(responses) {
  const queue = [...responses];
  const requests = [];
  const instance = new CdpSettlementAdapter({
    config: {
      baseUrl: new URL("https://facilitator.example/platform/v2/x402"),
      apiKeyId: "key-id",
      apiKeySecret: Buffer.alloc(32, 7).toString("base64"),
      timeoutMs: 1000
    },
    generateAuthorization: async () => "jwt",
    now: () => new Date("2026-08-09T12:00:00.000Z"),
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      const body = queue.shift();
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        async json() { return body; }
      };
    }
  });
  instance.requests = requests;
  return instance;
}

test("CDP adapter normalizes provider verify and settle responses", async () => {
  const settlement = adapter([
    { isValid: true, payer: PAYER },
    { success: true, payer: PAYER, transaction: TX, network: "base", amount: "1050000" }
  ]);

  const verified = await settlement.verify({ paymentProof: proof(), requirements: REQUIREMENTS });
  assert.equal(verified.payer, PAYER.toLowerCase());
  assert.match(verified.authorizationId, /^0x[a-f0-9]{64}$/u);

  const settled = await settlement.settle({ paymentProof: proof(), requirements: REQUIREMENTS });
  assert.deepEqual(settled, {
    receiptId: TX,
    network: "eip155:8453",
    payer: PAYER.toLowerCase(),
    amount: "1050000",
    settledAt: "2026-08-09T12:00:00.000Z",
    discovery: { discoverable: true, portable: true, status: "not_reported" }
  });
});

test("CDP invalidReason is converted to a provider-neutral actionable error", async () => {
  const settlement = adapter([{ isValid: false, invalidReason: "insufficient_funds" }]);
  await assert.rejects(
    settlement.verify({ paymentProof: proof(), requirements: REQUIREMENTS }),
    (error) => {
      assert.equal(error.code, "payment_insufficient_funds");
      assert.equal(error.details.posterFunds, "unchanged");
      assert.equal("invalidReason" in (error.details ?? {}), false);
      return true;
    }
  );
});

test("malformed payer after reported settlement success is outcome-unknown and actionable", async () => {
  const settlement = adapter([
    { success: true, payer: "not-an-address", transaction: TX, amount: "1050000" }
  ]);

  await assert.rejects(
    settlement.settle({ paymentProof: proof(), requirements: REQUIREMENTS }),
    (error) => {
      assert.equal(error.code, "payment_settlement_outcome_unknown");
      assert.equal(error.details.posterFunds, "unknown");
      assert.equal(error.details.action, "check_wallet_and_contact_support");
      return true;
    }
  );
});

test("adapter forwards only generic portable Bazaar metadata to verify and settle", async () => {
  const settlement = adapter([
    { isValid: true, payer: PAYER },
    { success: true, payer: PAYER, transaction: TX, network: "base", amount: "1050000" }
  ]);
  const context = {
    resource: {
      url: "https://api.example.test/jobs/x402",
      description: "Post a worker job.",
      mimeType: "application/json"
    },
    extensions: {
      bazaar: {
        discoverable: true,
        portable: true,
        info: {
          input: {
            type: "http",
            method: "POST",
            bodyType: "json",
            body: { definition: { rewardAmount: "1" } }
          }
        },
        schema: { type: "object" }
      }
    }
  };

  await settlement.verify({ paymentProof: proof(), requirements: REQUIREMENTS, ...context });
  await settlement.settle({ paymentProof: proof(), requirements: REQUIREMENTS, ...context });

  assert.equal(settlement.requests.length, 2);
  for (const request of settlement.requests) {
    assert.equal(request.paymentPayload.resource.url, context.resource.url);
    assert.equal(request.paymentPayload.extensions.bazaar.discoverable, true);
    assert.equal(request.paymentPayload.extensions.bazaar.portable, true);
    assert.equal(request.paymentPayload.extensions.bazaar.info.input.method, "POST");
  }
});

test("provider identifiers stay inside the adapter package", async () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const sourceRoot = resolve(here, "../../..");
  const adapterRoot = resolve(here, "..");
  const offenders = [];
  for (const file of await walk(sourceRoot)) {
    if (file.startsWith(adapterRoot)) continue;
    const content = await readFile(file, "utf8");
    if (/\bcdp\b/iu.test(content)) offenders.push(relative(sourceRoot, file));
  }
  assert.deepEqual(offenders, []);
});

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile() && /\.(?:js|json)$/u.test(entry.name)) files.push(path);
  }
  return files;
}
