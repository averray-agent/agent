import assert from "node:assert/strict";
import test from "node:test";

import { extractEventEvidence } from "./extract-native-xcm-event.mjs";

const REQUEST_ID = `0x${"11".repeat(32)}`;
const BLOCK_HASH = `0x${"22".repeat(32)}`;
const EXTRINSIC_HASH = `0x${"33".repeat(32)}`;
const MESSAGE_HASH = `0x${"44".repeat(32)}`;

test("extracts Hub evidence from decoded event JSON", () => {
  const evidence = extractEventEvidence({
    chain: "hub",
    requestId: REQUEST_ID,
    input: {
      blockNumber: "123",
      blockHash: BLOCK_HASH,
      events: [
        {
          eventIndex: "123-0",
          event: {
            section: "System",
            method: "ExtrinsicSuccess"
          }
        },
        {
          eventIndex: "123-7",
          extrinsicHash: EXTRINSIC_HASH,
          messageHash: MESSAGE_HASH,
          event: {
            section: "XcmPallet",
            method: "Sent",
            data: {
              messageTopic: REQUEST_ID
            }
          }
        }
      ]
    }
  });

  assert.deepEqual(evidence, {
    chain: "polkadot-hub",
    blockNumber: "123",
    blockHash: BLOCK_HASH,
    extrinsicHash: EXTRINSIC_HASH,
    messageHash: MESSAGE_HASH,
    messageTopic: REQUEST_ID,
    eventIndex: "123-7"
  });
});

test("extracts Hub SetTopic evidence from explicit message_id fields", () => {
  const evidence = extractEventEvidence({
    chain: "hub",
    requestId: REQUEST_ID,
    input: {
      blockNumber: "123",
      blockHash: BLOCK_HASH,
      events: [
        {
          eventIndex: "123-7",
          extrinsicHash: EXTRINSIC_HASH,
          messageHash: MESSAGE_HASH,
          event: {
            section: "PolkadotXcm",
            method: "Sent",
            data: {
              message_id: REQUEST_ID
            }
          }
        }
      ]
    }
  });

  assert.equal(evidence.messageTopic, REQUEST_ID);
});

test("does not infer SetTopic evidence from request id text outside topic fields", () => {
  assert.throws(
    () => extractEventEvidence({
      chain: "hub",
      requestId: REQUEST_ID,
      input: {
        blockNumber: "123",
        blockHash: BLOCK_HASH,
        events: [
          {
            eventIndex: "123-7",
            extrinsicHash: EXTRINSIC_HASH,
            messageHash: MESSAGE_HASH,
            event: {
              section: "System",
              method: "Remarked",
              data: {
                note: `request ${REQUEST_ID} was seen in a non-topic field`
              }
            }
          }
        ]
      }
    }),
    /will not infer SetTopic proof/u
  );
});

test("prefers explicit topic event over earlier non-topic request id mention", () => {
  const evidence = extractEventEvidence({
    chain: "hub",
    requestId: REQUEST_ID,
    input: {
      blockNumber: "123",
      blockHash: BLOCK_HASH,
      events: [
        {
          eventIndex: "123-2",
          event: {
            section: "System",
            method: "Remarked",
            data: {
              note: `request ${REQUEST_ID} was logged before the XCM event`
            }
          }
        },
        {
          eventIndex: "123-7",
          extrinsicHash: EXTRINSIC_HASH,
          messageHash: MESSAGE_HASH,
          event: {
            section: "PolkadotXcm",
            method: "Sent",
            data: {
              message_id: REQUEST_ID
            }
          }
        }
      ]
    }
  });

  assert.equal(evidence.eventIndex, "123-7");
  assert.equal(evidence.messageTopic, REQUEST_ID);
});

test("extracts Bifrost evidence and amount from decoded event JSON", () => {
  const evidence = extractEventEvidence({
    chain: "bifrost",
    requestId: REQUEST_ID,
    input: {
      blockNumber: "456",
      blockHash: BLOCK_HASH,
      records: [
        {
          eventIndex: "456-12",
          event: {
            section: "XTokens",
            method: "Transferred",
            data: {
              topic: REQUEST_ID,
              amount: "5000000000000",
              assetLocation: {
                parents: 1,
                interior: "Here"
              }
            }
          }
        }
      ]
    }
  });

  assert.deepEqual(evidence, {
    chain: "bifrost-polkadot",
    blockNumber: "456",
    blockHash: BLOCK_HASH,
    eventIndex: "456-12",
    messageTopic: REQUEST_ID,
    assetLocation: {
      parents: 1,
      interior: "Here"
    },
    amount: "5000000000000"
  });
});

test("allows missing Bifrost topic for remote_ref fallback investigation", () => {
  const evidence = extractEventEvidence({
    chain: "bifrost",
    requestId: REQUEST_ID,
    input: {
      blockNumber: "456",
      blockHash: BLOCK_HASH,
      events: [
        {
          eventIndex: "456-4",
          event: {
            section: "Balances",
            method: "Deposit",
            data: {
              amount: "7"
            }
          }
        }
      ]
    },
    overrides: {
      allowMissingTopic: true,
      eventIndex: "456-4"
    }
  });

  assert.equal(evidence.messageTopic, undefined);
  assert.equal(evidence.amount, "7");
});
