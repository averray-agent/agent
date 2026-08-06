const V21_REQUEST_ID = "0xb609f4d875e0c6f4f4b1dddd90efd687215d1ac9ecd90d0de51b9304f57ecaac";
const V21_WRAPPER = "0x2af394fa95f75d3ca1c786128f4dfa1eb0c9675d";
const V21_TARGET_ACCOUNT = "0x85663dfdb243b1a11a90f0816e1f83ccdb99f8f4c4a25d432739218efd489736";
const V21_FAILURE_CODE = "0x264d5febe16cb945449c8bec5318fe99984b049047fa02b24e9fe06083d0a915";
const V21_TERMINAL_TX = "0xc34167372042061433713b7caab8e04986391857357b5726e55d4ca0e1a97ba1";
const V21_TERMINAL_BLOCK = 19_048_419;
const V21_TERMINAL_BLOCK_HASH = "0x0841027cf938961e3ed61df623981efce148cfe464496702baf565cb3582cc29";
const V21_TERMINAL_AT = "2026-08-04T11:34:00.000Z";
const V22_WRAPPER = "0xecee778e11b238d2fc096e56460e7b98dc7b26b8";
const V22_SETTLED_ASSETS = "0";
const V22_SETTLED_SHARES = "0";
const V22_FAILURE_CODE = "0x19f800d9f7e28210802138d60cda15ec94016cfb24f6a8c293a6cb83150c720d";
const V22_OBSERVATION_SOURCE = "balance_timeout:erc20";
const V22_SETTLED_VIA = "adapter_v22_expiry_cancel";

/**
 * One-time bridge from the request-id-only observer table to the wrapper-
 * scoped table. The only live legacy collision is the retired v2.1 request,
 * whose Failed terminalization and full recovery are recorded in the mainnet
 * manifest and chain evidence. Preserve it as history; never delete it or let
 * it occupy the v2.2 generation's identity.
 */
export async function migrateLegacyBankV21BalanceWatch(stateStore, { logger = console } = {}) {
  if (typeof stateStore?.migrateLegacyXcmBalanceWatch !== "function") {
    throw new Error("State store cannot perform the required generation-scoped XCM watch migration.");
  }
  const result = await stateStore.migrateLegacyXcmBalanceWatch({
    requestId: V21_REQUEST_ID,
    expectedTargetAccount: V21_TARGET_ACCOUNT,
    wrapperAddress: V21_WRAPPER,
    terminal: {
      status: "failed",
      phase: "terminal",
      completedAt: V21_TERMINAL_AT,
      lastError: null,
      registrationSource: "legacy_generation_migration",
      outcome: {
        status: "failed",
        settledAssets: "0",
        settledShares: "0",
        failureCode: V21_FAILURE_CODE,
        source: "on_chain_terminalization_migration",
        observedAt: V21_TERMINAL_AT,
      },
      archive: {
        reason: "v2.1 request was terminally Failed and released on-chain before generation-scoped observer storage",
        terminalizationTxHash: V21_TERMINAL_TX,
        terminalizationBlockNumber: V21_TERMINAL_BLOCK,
        terminalizationBlockHash: V21_TERMINAL_BLOCK_HASH,
        releaseExecutionTxHash: "0x380e4c33e8d933860713ff4205395b6de0293583f9f92aac8be777b784152aa7",
        releaseExecutionBlockNumber: 19_050_332,
        releaseMultisigTimepoint: "19050316-2",
        releaseStatus: "released_closed",
      },
    },
  });
  logger.info?.({
    migration: "bank_xcm_v21_watch_generation_scope",
    status: result.status,
    requestId: V21_REQUEST_ID,
    wrapperAddress: V21_WRAPPER,
  }, "bank_xcm_watch.migration");
  return result;
}

/**
 * The v2.2 deposit reused the deterministic treasury nonce-1 request id and
 * produced the sole request-id-only observation in production. It records the
 * audited expiry cancellation (Failed 0/0 on the observer side, converged to
 * Cancelled by the adapter), not the later manually settled deposit. Move that
 * terminal fact under the v2.2 wrapper namespace. The v2.2.1 terminal balance
 * watch can then resume its own observation without either generation
 * suppressing the other.
 */
export async function migrateLegacyBankV22Observation(stateStore, { logger = console } = {}) {
  if (typeof stateStore?.migrateLegacyXcmObservation !== "function") {
    throw new Error("State store cannot perform the required generation-scoped XCM observation migration.");
  }
  const result = await stateStore.migrateLegacyXcmObservation({
    requestId: V21_REQUEST_ID,
    wrapperAddress: V22_WRAPPER,
    expected: {
      status: "failed",
      settledAssets: V22_SETTLED_ASSETS,
      settledShares: V22_SETTLED_SHARES,
      failureCode: V22_FAILURE_CODE,
      source: V22_OBSERVATION_SOURCE,
      processed: true,
      "result.status": "cancelled",
      "result.settledVia": V22_SETTLED_VIA
    }
  });
  logger.info?.({
    migration: "bank_xcm_v22_observation_generation_scope",
    status: result.status,
    requestId: V21_REQUEST_ID,
    wrapperAddress: V22_WRAPPER
  }, "bank_xcm_observation.migration");
  return result;
}

export async function migrateLegacyBankXcmGenerationState(stateStore, options = {}) {
  return {
    watch: await migrateLegacyBankV21BalanceWatch(stateStore, options),
    observation: await migrateLegacyBankV22Observation(stateStore, options)
  };
}

export const BANK_XCM_V21_WATCH_MIGRATION = Object.freeze({
  requestId: V21_REQUEST_ID,
  wrapperAddress: V21_WRAPPER,
  targetAccount: V21_TARGET_ACCOUNT,
  terminalizationTxHash: V21_TERMINAL_TX,
  terminalizationBlockNumber: V21_TERMINAL_BLOCK,
});

export const BANK_XCM_V22_OBSERVATION_MIGRATION = Object.freeze({
  requestId: V21_REQUEST_ID,
  wrapperAddress: V22_WRAPPER,
  settledAssets: V22_SETTLED_ASSETS,
  settledShares: V22_SETTLED_SHARES,
  failureCode: V22_FAILURE_CODE,
  source: V22_OBSERVATION_SOURCE,
  settledVia: V22_SETTLED_VIA
});
