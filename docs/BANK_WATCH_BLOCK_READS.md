# Bank watch block reads

Read-pressure packet PR 3 (`1cec4b68`). The watch decodes `system.events` first;
only `RequestQueued` from the configured wrapper requires block extrinsics. It
uses `api.rpc.chain.getBlock.raw(blockHash)` and hashes the selected complete
SCALE-encoded extrinsic bytes with blake2-256. Unrelated extrinsics are not decoded.
Header, timestamp, event phase, and same-extrinsic `RequestParametersStored`
requirements remain in place.

Each failed block retains its hash, subscription records, and error in the runtime.
A single unreferenced timer retries pending blocks every five seconds (the existing
event-watch retry base). Later successful blocks cannot erase earlier failures.
`substrateEventFailedBlockHashes` makes outstanding failures visible in runtime
status. Staging reopens only after all pending blocks ingest. Missing block
provenance is not guessed: it keeps staging closed and requires operator investigation.
This is an in-process retry queue, not a durable historical replay cursor; the
existing explicit staged-request backfill remains the restart/offline recovery path.

## Historical hash proof

Read-only public RPC observation on 2026-09-25 using
`wss://asset-hub-polkadot-rpc.n.dwellir.com` and installed `@polkadot/api` 16.5.6:

- Cycle-2 recall staging block: **20942041**.
- Block hash: `0x14d86d25bc7e6225a5be1329858cfb98462ce35b199a697016bf0663e9d65e4e`.
- Wrapper: `0xf20b35a3f85ec864127b551ce8a64446fc0ed2bc`.
- Request: `0xdedbff352e07a40a734e092826356cf5be37434fc688e295c9be7d419ec70943`.
- Extrinsic index: **3**, format v4.
- Both raw blake2-256 and
  `api.at(hash).registry.createType('Extrinsic', bytes).hash.toHex()` returned
  `0x162278de9685ddfc24936307eb32761580bdc02072beee6de51eea2b7e5f874e`.

The raw bytes, matching wrapper event bytes, independently observed typed hash,
and provenance are pinned in
`mcp-server/src/services/fixtures/bank-request-queued-20942041.json`.
The offline test places deliberately undecodable unrelated extrinsics next to
this real extrinsic and still produces the recorded hash.

## Remaining client compatibility risk (D4)

Live metadata observed at Asset Hub head 21068619 reports `statemint`,
specVersion **2005000**, transactionVersion **15**, extrinsic versions **4 and 5**,
and transaction-extension sets **0 and 1**. Set 1 additionally includes
`VerifyMultiSignature`, `AsPgas`, `AsDotnsGateway`, and `RestrictOrigins`.
The installed 16.5.6 `GeneralExtrinsic` decoder uses
`registry.getSignedExtensionTypes()` for its layout; `TypeRegistry` flattens the
metadata's extension list, and `getTransactionExtensionVersion()` returns 0.
It does not select that layout from each general extrinsic's extension version.
This is a concrete compatibility risk, not proof that every v5 extrinsic fails.

The remaining backend typed Substrate full-block read is
`SubstrateSubsidyReader.#readBlock`: a subsidy proof can still encounter an
unrelated general extrinsic and fail decoding. It needs a separately verified
compatible decoder/client upgrade (or its own raw-byte path). A newer version is
not assumed to solve this without a failing-block fixture. This PR changes no
dependencies. EVM provider `getBlock` reads do not use `SignedBlock` decoding;
runtime event/storage reads still use block-specific metadata.

References: [chain RPC methods](https://polkadot.js.org/docs/polkadot/rpc/),
[extrinsic encoding and extension versions](https://paritytech.github.io/polkadot-sdk/master/polkadot_sdk_docs/reference_docs/extrinsic_encoding/index.html),
and [runtime metadata](https://docs.polkadot.com/develop/toolkit/parachains/rpc-calls/).
The public metadata observation and installed decoder source are the evidence
for the compatibility assessment; no production access or transaction was used.
