import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const signInPage = readFileSync(resolve(appRoot, "app", "sign-in", "page.tsx"), "utf8");

test("sign-in explains wallet identity, install choices, and the no-email path above the action", () => {
  const guidance = signInPage.indexOf("data-wallet-guidance");
  const walletAction = signInPage.indexOf("onClick={handleSignIn}");

  assert.ok(guidance >= 0, "plain-language wallet guidance must be present");
  assert.ok(guidance < walletAction, "wallet guidance must render before the sign-in action");
  assert.match(signInPage, /Your wallet is your sign-in and account identity\./u);
  assert.match(signInPage, /href="https:\/\/metamask\.io\/download"[\s\S]*MetaMask/u);
  assert.match(signInPage, /href="https:\/\/talisman\.xyz\/download\/"[\s\S]*Talisman/u);
  assert.match(signInPage, /There is no email signup\./u);
  assert.match(signInPage, /href="https:\/\/averray\.com"[\s\S]*What is Averray\?/u);
});
