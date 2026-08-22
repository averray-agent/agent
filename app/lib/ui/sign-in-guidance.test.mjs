import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const signInPage = readFileSync(resolve(appRoot, "app", "sign-in", "page.tsx"), "utf8");
const walletGuidance = readFileSync(resolve(appRoot, "components", "auth", "WalletInstallGuidance.tsx"), "utf8");
const workJobDetail = readFileSync(resolve(appRoot, "components", "work", "WorkJobDetail.tsx"), "utf8");

test("sign-in explains wallet identity, install choices, and the no-email path above the action", () => {
  const guidance = signInPage.indexOf("<WalletInstallGuidance");
  const walletAction = signInPage.indexOf("onClick={handleSignIn}");

  assert.ok(guidance >= 0, "plain-language wallet guidance must be present");
  assert.ok(guidance < walletAction, "wallet guidance must render before the sign-in action");
  assert.match(walletGuidance, /Your wallet is your sign-in and account identity\./u);
  assert.match(walletGuidance, /href="https:\/\/metamask\.io\/download"[\s\S]*Install MetaMask/u);
  assert.match(walletGuidance, /href="https:\/\/talisman\.xyz\/download\/"[\s\S]*Install Talisman/u);
  assert.match(walletGuidance, /SIWE is the only sign-in door\. There is no email signup by design\./u);
  assert.match(walletGuidance, /href="https:\/\/averray\.com"[\s\S]*What is Averray\?/u);
});

test("no-provider sign-in is disabled and offers the public work escape hatch", () => {
  assert.match(signInPage, /disabled=\{pending \|\| walletProvider !== "available"\}/u);
  assert.match(signInPage, /Install a wallet to sign in/u);
  assert.match(signInPage, /showBrowseLink=\{walletProvider === "unavailable"\}/u);
  assert.match(walletGuidance, /href="\/work"[\s\S]*Browse paid work without a wallet →/u);
});

test("job detail reuses install guidance instead of leaving a dead wallet action", () => {
  assert.match(workJobDetail, /!auth\.authenticated && walletProvider === "unavailable"/u);
  assert.match(workJobDetail, /<WalletInstallGuidance provider=\{walletProvider\} showBrowseLink \/>/u);
});
