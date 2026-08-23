import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const PROJECT_ID = "21fd0a11d3d39a36ec42a6599d4873bf";
const TEMPLATES = [
  new URL("../../deploy/backend.env.template", import.meta.url),
  new URL("../../deploy/backend.mainnet.env.template", import.meta.url),
];

function assignment(source, key) {
  const matches = source.match(new RegExp(`^${key}=(.*)$`, "gmu")) ?? [];
  assert.equal(matches.length, 1, `${key} must appear exactly once`);
  return matches[0].slice(key.length + 1);
}

test("WalletConnect project id and rollout flag bind both templates to the frontend build", async () => {
  const rootPackage = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  const build = rootPackage.scripts["build:frontend"];

  assert.match(build, /NEXT_PUBLIC_API_BASE_URL=https:\/\/api\.averray\.com NEXT_PUBLIC_WC_PROJECT_ID=/u);
  assert.match(build, new RegExp(`NEXT_PUBLIC_WC_PROJECT_ID=${PROJECT_ID}(?:\\s|$)`, "u"));
  assert.match(build, /NEXT_PUBLIC_WALLETCONNECT_ENABLED=false(?:\s|$)/u);

  for (const template of TEMPLATES) {
    const source = await readFile(template, "utf8");
    assert.equal(assignment(source, "NEXT_PUBLIC_WC_PROJECT_ID"), PROJECT_ID);
    assert.equal(assignment(source, "NEXT_PUBLIC_WALLETCONNECT_ENABLED"), "false");
  }
});

test("WalletConnect config is read only at the shared provider boundary and stays gated", async () => {
  const source = await readFile(
    new URL("../../app/lib/auth/wallet-provider.js", import.meta.url),
    "utf8"
  );
  assert.match(source, /process\.env\.NEXT_PUBLIC_WC_PROJECT_ID\?\.trim\(\)/u);
  assert.match(source, /process\.env\.NEXT_PUBLIC_WALLETCONNECT_ENABLED === "true"/u);
  assert.doesNotMatch(source, /21fd0a11d3d39a36ec42a6599d4873bf/u);
});

test("the bare WalletConnect provider is exactly pinned", async () => {
  const appPackage = JSON.parse(await readFile(new URL("../../app/package.json", import.meta.url), "utf8"));
  assert.equal(appPackage.dependencies["@walletconnect/ethereum-provider"], "2.19.1");
  assert.equal(appPackage.dependencies["@reown/appkit"], undefined);
});
