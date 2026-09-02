#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Contract, Interface, JsonRpcProvider, Wallet, getAddress, isAddress } from "ethers";

const TREASURY_POLICY_ABI = [
  "function owner() view returns (address)",
  "function pauser() view returns (address)",
  "function paused() view returns (bool)",
  "function setPaused(bool)",
  "function setPauser(address)",
  "function setVerifier(address,bool)",
  "function setServiceOperator(address,bool)",
  "function transferOwnership(address)",
  "function verifiers(address) view returns (bool)",
  "function arbitrators(address) view returns (bool)",
  "function serviceOperators(address) view returns (bool)"
];

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    profile: process.env.PROFILE || "testnet",
    manifest: process.env.DEPLOYMENT_MANIFEST || "",
    out: process.env.PAUSER_REHEARSAL_EVIDENCE_FILE || "",
    live: parseBoolean(process.env.PAUSER_REHEARSAL_LIVE),
    requireDedicatedPauser: parseBoolean(process.env.REQUIRE_DEDICATED_PAUSER),
    allowStartPaused: parseBoolean(process.env.ALLOW_START_PAUSED)
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--profile":
        options.profile = requireValue(argv, ++i, arg);
        break;
      case "--manifest":
        options.manifest = requireValue(argv, ++i, arg);
        break;
      case "--out":
        options.out = requireValue(argv, ++i, arg);
        break;
      case "--live":
        options.live = true;
        break;
      case "--require-dedicated-pauser":
        options.requireDedicatedPauser = true;
        break;
      case "--allow-start-paused":
        options.allowStartPaused = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

export function evaluateDedicatedPauser({ pauser, owner, deployer, verifier, arbitrator }) {
  const overlaps = [];
  const pauserAddress = normalizeAddress(pauser);
  const candidates = [
    ["owner", owner],
    ["deployer", deployer],
    ["verifier", verifier],
    ["arbitrator", arbitrator]
  ];

  for (const [role, address] of candidates) {
    if (address && sameAddress(pauserAddress, address)) overlaps.push(role);
  }

  return {
    dedicated: overlaps.length === 0,
    overlaps,
    severity: overlaps.length === 0 ? "ok" : overlaps.includes("owner") ? "error" : "warning"
  };
}

export async function runPauserRehearsal(options, env = process.env) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const manifestPath = options.manifest
    ? path.resolve(options.manifest)
    : path.join(repoRoot, "deployments", `${options.profile}.json`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const rpcUrl = env.RPC_URL || manifest.rpcUrl;
  const treasuryPolicy = normalizeAddress(manifest.contracts?.treasuryPolicy);
  const expectedOwner = normalizeAddress(manifest.owner);
  const expectedPauser = normalizeAddress(manifest.pauser);
  const expectedVerifier = normalizeAddress(manifest.verifier);
  const expectedArbitrator = normalizeAddress(manifest.arbitrator);
  const deployer = manifest.deployer ? normalizeAddress(manifest.deployer) : "";

  if (!rpcUrl) throw new Error("RPC_URL is required, either in env or deployment manifest.");
  if (!treasuryPolicy) throw new Error("deployment manifest is missing contracts.treasuryPolicy.");
  if (!expectedOwner) throw new Error("deployment manifest is missing owner.");
  if (!expectedPauser) throw new Error("deployment manifest is missing pauser.");

  const provider = new JsonRpcProvider(rpcUrl);
  const policy = new Contract(treasuryPolicy, TREASURY_POLICY_ABI, provider);
  const iface = new Interface(TREASURY_POLICY_ABI);

  const [liveOwner, livePauser, initialPaused] = await Promise.all([
    policy.owner(),
    policy.pauser(),
    policy.paused()
  ]);

  const live = {
    owner: normalizeAddress(liveOwner),
    pauser: normalizeAddress(livePauser),
    paused: Boolean(initialPaused)
  };

  const checks = [];
  const warnings = [];
  const transactions = {};

  addCheck(checks, "owner_matches_manifest", sameAddress(live.owner, expectedOwner), {
    expected: expectedOwner,
    actual: live.owner
  });
  addCheck(checks, "pauser_matches_manifest", sameAddress(live.pauser, expectedPauser), {
    expected: expectedPauser,
    actual: live.pauser
  });
  addCheck(checks, "pauser_is_nonzero", !sameAddress(live.pauser, ZERO_ADDRESS), {
    pauser: live.pauser
  });
  addCheck(checks, "pauser_not_owner", !sameAddress(live.pauser, live.owner), {
    owner: live.owner,
    pauser: live.pauser
  });

  const roleOverlap = evaluateDedicatedPauser({
    pauser: live.pauser,
    owner: live.owner,
    deployer,
    verifier: expectedVerifier,
    arbitrator: expectedArbitrator
  });
  if (!roleOverlap.dedicated) {
    warnings.push({
      code: "pauser_role_overlap",
      severity: roleOverlap.severity,
      message:
        "Current pauser address overlaps other manifest roles. This is acceptable only for bounded testnet rehearsal; mainnet must use a dedicated pauser.",
      overlaps: roleOverlap.overlaps
    });
  }
  if (options.requireDedicatedPauser) {
    addCheck(checks, "pauser_is_dedicated_role", roleOverlap.dedicated, roleOverlap);
  }

  const roleReads = await readPauserRoleFlags(policy, live.pauser);
  const onChainRoleOverlaps = Object.entries(roleReads)
    .filter(([, enabled]) => enabled === true)
    .map(([role]) => role);
  if (onChainRoleOverlaps.length > 0) {
    warnings.push({
      code: "pauser_onchain_role_overlap",
      severity: "warning",
      message:
        "Current pauser address also has other on-chain TreasuryPolicy roles. This is acceptable only for bounded testnet rehearsal; mainnet must use a dedicated pauser.",
      overlaps: onChainRoleOverlaps
    });
  }
  addCheck(checks, "pauser_not_service_operator", roleReads.serviceOperator === false, roleReads);
  addCheck(checks, "pauser_not_owner_admin_if_owner_distinct", !sameAddress(live.pauser, live.owner), {
    owner: live.owner,
    pauser: live.pauser
  });
  if (options.requireDedicatedPauser) {
    addCheck(checks, "pauser_not_verifier", roleReads.verifier === false, roleReads);
    addCheck(checks, "pauser_not_arbitrator", roleReads.arbitrator === false, roleReads);
  }

  const simulation = await simulatePauserCapabilities({ provider, iface, treasuryPolicy, from: live.pauser });
  checks.push(...simulation.checks);

  if (options.live) {
    if (live.paused && !options.allowStartPaused) {
      throw new Error("Refusing live rehearsal because policy is already paused. Use --allow-start-paused only during a named incident.");
    }
    const pauserPrivateKey = env.PAUSER_PRIVATE_KEY || "";
    if (!pauserPrivateKey) {
      throw new Error("PAUSER_PRIVATE_KEY is required for --live.");
    }
    const wallet = new Wallet(pauserPrivateKey, provider);
    if (!sameAddress(wallet.address, live.pauser)) {
      throw new Error(`PAUSER_PRIVATE_KEY address ${wallet.address} does not match TreasuryPolicy.pauser ${live.pauser}.`);
    }

    const livePolicy = new Contract(treasuryPolicy, TREASURY_POLICY_ABI, wallet);
    const pauseTx = await livePolicy.setPaused(true);
    const pauseReceipt = await pauseTx.wait();
    transactions.pause = txEvidence(pauseReceipt, pauseTx.hash);

    const afterPause = await policy.paused();
    addCheck(checks, "live_pause_state_confirmed", Boolean(afterPause) === true, {
      paused: Boolean(afterPause)
    });

    let unpauseReceipt;
    let unpauseHash;
    let unpauseError = "";
    try {
      const unpauseTx = await livePolicy.setPaused(false);
      unpauseHash = unpauseTx.hash;
      unpauseReceipt = await unpauseTx.wait();
    } catch (caught) {
      unpauseError = caught?.shortMessage || caught?.message || String(caught);
    } finally {
      transactions.unpause = unpauseReceipt
        ? txEvidence(unpauseReceipt, unpauseHash)
        : { hash: unpauseHash || null, status: "not_confirmed", error: unpauseError };
    }

    const afterUnpause = await policy.paused();
    addCheck(checks, "live_unpause_state_confirmed", Boolean(afterUnpause) === false, {
      paused: Boolean(afterUnpause),
      ...(unpauseError ? { error: unpauseError } : {})
    });
  } else {
    warnings.push({
      code: "live_rehearsal_not_run",
      severity: "warning",
      message: "Read-only capability proof passed, but the launch checklist still needs a live pause/unpause tx pair."
    });
  }

  const failures = checks.filter((check) => !check.ok);
  const evidence = {
    schemaVersion: 1,
    kind: "averray.pauserRehearsalEvidence",
    profile: options.profile,
    generatedAt: new Date().toISOString(),
    mode: options.live ? "live_pause_unpause" : "read_only_capability_proof",
    manifestPath: path.relative(repoRoot, manifestPath),
    rpcUrl,
    contracts: { treasuryPolicy },
    manifest: {
      owner: expectedOwner,
      pauser: expectedPauser,
      verifier: expectedVerifier,
      arbitrator: expectedArbitrator,
      deployer
    },
    live,
    roleOverlap,
    roleReads,
    simulation: simulation.summary,
    transactions,
    checks,
    warnings,
    ok: failures.length === 0,
    launchGate: {
      controlPlanePauserReady: failures.length === 0,
      pauseUnpauseRehearsed: Boolean(options.live && transactions.pause?.status === 1 && transactions.unpause?.status === 1),
      requiresLiveRehearsal: !options.live
    }
  };

  if (options.out) {
    const outPath = path.resolve(options.out);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, `${JSON.stringify(evidence, null, 2)}\n`);
  }

  return evidence;
}

function parseBoolean(value) {
  return value === "1" || value === "true" || value === "yes";
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function normalizeAddress(value) {
  if (!value || !isAddress(value)) return "";
  return getAddress(value);
}

function sameAddress(left, right) {
  return normalizeAddress(left).toLowerCase() === normalizeAddress(right).toLowerCase();
}

function addCheck(checks, name, ok, details = {}) {
  checks.push({ name, ok: Boolean(ok), details });
}

async function readPauserRoleFlags(policy, pauser) {
  const [serviceOperator, verifier, arbitrator] = await Promise.all([
    policy.serviceOperators(pauser),
    policy.verifiers(pauser),
    policy.arbitrators(pauser)
  ]);
  return {
    serviceOperator: Boolean(serviceOperator),
    verifier: Boolean(verifier),
    arbitrator: Boolean(arbitrator)
  };
}

async function simulatePauserCapabilities({ provider, iface, treasuryPolicy, from }) {
  const checks = [];
  const calls = [
    {
      name: "pauser_can_call_setPaused_true",
      expectSuccess: true,
      data: iface.encodeFunctionData("setPaused", [true])
    },
    {
      name: "pauser_cannot_call_setPauser",
      expectSuccess: false,
      data: iface.encodeFunctionData("setPauser", [from])
    },
    {
      name: "pauser_cannot_call_setVerifier",
      expectSuccess: false,
      data: iface.encodeFunctionData("setVerifier", [from, true])
    },
    {
      name: "pauser_cannot_call_setServiceOperator",
      expectSuccess: false,
      data: iface.encodeFunctionData("setServiceOperator", [from, true])
    },
    {
      name: "pauser_cannot_call_transferOwnership",
      expectSuccess: false,
      data: iface.encodeFunctionData("transferOwnership", [from])
    }
  ];

  const summary = [];
  for (const call of calls) {
    let success = false;
    let error = "";
    try {
      await provider.call({ from, to: treasuryPolicy, data: call.data });
      success = true;
    } catch (caught) {
      error = caught?.shortMessage || caught?.message || String(caught);
    }
    addCheck(checks, call.name, success === call.expectSuccess, {
      expected: call.expectSuccess ? "success" : "revert",
      actual: success ? "success" : "revert",
      ...(error ? { error } : {})
    });
    summary.push({
      name: call.name,
      expected: call.expectSuccess ? "success" : "revert",
      actual: success ? "success" : "revert"
    });
  }
  return { checks, summary };
}

function txEvidence(receipt, hash) {
  return {
    hash,
    blockNumber: Number(receipt.blockNumber),
    status: Number(receipt.status)
  };
}

function printHelp() {
  console.log(`Usage:
  node scripts/ops/run-pauser-rehearsal.mjs [--profile testnet] [--out path]
  PAUSER_PRIVATE_KEY=0x... node scripts/ops/run-pauser-rehearsal.mjs --live --profile testnet --out docs/evidence/pauser-rehearsal-testnet-YYYY-MM-DD.json

Options:
  --profile <name>                  Deployment manifest profile. Default: testnet.
  --manifest <path>                 Explicit deployment manifest path.
  --out <path>                      Write sanitized JSON evidence to a file.
  --live                            Send setPaused(true), confirm, then setPaused(false).
  --require-dedicated-pauser        Fail if pauser overlaps deployer/verifier/arbitrator/owner.
  --allow-start-paused              Allow live mode when the policy is already paused.
`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs();
    if (options.help) {
      printHelp();
    } else {
      const evidence = await runPauserRehearsal(options);
      console.log(JSON.stringify(evidence, null, 2));
      if (!evidence.ok) process.exitCode = 1;
    }
  } catch (error) {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  }
}
