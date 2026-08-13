#!/usr/bin/env node
/**
 * Read-only CreditPool door walkthrough. Fetches info and unsigned templates,
 * then independently decodes every byte before printing. It never signs,
 * broadcasts, or accepts a private key.
 */
import { Interface } from "ethers";
import { CREDIT_POOL_ABI, DEPOSIT_POOL_V2_ABI, ERC20_MOCK_ABI } from "../../mcp-server/src/blockchain/abis.js";

const interfaces = [new Interface(CREDIT_POOL_ABI), new Interface(DEPOSIT_POOL_V2_ABI), new Interface(ERC20_MOCK_ABI)];

export function verifyCreditTemplate(template) {
  let parsed;
  for (const candidate of interfaces) {
    try { parsed = candidate.parseTransaction({ data: template.data, value: template.value }); break; } catch { /* next ABI */ }
  }
  if (!parsed) throw new Error(`template ${template.step} does not decode under a served contract ABI`);
  const advertised = String(template.decoded?.function ?? "").split("(")[0];
  if (parsed.name !== advertised) throw new Error(`template ${template.step} decoded ${parsed.name}, advertised ${advertised}`);
  if (template.unsigned !== true || String(template.value) !== "0") throw new Error(`template ${template.step} violates unsigned zero-value boundary`);
  return { step: template.step, function: parsed.signature, args: parsed.args.toArray().map(String) };
}

function parseArgs(argv) {
  const output = { baseUrl: "https://api.averray.com", input: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--base-url") output.baseUrl = argv[++index];
    else if (argv[index] === "--token") output.token = argv[++index];
    else if (argv[index] === "--input") output.input = JSON.parse(argv[++index]);
  }
  return output;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.token) throw new Error("--token is required (SIWE wallet bearer token; never a private key)");
  if (!args.input) throw new Error("--input is required as JSON, for example '{\"direction\":\"borrow\",\"pledgeShares\":\"10000000\",\"amount\":\"8000000\"}'");
  const headers = { authorization: `Bearer ${args.token}`, "content-type": "application/json" };
  const infoResponse = await fetch(new URL("/credit", args.baseUrl), { headers });
  const info = await infoResponse.json();
  if (!infoResponse.ok || info.available !== true) throw new Error(`getCreditInfo refused: ${JSON.stringify(info)}`);
  const buildResponse = await fetch(new URL("/credit/transactions", args.baseUrl), { method: "POST", headers, body: JSON.stringify(args.input) });
  const built = await buildResponse.json();
  if (!buildResponse.ok || built.available !== true) throw new Error(`buildCreditTransactions refused: ${JSON.stringify(built)}`);
  if (info.creditPool !== built.creditPool || info.depositPool !== built.depositPool || !Number.isSafeInteger(built.block?.number)) {
    throw new Error("door info and templates are not bound to the same configured pool generation and a named quote block");
  }
  console.log(JSON.stringify({ info, built, independentlyDecoded: built.templates.map(verifyCreditTemplate) }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => { console.error(`CreditPool walkthrough failed: ${error.message}`); process.exitCode = 1; });
}
