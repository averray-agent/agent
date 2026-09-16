import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { Interface, encodeBytes32String } from "ethers";
import { arbitrationSigningState, sendPreparedArbitration, arbitrationWalletOptions } from "./arbitration.js";
const account = `0x${"aa".repeat(20)}`;
const decoded = { jobId: `0x${"11".repeat(32)}`, workerPayout: "1800000", reasonCode: encodeBytes32String("DISPUTE_OVERTURNED"), metadataURI: "https://api.example.test/content/reasoning" };
const prepared = { to: `0x${"bb".repeat(20)}`, chainId: 420420419, arbitrator: account, preparationId: "current", decoded,
  data: new Interface(["function resolveDispute(bytes32,uint256,bytes32,string)"]).encodeFunctionData("resolveDispute", Object.values(decoded)) };
const live = { state: 5, escrow: prepared.to, remainingPayoutRaw: "1800000", preparationId: "current", arbitrator: account, chainId: 420420419 };
const valid = { prepared, live, account, chainId: 420420419 };

test("arbitration pin 3: sign disabled for wrong account, chain, state, payout, authority, or stale preparation", () => {
  assert.equal(arbitrationSigningState(valid).allowed, true);
  for (const change of [
    { account: `0x${"cc".repeat(20)}` }, { account: null }, { chainId: 1 },
    ...[0, 3, 4, 6, null].map((state) => ({ live: { ...live, state } })),
    { live: { ...live, remainingPayoutRaw: "1799999" } }, { live: { ...live, preparationId: "superseded" } },
    { live: { ...live, arbitrator: `0x${"cc".repeat(20)}` } }, { prepared: { ...prepared, data: "0x" } },
    { prepared: { ...prepared, value: "1" } }
  ]) assert.equal(arbitrationSigningState({ ...valid, ...change }).allowed, false, JSON.stringify(change));
});

test("sign click rereads wallet and live state before passing only the prepared calldata to the wallet", async () => {
  let current = live, selected = account;
  const calls = [];
  const input = { prepared, provider: { request: async ({ method }) => method === "eth_accounts" ? [selected] : "0x190f1b43" },
    getLive: async () => current, sendTransaction: async (tx) => calls.push(tx) };
  // A wallet/account change after render cannot use the previous green button.
  selected = `0x${"cc".repeat(20)}`;
  await assert.rejects(sendPreparedArbitration(input), /arbitrator wallet/);
  selected = account; current = { ...live, state: 6 };
  await assert.rejects(sendPreparedArbitration(input), /Disputed/);
  assert.equal(calls.length, 0);
  current = live;
  await sendPreparedArbitration(input);
  assert.deepEqual(calls, [{ from: account, to: prepared.to, data: prepared.data, value: "0x0" }]);
});

test("arbitration pin 7: missing WalletConnect configuration explains and retains injected signing; configured offers pairing", () => {
  const missing = arbitrationWalletOptions(false), configured = arbitrationWalletOptions(true);
  assert.equal(missing.injected, true); assert.equal(missing.walletConnect, false);
  assert.match(missing.notice, /NEXT_PUBLIC_WC_PROJECT_ID/); assert.match(missing.notice, /injected/);
  assert.equal(configured.walletConnect, true); assert.equal(configured.injected, true);
  assert.match(configured.notice, /phone/);
});

test("drawer wires guarded signing, both wallet options, and prepare without a backend verdict POST", () => {
  const panel = readFileSync(new URL("../../components/disputes/ArbitrationSigningPanel.tsx", import.meta.url), "utf8");
  const drawer = readFileSync(new URL("../../components/disputes/DisputeDrawerBody.tsx", import.meta.url), "utf8");
  assert.match(panel, /disabled=\{!guard.allowed \|\| sending \|\| Boolean\(txHash\)\}/);
  assert.match(panel, /options.walletConnect && <button[^>]+[\s\S]*?connect\("walletconnect"\)/);
  assert.match(panel, /options.injected && <button[^>]+[\s\S]*?connect\("injected"\)/);
  assert.match(panel, /options.notice/);
  assert.match(panel, /sendPreparedArbitration\(\{ prepared, provider, sendTransaction: sendWalletTransaction/);
  assert.match(drawer, /if \(hardware\) \{[\s\S]*?\/prepare[\s\S]*?return;/);
  const human = readFileSync(new URL("../../components/sessions/HumanVerdictPanel.tsx", import.meta.url), "utf8");
  assert.match(human, /key.startsWith\("\/session"\)/, "refresh singular /session?sessionId= detail as well as timeline and list");
});
