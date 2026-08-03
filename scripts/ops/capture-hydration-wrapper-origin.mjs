#!/usr/bin/env node

/** Read-only, two-endpoint LocationToAccountApi conversion evidence. */

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getAddress } from "ethers";

import { BANK_XCM_V2, wrapperAccountId32 } from "./bank-xcm-v2-ceremony-lib.mjs";

export function parseArgs(argv) {
  const args = { endpoints: [...BANK_XCM_V2.hydrationConversionEndpoints] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--wrapper") args.wrapper = argv[++index];
    else if (token === "--endpoint") {
      if (!args.endpointOverride) args.endpoints = [];
      args.endpointOverride = true;
      args.endpoints.push(argv[++index]);
    } else if (token === "--out") args.out = argv[++index];
    else if (token === "--help" || token === "-h") args.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return args;
}

function locationForWrapper(wrapper) {
  return {
    V4: {
      parents: 1,
      interior: {
        X2: [
          { Parachain: BANK_XCM_V2.assetHubParaId },
          { AccountId32: { network: null, id: wrapperAccountId32(wrapper) } }
        ]
      }
    }
  };
}

function unwrapAccount(result) {
  if (result?.isNone === true) throw new Error("LocationToAccountApi returned None.");
  const value = result?.isSome === true ? result.unwrap() : result;
  let hex = value?.toHex?.() ?? String(value);
  // Hydration's runtime API returns the AccountId enum SCALE encoding. The
  // 0x00 discriminant is AccountId32; retain only its 32-byte payload.
  if (/^0x00[0-9a-f]{64}$/iu.test(hex)) hex = `0x${hex.slice(4)}`;
  if (!/^0x[0-9a-f]{64}$/iu.test(hex)) throw new Error(`convert_location returned unexpected value ${hex}.`);
  return hex.toLowerCase();
}

export async function convertOnEndpoint({ endpoint, location, apiFactory }) {
  const api = await apiFactory(endpoint);
  try {
    const chain = String(await api.rpc.system.chain());
    if (!/hydration/iu.test(chain)) throw new Error(`endpoint reports ${chain}, not Hydration.`);
    const method = api.call?.locationToAccountApi?.convertLocation;
    if (typeof method !== "function") throw new Error("runtime does not expose LocationToAccountApi.convert_location.");
    const converted = unwrapAccount(await method(location));
    return {
      endpoint,
      chain,
      genesisHash: api.genesisHash.toHex(),
      convertedAccountId32: converted,
      observedAt: new Date().toISOString()
    };
  } finally {
    await api.disconnect?.();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log("Usage: node scripts/ops/capture-hydration-wrapper-origin.mjs --wrapper 0x... --out /tmp/conversion.json [--endpoint wss://... --endpoint wss://...]");
    return;
  }
  if (!args.wrapper || !args.out) throw new Error("--wrapper and --out are required.");
  if (args.endpoints.length < 2 || new Set(args.endpoints).size < 2) throw new Error("two independent endpoints are required.");
  const wrapper = getAddress(args.wrapper);
  const location = locationForWrapper(wrapper);
  const { ApiPromise, WsProvider } = await import("@polkadot/api");
  const apiFactory = (endpoint) => ApiPromise.create({ provider: new WsProvider(endpoint), noInitWarn: true, throwOnConnect: true });
  const reads = [];
  for (const endpoint of args.endpoints) reads.push(await convertOnEndpoint({ endpoint, location, apiFactory }));
  const values = new Set(reads.map((entry) => entry.convertedAccountId32));
  if (values.size !== 1) throw new Error(`independent convert_location reads disagree: ${JSON.stringify(reads)}.`);
  const evidence = {
    schemaVersion: 1,
    kind: "averray.hydrationLocationConversion",
    profile: "mainnet",
    wrapper,
    assetHubOriginAccountId32: wrapperAccountId32(wrapper),
    location,
    reads,
    convertedAccountId32: reads[0].convertedAccountId32
  };
  await writeFile(resolve(args.out), `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
  console.log(JSON.stringify(evidence, null, 2));
  console.log(`\nMATCH: both endpoints derived ${evidence.convertedAccountId32}; evidence written create-only to ${resolve(args.out)}.`);
  return evidence;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(`capture-hydration-wrapper-origin failed: ${error.message}`);
    process.exitCode = 1;
  });
}
