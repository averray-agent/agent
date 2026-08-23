import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { loadBlockchainConfig } from "../../mcp-server/src/blockchain/config.js";

const PROFILES = [
  {
    name: "testnet",
    template: new URL("../../deploy/backend.env.template", import.meta.url),
    manifest: new URL("../../deployments/testnet.json", import.meta.url),
    deploymentKey: "escrowCore"
  },
  {
    name: "mainnet",
    template: new URL("../../deploy/backend.mainnet.env.template", import.meta.url),
    manifest: new URL("../../deployments/mainnet.json", import.meta.url),
    deploymentKey: "escrowCoreV3"
  }
];

test("both backend templates bind CHAIN_EVM_FLOOR_BLOCK to their escrow deployment anchor", async () => {
  for (const profile of PROFILES) {
    const source = await readFile(profile.template, "utf8");
    const assignments = source.match(/^CHAIN_EVM_FLOOR_BLOCK=(\d+)$/gmu) ?? [];
    assert.equal(assignments.length, 1, `${profile.name} template must bind exactly one EVM floor`);

    const manifest = JSON.parse(await readFile(profile.manifest, "utf8"));
    const expected = Number(manifest.deploymentBlocks?.[profile.deploymentKey]);
    const configured = Number(assignments[0].split("=")[1]);
    assert.equal(configured, expected, `${profile.name} floor must match deploymentBlocks.${profile.deploymentKey}`);
    assert.equal(
      loadBlockchainConfig({ CHAIN_EVM_FLOOR_BLOCK: String(configured) }).chainEvmFloorBlock,
      expected,
      `${profile.name} template value must reach the gateway config unchanged`
    );
  }
});
