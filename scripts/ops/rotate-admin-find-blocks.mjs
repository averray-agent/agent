#!/usr/bin/env node

/**
 * Scan recent Asset Hub Paseo blocks for the Substrate tx hashes the
 * operator reported during the rotation, and report the block height +
 * extrinsic index + key events for each.
 *
 * Used to fill in the evidence JSON after the fact — Subscan now
 * requires an API key and pallet_multisig storage is cleared after
 * execution, so direct chain scans are the only free option.
 */

import { ApiPromise, WsProvider } from "@polkadot/api";

const WS = process.env.PASEO_AH_WS || "wss://sys.ibp.network/asset-hub-paseo";

// txs reported by the operator during the rotation, with the expected
// rough block range based on when they were signed.
const TARGETS = [
  { label: "Step 3b Hot Wallet countersign (setPauser exec)", hash: "0xb2cfee73a9b56b42e072137282416023f692b8942b5547377fb13b24d2e1642e" },
  { label: "Step 4b Hot Wallet countersign (setArbitrator batch exec)", hash: "0xe59a56011ff482414d02ab822a49a2b898387f43bc3746334c0087c0b1eec072" }
];

function parseArgs(argv) {
  const args = { from: undefined, to: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--from") args.from = Number(argv[++i]);
    else if (argv[i] === "--to") args.to = Number(argv[++i]);
    else if (argv[i] === "--target") args.targets = (args.targets || []).concat([argv[++i]]);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const api = await ApiPromise.create({ provider: new WsProvider(WS) });
  const finalizedHead = await api.rpc.chain.getFinalizedHead();
  const finalizedBlock = await api.rpc.chain.getBlock(finalizedHead);
  const headHeight = finalizedBlock.block.header.number.toNumber();

  const from = args.from ?? (headHeight - 3000);
  const to = args.to ?? headHeight;

  const targets = TARGETS.filter((t) => !args.targets || args.targets.includes(t.hash));
  const remaining = new Map(targets.map((t) => [t.hash.toLowerCase(), t]));

  console.log(`Scanning blocks ${from}..${to} on ${WS}`);
  console.log(`Targets: ${remaining.size}`);

  for (let h = to; h >= from && remaining.size > 0; h -= 1) {
    const hash = await api.rpc.chain.getBlockHash(h);
    const block = await api.rpc.chain.getBlock(hash);
    for (let i = 0; i < block.block.extrinsics.length; i += 1) {
      const xt = block.block.extrinsics[i];
      const xtHash = xt.hash.toHex().toLowerCase();
      if (remaining.has(xtHash)) {
        const target = remaining.get(xtHash);
        const signer = xt.signer.toString();
        const method = `${xt.method.section}.${xt.method.method}`;
        console.log("");
        console.log(`# ${target.label}`);
        console.log(`  txHash:          ${target.hash}`);
        console.log(`  blockNumber:     ${h}`);
        console.log(`  blockHash:       ${hash.toHex()}`);
        console.log(`  extrinsicIndex:  ${i}`);
        console.log(`  signer:          ${signer}`);
        console.log(`  method:          ${method}`);

        // Fetch events for this extrinsic
        const apiAt = await api.at(hash);
        const events = await apiAt.query.system.events();
        const xtEvents = events.filter((e) => e.phase.isApplyExtrinsic && e.phase.asApplyExtrinsic.eqn(i));
        const relevant = xtEvents
          .map((e) => `${e.event.section}.${e.event.method}`)
          .filter((s) => /multisig|revive|utility|system\.(Extrinsic|NewAccount)/.test(s));
        console.log(`  events:          ${relevant.join(", ")}`);
        const exec = xtEvents.find((e) => e.event.section === "multisig" && e.event.method === "MultisigExecuted");
        if (exec) {
          console.log(`  MultisigExecuted.result: ${JSON.stringify(exec.event.data.toJSON()).slice(0, 200)}`);
        }
        const success = xtEvents.find((e) => e.event.section === "system" && e.event.method === "ExtrinsicSuccess");
        const failed = xtEvents.find((e) => e.event.section === "system" && e.event.method === "ExtrinsicFailed");
        console.log(`  status:          ${success ? "ExtrinsicSuccess ✅" : failed ? "ExtrinsicFailed ❌" : "(unknown)"}`);

        remaining.delete(xtHash);
      }
    }
  }

  if (remaining.size > 0) {
    console.log("");
    console.log("Not found in scan range:");
    for (const t of remaining.values()) console.log(`  ${t.hash}  ${t.label}`);
    process.exitCode = 1;
  }

  await api.disconnect();
}

main().catch((e) => {
  console.error(e?.stack || e);
  process.exit(1);
});
