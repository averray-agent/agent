import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const signInPage = readFileSync(resolve(appRoot, "app", "sign-in", "page.tsx"), "utf8");
const walletGuidance = readFileSync(resolve(appRoot, "components", "auth", "WalletInstallGuidance.tsx"), "utf8");
const walletSignInFlow = readFileSync(resolve(appRoot, "components", "auth", "WalletSignInFlow.tsx"), "utf8");
const walletSessionNotice = readFileSync(resolve(appRoot, "components", "auth", "WalletSessionNotice.tsx"), "utf8");
const workJobDetail = readFileSync(resolve(appRoot, "components", "work", "WorkJobDetail.tsx"), "utf8");

test("sign-in explains wallet identity, install choices, and the no-email path above the action", () => {
  const guidance = walletSignInFlow.indexOf("<WalletInstallGuidance");
  const walletAction = walletSignInFlow.indexOf("function ConnectionButton");

  assert.ok(guidance >= 0, "plain-language wallet guidance must be present");
  assert.ok(guidance < walletAction, "wallet guidance must render before the sign-in action");
  assert.match(walletGuidance, /Your wallet is your sign-in and account identity\./u);
  assert.match(walletGuidance, /href="https:\/\/metamask\.io\/download"[\s\S]*Install MetaMask/u);
  assert.match(walletGuidance, /href="https:\/\/talisman\.xyz\/download\/"[\s\S]*Install Talisman/u);
  assert.match(walletGuidance, /SIWE is the only sign-in door\. There is no email signup by design\./u);
  assert.match(walletGuidance, /href="https:\/\/averray\.com"[\s\S]*What is Averray\?/u);
});

test("no-provider sign-in is disabled and offers the public work escape hatch", () => {
  assert.match(walletSignInFlow, /disabled=\{disabled \|\| Boolean\(preparing\) \|\| !injectedReady\}/u);
  assert.match(walletSignInFlow, /!injectedReady && !walletConnectReady/u);
  assert.match(walletSignInFlow, /<WalletInstallGuidance provider=\{wallet\.availability\} showBrowseLink \/>/u);
  assert.match(walletGuidance, /href="\/work"[\s\S]*Browse paid work without a wallet →/u);
});

test("job detail uses the shared provider flow instead of leaving a dead wallet action", () => {
  assert.match(workJobDetail, /!auth\.authenticated[\s\S]*<WalletSignInFlow/u);
  assert.doesNotMatch(workJobDetail, /window\.ethereum|getInjectedProvider/u);
});

test("desktop injected sign-in stays first and WalletConnect remains a gated alternative", () => {
  const desktop = walletSignInFlow.slice(
    walletSignInFlow.indexOf('className={walletConnectReady ? "hidden gap-2 md:grid"'),
    walletSignInFlow.indexOf("!injectedReady && !walletConnectReady")
  );
  assert.ok(desktop.indexOf('begin("injected")') < desktop.indexOf('begin("walletconnect")'));
  assert.match(walletSignInFlow, /wallet\.walletConnectAvailable/u);
  assert.match(walletSignInFlow, /Connect a mobile wallet/u);
  assert.match(walletSignInFlow, /MetaMask mobile/u);
});

test("SIWE expiry and wallet-pairing expiry are separate, user-action surfaces", () => {
  assert.match(signInPage, /data-session-expiry="siwe"/u);
  assert.match(walletSessionNotice, /data-session-expiry="walletconnect"/u);
  assert.match(walletSessionNotice, /Disconnect wallet pairing/u);
  assert.match(walletSignInFlow, /Sign this message/u);
  assert.match(walletSignInFlow, /No signature was made\./u);
  assert.doesNotMatch(`${signInPage}\n${walletSignInFlow}\n${walletSessionNotice}`, /link your account/iu);
});
