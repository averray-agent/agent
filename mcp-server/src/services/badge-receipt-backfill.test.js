import assert from "node:assert/strict";
import test from "node:test";

import { MemoryStateStore } from "../core/state-store.js";
import { backfillBadgeReceiptSignatures } from "./badge-receipt-backfill.js";

test("backfill signs every stored unsigned badge and preserves already signed documents", async () => {
  const stateStore = new MemoryStateStore();
  for (const sessionId of ["session-1", "session-2", "session-3"]) {
    await stateStore.upsertSession({ sessionId, jobId: `job-${sessionId}`, wallet: "0xabc" });
  }
  await stateStore.putBadgeDocument("session-1", { averray: { sessionId: "session-1" } });
  await stateStore.putBadgeDocument("session-2", { averray: { sessionId: "session-2" } });
  const existingSignature = { alg: "ES256", kid: "badge-1", sig: "old..signature", signedAt: "2026-07-10T00:00:00.000Z" };
  await stateStore.putBadgeDocument("session-3", { averray: { sessionId: "session-3" }, signature: existingSignature });

  const calls = [];
  const result = await backfillBadgeReceiptSignatures({
    stateStore,
    pageSize: 2,
    logger: { info() {} },
    signer: {
      verifyDocument: () => true,
      async signDocument(document) {
        calls.push(document.averray.sessionId);
        return { alg: "ES256", kid: "badge-1", sig: `new..${document.averray.sessionId}`, signedAt: "2026-07-11T00:00:00.000Z" };
      },
    },
  });

  assert.deepEqual(result, { scanned: 3, signed: 2, alreadySigned: 1 });
  assert.deepEqual(calls.sort(), ["session-1", "session-2"]);
  assert.equal((await stateStore.getBadgeDocument("session-1")).signature.kid, "badge-1");
  assert.deepEqual((await stateStore.getBadgeDocument("session-3")).signature, existingSignature);
});

test("backfill fails startup on a corrupt persisted signature", async () => {
  const stateStore = new MemoryStateStore();
  await stateStore.upsertSession({ sessionId: "session-corrupt", jobId: "job-corrupt", wallet: "0xabc" });
  await stateStore.putBadgeDocument("session-corrupt", {
    averray: { sessionId: "session-corrupt" },
    signature: { alg: "ES256", kid: "badge-1", sig: "bad..signature", signedAt: "2026-07-10T00:00:00.000Z" }
  });

  await assert.rejects(
    backfillBadgeReceiptSignatures({
      stateStore,
      logger: { info() {} },
      signer: { verifyDocument: () => false, signDocument: async () => assert.fail("must not re-sign corrupt data") }
    }),
    /invalid signature; refusing startup/u
  );
});
