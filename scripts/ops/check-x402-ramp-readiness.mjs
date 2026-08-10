#!/usr/bin/env node
/**
 * Pre-flight for enabling the x402 poster ramp.
 *
 * WHY THIS EXISTS
 * Three separate failures this repo has already had, all of which this catches:
 *   1. A config value set somewhere that never reaches production (two marketing
 *      allow-lists, twice).
 *   2. "Disabled" and "not deployed" looking identical from outside — you cannot
 *      tell a working safety gate from an absent feature without checking both.
 *   3. Believing a credential works because it is present, rather than because a
 *      call with it succeeded.
 *
 * It reads only. It never enables anything, never settles, never posts.
 *
 * USAGE
 *   node scripts/ops/check-x402-ramp-readiness.mjs           # reads process.env
 *   X402_POSTING_MODE=enabled ... node scripts/ops/check-x402-ramp-readiness.mjs
 *
 * Exit 0 = every check passed and the ramp may be enabled.
 * Exit 1 = at least one check failed; the reason is printed.
 */
import { Contract, JsonRpcProvider, TypedDataEncoder, formatUnits, getAddress } from "ethers";

import { resolveX402PosterRampConfig } from "../../mcp-server/src/payments/x402-poster-ramp.js";
import {
  generateCdpAuthorization,
  resolveCdpSettlementConfig
} from "../../mcp-server/src/payments/adapters/cdp/settlement-adapter.js";

const BASE_RPC = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const HUB_RPC = process.env.RPC_URL ?? "https://services.polkadothub-rpc.com/mainnet/";
const HUB_USDC = "0x0000053900000000000000000000000001200000";
const AGENT_ACCOUNT_CORE = "0xB1350932bf85E7ffd0599E9a3CC7b55718D89E57";
const ERC20 = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)"
];
const AAC = [
  "function positions(address,address) view returns (uint256,uint256,uint256,uint256,uint256,uint256)"
];

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
}

// ── 1. config resolves ────────────────────────────────────────────────────────
let ramp;
try {
  ramp = resolveX402PosterRampConfig(process.env);
  if (!ramp.enabled) {
    record("ramp config", false, "X402_POSTING_MODE is not 'enabled' — nothing to pre-flight yet.");
  } else {
    record("ramp config", true, `network ${ramp.network}, float cap ${ramp.floatCapUsdc} USDC`);
  }
} catch (error) {
  record("ramp config", false, error.message);
}

let cdp;
try {
  cdp = resolveCdpSettlementConfig(process.env);
  record("settlement config", true, `facilitator ${cdp.baseUrl.origin}`);
} catch (error) {
  record("settlement config", false, error.message);
}

// ── 2. the pay-to address really exists on Base ───────────────────────────────
// A typo here sends every poster payment to an address nobody controls, and it
// would look exactly like a working configuration until the first rebalance.
if (ramp?.enabled) {
  try {
    const base = new JsonRpcProvider(BASE_RPC);
    const net = await base.getNetwork();
    if (net.chainId !== 8453n) {
      record("Base RPC", false, `expected chainId 8453, got ${net.chainId}`);
    } else {
      record("Base RPC", true, `chainId ${net.chainId}`);
      const payTo = getAddress(ramp.payTo);
      const code = await base.getCode(payTo);
      const token = new Contract(ramp.asset, ERC20, base);
      const [symbol, decimals] = await Promise.all([
        token.symbol().catch(() => "?"),
        token.decimals().catch(() => 6)
      ]);
      const held = await token.balanceOf(payTo);
      record(
        "payTo on Base",
        true,
        `${payTo} (${code === "0x" ? "EOA" : "CONTRACT"}) holds ${formatUnits(held, decimals)} ${symbol}`
      );
      record(
        "payment asset",
        symbol.toUpperCase().includes("USDC"),
        `${ramp.asset} reports symbol ${symbol} — confirm this is Circle-native USDC on Base, not a bridged variant`
      );

      // The check that was missing. `extra` IS the payer's EIP-712 domain, and a
      // wrong one is invisible from this side: the payer signs a different digest,
      // it recovers to a different address, and the facilitator returns a flat
      // payment_verification_failed. Confirming symbol() is not the same test —
      // Base USDC has symbol() "USDC" but name() "USD Coin", and we advertised the
      // symbol, so the ramp could not accept a payment from anyone.
      //
      // Reproducing DOMAIN_SEPARATOR is the only proof: it is what the token itself
      // hashes against, so a match cannot be coincidental.
      try {
        const onchain = await token.DOMAIN_SEPARATOR();
        const configured = TypedDataEncoder.hashDomain({
          name: ramp.assetEip712Name,
          version: ramp.assetEip712Version,
          chainId: Number(net.chainId),
          verifyingContract: getAddress(ramp.asset)
        });
        const advertised = `name=${JSON.stringify(ramp.assetEip712Name)} version=${JSON.stringify(ramp.assetEip712Version)}`;
        record(
          "EIP-712 domain",
          configured === onchain,
          configured === onchain
            ? `${advertised} reproduces the asset's DOMAIN_SEPARATOR ${onchain}`
            : `${advertised} hashes to ${configured} but the asset reports ${onchain}`
            + ` — payers signing our advertised extra would be rejected.`
            + ` Read name() and version() off ${ramp.asset}.`
        );
      } catch (error) {
        // An asset without DOMAIN_SEPARATOR() cannot support EIP-3009 at all, so
        // this is a hard failure rather than an unverifiable check.
        record(
          "EIP-712 domain",
          false,
          `could not read DOMAIN_SEPARATOR() from ${ramp.asset}: ${error.message}`
        );
      }
    }
  } catch (error) {
    record("Base reachability", false, error.message);
  }
}

// ── 3. Hub float can actually cover the configured cap ────────────────────────
// The cap is a promise the ramp makes; if the pot cannot cover it, the ramp will
// accept payments it cannot front.
if (ramp?.enabled) {
  const poolAddress = String(process.env.X402_POOLED_FUNDING_ACCOUNT ?? "").trim();
  if (!poolAddress) {
    record(
      "Hub float",
      false,
      "X402_POOLED_FUNDING_ACCOUNT is not set for this check; supply the pooled account that fronts escrow so the cap can be compared against real liquidity."
    );
  } else {
    try {
      const hub = new JsonRpcProvider(HUB_RPC);
      const aac = new Contract(AGENT_ACCOUNT_CORE, AAC, hub);
      const [liquid] = await aac.positions(getAddress(poolAddress), HUB_USDC);
      const covers = liquid >= ramp.floatCapRaw;
      record(
        "Hub float covers cap",
        covers,
        `pool liquid ${formatUnits(liquid, 6)} USDC vs cap ${ramp.floatCapUsdc} USDC` +
          (covers ? "" : " — the ramp would promise float it does not hold")
      );
    } catch (error) {
      record("Hub float", false, error.message);
    }
  }
}

// ── 4. the credential works, not merely exists ────────────────────────────────
// Presence is not proof. This sends a deliberately malformed body to the
// facilitator's verify endpoint: verify moves no money, so the call is harmless,
// and the RESPONSE CODE is what we are reading. 401/403 means the credential is
// rejected; any other status means it authenticated and the request merely failed
// validation, which is exactly what we expect from junk input.
if (cdp) {
  try {
    // The JWT binds method+host+path; passing the wrong parameter names produces a
    // structurally valid token whose uri claim is nonsense, and CDP answers 401 —
    // which would look exactly like a bad credential. Keep these names in step with
    // generateCdpAuthorization's signature.
    // Mirror the adapter's own request construction exactly. Every deviation here
    // produces a 401 that is indistinguishable from a bad credential — this probe
    // has already done that twice, once by passing the wrong parameter names and
    // once by omitting the Bearer scheme.
    const url = new URL(
      `${cdp.baseUrl.pathname.replace(/\/$/u, "")}/verify`,
      cdp.baseUrl.origin
    );
    const body = JSON.stringify({ preflight: "averray-readiness-probe" });
    const authorization = await generateCdpAuthorization({
      apiKeyId: cdp.apiKeyId,
      apiKeySecret: cdp.apiKeySecret,
      requestMethod: "POST",
      requestHost: url.host,
      requestPath: url.pathname
    });
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${authorization}`,
        "content-type": "application/json",
        accept: "application/json"
      },
      body,
      signal: AbortSignal.timeout(cdp.timeoutMs)
    });
    const rejected = response.status === 401 || response.status === 403;
    record(
      "settlement credential",
      !rejected,
      rejected
        ? `facilitator returned ${response.status} — the credential is present but NOT authorised`
        : `authenticated (facilitator returned ${response.status} to a deliberately invalid body, which is the expected shape)`
    );
  } catch (error) {
    record(
      "settlement credential",
      false,
      `could not reach the facilitator to prove the credential works: ${error.message}`
    );
  }
}

// ── report ────────────────────────────────────────────────────────────────────
const width = Math.max(...results.map((r) => r.name.length));
for (const { name, ok, detail } of results) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(width)}  ${detail}`);
}
const failed = results.filter((r) => !r.ok);
console.log(
  failed.length === 0
    ? "\nAll checks passed — the ramp may be enabled."
    : `\n${failed.length} check(s) failed — do NOT enable the ramp.`
);
process.exit(failed.length === 0 ? 0 : 1);
