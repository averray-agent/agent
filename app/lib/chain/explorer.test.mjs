import test from "node:test";
import assert from "node:assert/strict";

import {
  CHAINS,
  DEFAULT_CHAIN_KEY,
  DEFAULT_EXPLORER,
  activeChain,
  resolveChain,
  isTxHash,
  isEvmAddress,
  isBlockNumber,
  explorerTxUrl,
  explorerBlockUrl,
  explorerAddressUrl,
  explorerUrl,
  shortenAnchor,
} from "./explorer.js";

// Real on-chain anchors from docs/evidence (dispute-verdict-proof-2026-05-27).
const TESTNET_TX =
  "0x3632c402966de8bf7dda55fb88627a9fa1019d9a867017008cf02b2ce02d7472";
const ADDRESS = "0x1234567890abcdef1234567890abcdef12345678";
// A chainJobId is also 0x+64 hex — shape-identical to a tx hash. The
// guard intentionally CANNOT distinguish it; provenance is the caller's
// job. This constant documents that trap.
const CHAIN_JOB_ID =
  "0x46519cdd46ce82dccff06907c750c625c8f3fa2537ec855cfe02966586c593aa";

test("shape guards accept genuine anchors and reject malformed ones", () => {
  assert.equal(isTxHash(TESTNET_TX), true);
  assert.equal(isTxHash(CHAIN_JOB_ID), true); // documents the shape collision
  assert.equal(isTxHash("0x1234"), false);
  assert.equal(isTxHash(`${TESTNET_TX}ff`), false);
  assert.equal(isTxHash(123), false);

  assert.equal(isEvmAddress(ADDRESS), true);
  assert.equal(isEvmAddress(TESTNET_TX), false); // too long for an address
  assert.equal(isEvmAddress("0xnothex"), false);

  assert.equal(isBlockNumber(9387753), true);
  assert.equal(isBlockNumber("9387753"), true);
  assert.equal(isBlockNumber(-1), false);
  assert.equal(isBlockNumber(1.5), false);
  assert.equal(isBlockNumber("0x10"), false);
});

test("testnet (Paseo) Subscan URLs resolve to assethub-paseo subdomain", () => {
  assert.equal(
    explorerTxUrl("paseo", TESTNET_TX),
    `https://assethub-paseo.subscan.io/tx/${TESTNET_TX}`,
  );
  assert.equal(
    explorerBlockUrl("paseo", 9387753),
    "https://assethub-paseo.subscan.io/block/9387753",
  );
  assert.equal(
    explorerAddressUrl("paseo", ADDRESS),
    `https://assethub-paseo.subscan.io/account/${ADDRESS}`,
  );
});

test("mainnet (Polkadot Hub) Subscan URLs resolve to assethub-polkadot subdomain", () => {
  assert.equal(
    explorerTxUrl("polkadot", TESTNET_TX),
    `https://assethub-polkadot.subscan.io/tx/${TESTNET_TX}`,
  );
  assert.equal(
    explorerBlockUrl("polkadot", 9387753),
    "https://assethub-polkadot.subscan.io/block/9387753",
  );
  assert.equal(
    explorerAddressUrl("polkadot", ADDRESS),
    `https://assethub-polkadot.subscan.io/account/${ADDRESS}`,
  );
});

test("Blockscout uses EVM-native /address path and testnet/mainnet origins", () => {
  assert.equal(
    explorerTxUrl("paseo", TESTNET_TX, { explorer: "blockscout" }),
    `https://blockscout-testnet.polkadot.io/tx/${TESTNET_TX}`,
  );
  assert.equal(
    explorerAddressUrl("paseo", ADDRESS, { explorer: "blockscout" }),
    `https://blockscout-testnet.polkadot.io/address/${ADDRESS}`,
  );
  assert.equal(
    explorerTxUrl("polkadot", TESTNET_TX, { explorer: "blockscout" }),
    `https://blockscout.polkadot.io/tx/${TESTNET_TX}`,
  );
});

test("builders fail closed (null) on unknown chain or malformed value", () => {
  // Unknown / unset chain → no link.
  assert.equal(explorerTxUrl("", TESTNET_TX), null);
  assert.equal(explorerTxUrl("ethereum", TESTNET_TX), null);
  assert.equal(explorerTxUrl(undefined, TESTNET_TX), null);
  // Wrong shape for the kind → no link.
  assert.equal(explorerTxUrl("paseo", "not-a-hash"), null);
  assert.equal(explorerBlockUrl("paseo", "abc"), null);
  assert.equal(explorerAddressUrl("paseo", TESTNET_TX), null);
});

test("explorerUrl dispatcher matches the kind-specific builders", () => {
  assert.equal(
    explorerUrl("tx", "paseo", TESTNET_TX),
    explorerTxUrl("paseo", TESTNET_TX),
  );
  assert.equal(
    explorerUrl("block", "polkadot", 42),
    explorerBlockUrl("polkadot", 42),
  );
  assert.equal(
    explorerUrl("address", "paseo", ADDRESS),
    explorerAddressUrl("paseo", ADDRESS),
  );
  assert.equal(explorerUrl("nope", "paseo", TESTNET_TX), null);
});

test("registry and defaults are internally consistent", () => {
  assert.equal(DEFAULT_EXPLORER, "subscan");
  assert.ok(CHAINS[DEFAULT_CHAIN_KEY]);
  assert.equal(CHAINS.polkadot.isMainnet, true);
  assert.equal(CHAINS.paseo.isMainnet, false);
  assert.equal(resolveChain("PASEO").key, "paseo"); // case-insensitive
  assert.equal(resolveChain("nope"), null);
});

test("activeChain: unset → Paseo default; unknown → null (fail closed); known → that chain", () => {
  const saved = process.env.NEXT_PUBLIC_CHAIN_ENV;
  try {
    delete process.env.NEXT_PUBLIC_CHAIN_ENV;
    assert.equal(activeChain().key, "paseo");

    process.env.NEXT_PUBLIC_CHAIN_ENV = "polkadot";
    assert.equal(activeChain().key, "polkadot");

    process.env.NEXT_PUBLIC_CHAIN_ENV = "mystery-net";
    assert.equal(activeChain(), null);
  } finally {
    if (saved === undefined) delete process.env.NEXT_PUBLIC_CHAIN_ENV;
    else process.env.NEXT_PUBLIC_CHAIN_ENV = saved;
  }
});

test("shortenAnchor truncates long hashes, passes short values through", () => {
  assert.equal(shortenAnchor(TESTNET_TX), "0x3632c402…7472");
  assert.equal(shortenAnchor("9387753"), "9387753");
  assert.equal(shortenAnchor("0xabcd"), "0xabcd");
});
