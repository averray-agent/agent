import assert from "node:assert/strict";
import test from "node:test";

import { claimActionReadiness } from "../work/claim-readiness.js";
import { withdrawalTransactionFromIntent } from "../work/wallet-transaction.js";
import { completeSiwe, prepareSiwe } from "./siwe-core.js";
import {
  HUB_CHAIN_ID,
  HUB_CHAIN_REFERENCE,
  WALLET_PROVIDER_STORAGE_KEY,
  WalletPairingExpiredError,
  createWalletProviderController,
} from "./wallet-provider.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const TARGET = "0x2222222222222222222222222222222222222222";

class MemoryStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, value); }
  removeItem(key) { this.values.delete(key); }
}

class MockProvider {
  constructor({ connected = false, chains = [HUB_CHAIN_REFERENCE], connectPending = false } = {}) {
    this.connected = connected;
    this.accounts = [WALLET];
    this.session = connected ? this.makeSession(chains) : undefined;
    this.chains = chains;
    this.connectPending = connectPending;
    this.listeners = new Map();
    this.requests = [];
    this.disconnectCalls = 0;
    this.signer = {
      abortPairingAttempt: () => { this.aborted = true; },
      cleanupPendingPairings: async () => undefined,
    };
  }

  makeSession(chains) {
    return {
      expiry: Math.floor(Date.now() / 1_000) + 3_600,
      namespaces: { eip155: { chains, accounts: chains.map((chain) => `${chain}:${WALLET}`) } },
    };
  }

  on(event, listener) {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  emit(event, value) {
    for (const listener of this.listeners.get(event) ?? []) listener(value);
  }

  async connect() {
    const expiryTimestamp = Math.floor(Date.now() / 1_000) + 300;
    this.emit("display_uri", `wc:test@2?expiryTimestamp=${expiryTimestamp}&symKey=abc`);
    if (this.connectPending) return new Promise(() => undefined);
    this.connected = true;
    this.session = this.makeSession(this.chains);
  }

  async request(args) {
    this.requests.push(args);
    if (args.method === "eth_accounts" || args.method === "eth_requestAccounts") return this.accounts;
    if (args.method === "personal_sign") return "0xsigned";
    if (args.method === "eth_sendTransaction") return "0xtransaction";
    if (args.method === "eth_chainId") return `0x${HUB_CHAIN_ID.toString(16)}`;
    return null;
  }

  async disconnect() {
    this.disconnectCalls += 1;
    this.connected = false;
  }
}

function makeController({ provider = new MockProvider(), storage = new MemoryStorage(), schedule } = {}) {
  let initOptions;
  const controller = createWalletProviderController({
    currentWindow: () => ({ location: { origin: "https://app.averray.test" } }),
    storage: () => storage,
    projectId: "test-project-id",
    walletConnectEnabled: true,
    createWalletConnectProvider: async (options) => {
      initOptions = options;
      return provider;
    },
    schedule,
  });
  return { controller, provider, storage, getInitOptions: () => initOptions };
}

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

test("WalletConnect pairing declares Polkadot Hub as required and persists the selected transport", async () => {
  const { controller, provider, storage, getInitOptions } = makeController();
  const states = [];
  controller.subscribe((snapshot) => states.push(snapshot.status));

  const active = await controller.connect("walletconnect");
  assert.equal(active.kind, "walletconnect");
  assert.ok(states.includes("pairing"));
  assert.deepEqual(getInitOptions().chains, [HUB_CHAIN_ID]);
  assert.ok(getInitOptions().methods.includes("personal_sign"));
  assert.ok(getInitOptions().methods.includes("eth_sendTransaction"));
  assert.equal(getInitOptions().showQrModal, false);
  assert.deepEqual(JSON.parse(storage.getItem(WALLET_PROVIDER_STORAGE_KEY)), { version: 1, kind: "walletconnect" });

  await controller.disconnect();
  assert.equal(provider.disconnectCalls, 1);
  assert.equal(storage.getItem(WALLET_PROVIDER_STORAGE_KEY), null);
});

test("an existing WalletConnect session restores without pairing or signing", async () => {
  const storage = new MemoryStorage();
  storage.setItem(WALLET_PROVIDER_STORAGE_KEY, JSON.stringify({ version: 1, kind: "walletconnect" }));
  const provider = new MockProvider({ connected: true });
  const { controller } = makeController({ provider, storage });

  const restored = await controller.restore();
  assert.equal(restored.kind, "walletconnect");
  assert.deepEqual(provider.requests.map(({ method }) => method), ["eth_accounts"]);
  assert.equal(controller.getSnapshot().status, "connected");
  await controller.disconnect();
});

test("a stale WalletConnect selection never opens an invisible pairing from a transaction path", async () => {
  const storage = new MemoryStorage();
  storage.setItem(WALLET_PROVIDER_STORAGE_KEY, JSON.stringify({ version: 1, kind: "walletconnect" }));
  const provider = new MockProvider({ connected: false });
  let connectCalls = 0;
  provider.connect = async () => { connectCalls += 1; };
  const { controller } = makeController({ provider, storage });

  await assert.rejects(controller.getActive(), /pairing is no longer active/u);
  assert.equal(connectCalls, 0);
});

test("pairing expiry is named and never reaches a signature request", async () => {
  let expire;
  const provider = new MockProvider({ connectPending: true });
  const { controller } = makeController({
    provider,
    schedule: (callback) => {
      expire = callback;
      return 1;
    },
  });
  const connecting = controller.connect("walletconnect");
  await new Promise((resolve) => setImmediate(resolve));
  expire();
  await assert.rejects(connecting, WalletPairingExpiredError);
  assert.equal(controller.getSnapshot().errorCode, "wallet_pairing_expired");
  assert.equal(provider.requests.some(({ method }) => method === "personal_sign"), false);
});

test("a WalletConnect session that omits Polkadot Hub reaches the named chain refusal state", async () => {
  const provider = new MockProvider({ chains: ["eip155:1"] });
  const { controller } = makeController({ provider });
  await assert.rejects(
    controller.connect("walletconnect"),
    (error) => error?.code === "wallet_chain_refused" && /Polkadot Hub/u.test(error.message)
  );
  assert.equal(controller.getSnapshot().status, "chain_refused");
});

test("a restored session that omits Polkadot Hub keeps the named chain refusal", async () => {
  const storage = new MemoryStorage();
  storage.setItem(WALLET_PROVIDER_STORAGE_KEY, JSON.stringify({ version: 1, kind: "walletconnect" }));
  const provider = new MockProvider({ connected: true, chains: ["eip155:1"] });
  const { controller } = makeController({ provider, storage });

  assert.equal(await controller.restore(), null);
  assert.equal(controller.getSnapshot().status, "chain_refused");
  assert.equal(controller.getSnapshot().errorCode, "wallet_chain_refused");
});

test("WalletConnect expiry is distinct from explicit disconnect", async () => {
  const { controller, provider } = makeController();
  await controller.connect("walletconnect");
  provider.emit("session_delete", { topic: "expired" });
  assert.equal(controller.getSnapshot().status, "session_expired");
  assert.equal(controller.getSnapshot().errorCode, "wallet_session_expired");

  const second = makeController();
  await second.controller.connect("walletconnect");
  await second.controller.disconnect();
  assert.equal(second.controller.getSnapshot().status, "idle");
  assert.equal(second.controller.getSnapshot().errorCode, null);
});

test("provider readiness is transport-neutral and stays fail closed", () => {
  const base = {
    authenticated: false,
    publiclyListed: true,
    definitionReady: true,
    schemaReady: true,
    schemaFailed: false,
    walletChecksLoading: false,
    walletChecksFailed: false,
    eligible: true,
    refusalReason: null,
  };
  const injected = createWalletProviderController({
    currentWindow: () => ({ ethereum: new MockProvider() }),
  });
  const walletConnect = makeController().controller;
  const snapshots = {
    injected: injected.inspect(),
    walletconnect: walletConnect.inspect(),
  };
  for (const [transport, snapshot] of Object.entries(snapshots)) {
    assert.equal(
      claimActionReadiness({ ...base, providerAvailable: snapshot.availability === "available" }).enabled,
      true,
      `${transport} must satisfy the same provider readiness gate`
    );
  }
  assert.equal(claimActionReadiness({ ...base, providerAvailable: false }).enabled, false);
});

test("mock full loop pairs, signs SIWE, builds a withdrawal, and sends it over the same provider", async () => {
  const { controller, provider } = makeController();
  const active = await controller.connect("walletconnect");
  const fetcher = async (url) => url.endsWith("/nonce")
    ? response(200, { message: "app.averray.test wants you to sign in\nNonce: abc" })
    : response(200, { token: "jwt", wallet: WALLET, expiresAt: "2099-01-01T00:00:00.000Z", roles: ["worker"] });
  const prepared = await prepareSiwe({ provider: active.provider, fetcher, nonceUrl: "https://api.test/auth/nonce" });
  const session = await completeSiwe({ prepared, fetcher, verifyUrl: "https://api.test/auth/verify" });
  assert.equal(session.wallet, WALLET);

  const buildWithdrawal = async () => ({
    chainId: HUB_CHAIN_ID,
    templates: [{ step: "withdraw", unsigned: true, from: WALLET, to: TARGET, data: "0x1234" }],
  });
  const intent = await buildWithdrawal();
  const transaction = withdrawalTransactionFromIntent(intent, session.wallet);
  assert.ok(transaction);
  assert.equal(await controller.sendTransaction(transaction), "0xtransaction");

  assert.deepEqual(
    provider.requests.map(({ method }) => method),
    ["eth_accounts", "eth_requestAccounts", "personal_sign", "eth_sendTransaction"]
  );
  await controller.disconnect();
});
