import { createHash } from "node:crypto";

import { base58 } from "@scure/base";
import { getBytes, formatUnits } from "ethers";

import {
  DEFAULT_ONBOARDING_WAIVER_CLAIM_COUNT,
  loadOnboardingSubsidyBudgetConfig
} from "../core/claim-economics.js";
import { ValidationError } from "../core/errors.js";
import { loadDeploymentManifest, resolveHealthAddresses } from "../core/health-capability.js";
import { SELF_IDENTITY_KINDS } from "../core/self-identity-registry.js";
import { settlementOutcome } from "../core/session-settlement.js";

const USDC_DECIMALS = 6;
// The signer gas balance is observed through the Hub EVM account, whose native
// DOT unit is wei-shaped (18 decimals), not the relay-chain display precision.
const DOT_DECIMALS = 18;
const SS58_HASH_PREFIX = Buffer.from("SS58PRE");
const EVENT_PAGE_SIZE = 200;
const READ_PAGE_SIZE = 250;
const READ_LIMIT = 10_000;
const REWARD_BANK_SNAPSHOT_SCOPE = "overnight-ledger:reward-bank-snapshots";
const CAPABILITY_WARNING_SCOPE = "overnight-ledger:capability-warnings";
const DEPLOY_MARKER_SCOPE = "overnight-ledger:deploy-marker";
const SNAPSHOT_RETENTION = 2_000;
const ALLOWED_WINDOWS = new Map([
  ["12h", 12],
  ["24h", 24],
  ["48h", 48]
]);
const LEDGER_EVENT_TYPES = new Map([
  ["ops.wallet_graduated", ["wallet_graduated", "ok"]],
  ["ops.waiver_window_exhausted", ["waiver_window_exhausted", "info"]],
  ["ops.first_external_posting", ["first_external_posting", "ok"]],
  ["ops.capability_warning_opened", ["capability_warning_opened", "warn"]],
  ["ops.capability_warning_closed", ["capability_warning_closed", "ok"]],
  ["ops.claim_stuck", ["claim_stuck", "warn"]],
  ["account.reserved", ["reserved_locked", "info"]],
  ["ops.deploy", ["deploy", "info"]]
]);
const ACCOUNT_BALANCE_TOPICS = new Set([
  "account.deposited",
  "account.withdrawn",
  "account.reserved",
  "account.reservation_released",
  "account.reservation_settled",
  "account.agent_transfer",
  "account.job_stake_locked",
  "account.job_stake_released"
]);

export function normalizeLedgerWallet(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function parseOvernightLedgerWindow(value) {
  const key = String(value ?? "24h").trim().toLowerCase();
  const hours = ALLOWED_WINDOWS.get(key);
  if (!hours) {
    throw new ValidationError("window must be one of 12h, 24h, or 48h.", {
      field: "window",
      value
    });
  }
  return { key, hours };
}

export class OvernightLedgerService {
  constructor({
    stateStore,
    selfIdentityRegistry,
    env = process.env,
    now = () => new Date()
  } = {}) {
    this.stateStore = stateStore;
    this.selfIdentityRegistry = selfIdentityRegistry;
    this.env = env;
    this.now = now;
  }

  async getLedger(windowValue) {
    const window = parseOvernightLedgerWindow(windowValue);
    const generatedAt = asIso(this.now());
    const endMs = Date.parse(generatedAt);
    const startMs = endMs - window.hours * 60 * 60 * 1_000;
    const [sessions, eventResult, snapshotState] = await Promise.all([
      collectAllSessions(this.stateStore),
      this.stateStore.listEventLog?.({ limit: 5_000 }) ?? { events: [], gap: false },
      this.stateStore.getServiceState?.(REWARD_BANK_SNAPSHOT_SCOPE) ?? {}
    ]);
    const allEvents = eventResult.events ?? [];
    const events = allEvents.filter((event) => inWindow(event.timestamp, startMs, endMs));
    const identities = classifyWallets(sessions, this.selfIdentityRegistry);
    const windowSessions = sessions.filter((session) => sessionHasWindowActivity(session, startMs, endMs));
    const digestSessions = windowSessions.filter((session) => (
      identityForSession(session, this.selfIdentityRegistry).kind !== SELF_IDENTITY_KINDS.CANARY
    ));
    const settlements = windowSessions.filter((session) => settlementInWindow(session, startMs, endMs));
    const digestSettlements = digestSessions.filter((session) => settlementInWindow(session, startMs, endMs));
    const payoutRows = settlements
      .filter((session) => settlementOutcome(session) === "approved")
      .map(settlementAmounts);
    const snapshots = normalizeSnapshots(snapshotState.snapshots);
    const reconciliation = buildReconciliation({
      payoutRows,
      snapshots,
      events,
      startMs,
      generatedAt
    });
    const workers = buildWorkers({
      sessions,
      windowSessions,
      events,
      accountEvents: allEvents,
      identities,
      startMs,
      endMs
    });
    const rewardBankSplit = buildRewardBankSplit({
      reconciliation,
      payoutRows,
      snapshots,
      startMs,
      endMs,
      windowHours: window.hours
    });
    const retention = buildRetention({
      sessions,
      windowSessions,
      settlements,
      env: this.env,
      startMs,
      endMs
    });
    const lifecycle = buildLifecycleEvents(events);
    const digest = buildDigest({
      reconciliation,
      rewardBankSplit,
      retention,
      workers,
      digestSessions,
      digestSettlements,
      lifecycle,
      events
    });

    return {
      window: window.key,
      generatedAt,
      reconciliation,
      workers,
      rewardBankSplit,
      retention,
      digest,
      events: {
        items: lifecycle.slice(-EVENT_PAGE_SIZE),
        totalCount: lifecycle.length,
        returnedCount: Math.min(lifecycle.length, EVENT_PAGE_SIZE),
        hasOlder: lifecycle.length > EVENT_PAGE_SIZE || eventResult.gap === true
      }
    };
  }

  getTopupDestinations() {
    const manifest = loadDeploymentManifest(this.env);
    const configured = resolveHealthAddresses({ deploymentManifest: manifest, env: this.env });
    const signer = configured.settlementSigner;
    if (!signer) {
      throw new ValidationError("The configured settlement signer is unavailable for top-up routing.", {
        field: "settlementSigner"
      });
    }
    const ss58Address = evmAddressToAssetHubSs58(signer);
    return {
      topupDestinations: {
        signerGas: {
          ss58Address,
          asset: "DOT",
          network: "Polkadot Asset Hub",
          exchangeNetworkLabel: "Polkadot"
        },
        rewardBank: {
          ss58Address,
          asset: "USDC",
          network: "Polkadot Asset Hub",
          exchangeNetworkLabel: "Polkadot",
          landsInEoa: true,
          followUpCommand: "fund-signer deposit"
        }
      }
    };
  }
}

export function evmAddressToAssetHubSs58(address) {
  const evm = getBytes(String(address));
  if (evm.length !== 20) {
    throw new ValidationError("Top-up EVM account must be a 20-byte address.");
  }
  const accountId32 = new Uint8Array(32);
  accountId32.set(evm);
  accountId32.fill(0xee, 20);
  const payload = new Uint8Array(33);
  payload.set(accountId32, 1);
  const checksum = createHash("blake2b512")
    .update(SS58_HASH_PREFIX)
    .update(payload)
    .digest();
  const encoded = new Uint8Array(35);
  encoded.set(payload);
  encoded.set(checksum.subarray(0, 2), payload.length);
  return base58.encode(encoded);
}

export function createPersistedRewardBankHealthProvider({ getRewardBankHealth, stateStore }) {
  return async function getAndPersistRewardBankHealth() {
    const reading = await getRewardBankHealth();
    if (reading?.readable !== true || !unsigned(reading.liquidRaw) || !unsigned(reading.reservedRaw)) {
      return reading;
    }
    const state = await stateStore.getServiceState?.(REWARD_BANK_SNAPSHOT_SCOPE) ?? {};
    const snapshot = {
      asOf: reading.asOf,
      account: normalizeLedgerWallet(reading.account),
      liquidRaw: String(reading.liquidRaw),
      reservedRaw: String(reading.reservedRaw),
      decimals: Number(reading.decimals ?? USDC_DECIMALS),
      source: reading.source ?? "agent_account_position"
    };
    const byTime = new Map(normalizeSnapshots(state.snapshots).map((item) => [item.asOf, item]));
    byTime.set(snapshot.asOf, snapshot);
    const snapshots = [...byTime.values()]
      .sort((left, right) => left.asOf.localeCompare(right.asOf))
      .slice(-SNAPSHOT_RETENTION);
    await stateStore.upsertServiceState?.(REWARD_BANK_SNAPSHOT_SCOPE, { snapshots });
    return reading;
  };
}

export async function recordCapabilityWarningTransitions({ stateStore, eventBus, warnings, now = new Date() }) {
  const currentCodes = new Set((warnings ?? []).map((warning) => String(warning.code)).filter(Boolean));
  const state = await stateStore.getServiceState?.(CAPABILITY_WARNING_SCOPE) ?? {};
  const priorCodes = new Set(Array.isArray(state.openCodes) ? state.openCodes : []);
  const timestamp = asIso(now);
  for (const code of currentCodes) {
    if (priorCodes.has(code)) continue;
    eventBus?.publish?.({
      id: `capability-warning-opened-${code}-${Date.parse(timestamp)}`,
      topic: "ops.capability_warning_opened",
      timestamp,
      severity: "warn",
      data: { code }
    });
  }
  for (const code of priorCodes) {
    if (currentCodes.has(code)) continue;
    eventBus?.publish?.({
      id: `capability-warning-closed-${code}-${Date.parse(timestamp)}`,
      topic: "ops.capability_warning_closed",
      timestamp,
      severity: "info",
      data: { code }
    });
  }
  await stateStore.upsertServiceState?.(CAPABILITY_WARNING_SCOPE, {
    openCodes: [...currentCodes].sort(),
    observedAt: timestamp
  });
}

export async function recordDeployMarker({ stateStore, eventBus, deployedSha, now = new Date() }) {
  const sha = String(deployedSha ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(sha)) return false;
  const state = await stateStore.getServiceState?.(DEPLOY_MARKER_SCOPE) ?? {};
  if (state.deployedSha === sha) return false;
  const timestamp = asIso(now);
  eventBus?.publish?.({
    id: `deploy-${sha}`,
    topic: "ops.deploy",
    timestamp,
    data: { deployedSha: sha }
  });
  await stateStore.upsertServiceState?.(DEPLOY_MARKER_SCOPE, { deployedSha: sha, deployedAt: timestamp });
  return true;
}

function buildReconciliation({ payoutRows, snapshots, events, startMs, generatedAt }) {
  const closing = latestSnapshotAtOrBefore(snapshots, Date.parse(generatedAt));
  const observedOpening = latestSnapshotAtOrBefore(snapshots, startMs);
  const payoutsRaw = sum(payoutRows.map((row) => row.netRaw));
  const retentionFeesRaw = sum(payoutRows.map((row) => row.retentionFeesRaw));
  const proofRefs = payoutRows.flatMap((row) => row.proofRefs);
  const proofTiedCount = payoutRows.filter((row) => row.proofRefs.length > 0).length;
  const proofMissingCount = payoutRows.length - proofTiedCount;
  if (!closing) {
    return {
      openingLiquid: unavailableMoney(USDC_DECIMALS),
      payoutsOut: {
        count: payoutRows.length,
        netUsdc: money(payoutsRaw, USDC_DECIMALS),
        walletCount: new Set(payoutRows.map((row) => row.wallet)).size,
        proofRefs
      },
      retentionFeesIn: money(retentionFeesRaw, USDC_DECIMALS, proofRefs),
      reservedDelta: money(rewardBankReservedEventDelta(events), USDC_DECIMALS, reservedProofs(events)),
      closingLiquid: unavailableMoney(USDC_DECIMALS),
      proofTiedCount,
      proofMissingCount,
      delta: unavailableMoney(USDC_DECIMALS),
      match: "SHORTFALL",
      basis: "reward_bank_position_snapshot_unavailable"
    };
  }
  const reservedEventDelta = rewardBankReservedEventDelta(events, closing?.account);
  const reservedDelta = observedOpening && closing
    ? BigInt(closing.reservedRaw) - BigInt(observedOpening.reservedRaw)
    : reservedEventDelta;
  const closingRaw = closing ? BigInt(closing.liquidRaw) : 0n;
  const openingRaw = observedOpening
    ? BigInt(observedOpening.liquidRaw)
    : closingRaw + payoutsRaw - retentionFeesRaw + reservedDelta;
  const expectedClosing = openingRaw - payoutsRaw + retentionFeesRaw - reservedDelta;
  const delta = closingRaw - expectedClosing;
  const openingProof = observedOpening ? [snapshotProof(observedOpening)] : [];
  const closingProof = closing ? [snapshotProof(closing)] : [];

  return {
    openingLiquid: money(openingRaw, USDC_DECIMALS, openingProof),
    payoutsOut: {
      count: payoutRows.length,
      netUsdc: money(payoutsRaw, USDC_DECIMALS),
      walletCount: new Set(payoutRows.map((row) => row.wallet)).size,
      proofRefs
    },
    retentionFeesIn: money(retentionFeesRaw, USDC_DECIMALS, proofRefs),
    reservedDelta: money(reservedDelta, USDC_DECIMALS, reservedProofs(events, closing.account)),
    closingLiquid: money(closingRaw, USDC_DECIMALS, closingProof),
    proofTiedCount,
    proofMissingCount,
    delta: money(delta, USDC_DECIMALS),
    match: delta === 0n ? "CONFIRMED" : "SHORTFALL",
    basis: observedOpening && closing
      ? "observed_reward_bank_position_snapshots_plus_persisted_settlements"
      : closing
        ? "closing_position_minus_windowed_persisted_deltas"
        : "unavailable_position_zero_baseline_with_persisted_deltas"
  };
}

function buildRewardBankSplit({ reconciliation, payoutRows, snapshots, startMs, endMs, windowHours }) {
  const closing = latestSnapshotAtOrBefore(snapshots, endMs);
  const opening = latestSnapshotAtOrBefore(snapshots, startMs);
  if (!closing) {
    return {
      liquid: unavailableMoney(USDC_DECIMALS),
      reserved: unavailableMoney(USDC_DECIMALS),
      runwayDays: null,
      runwayBasis: "liquid_only_unavailable",
      liquidDelta: unavailableMoney(USDC_DECIMALS),
      reservedDelta: reconciliation.reservedDelta
    };
  }
  const liquidRaw = BigInt(closing.liquidRaw);
  const reservedRaw = BigInt(closing.reservedRaw);
  const liquidDelta = opening && closing
    ? liquidRaw - BigInt(opening.liquidRaw)
    : BigInt(reconciliation.closingLiquid.raw) - BigInt(reconciliation.openingLiquid.raw);
  const reservedDelta = opening && closing
    ? reservedRaw - BigInt(opening.reservedRaw)
    : BigInt(reconciliation.reservedDelta.raw);
  const burnRaw = sum(payoutRows.map((row) => row.netRaw));
  const dailyBurnRaw = windowHours > 0 ? burnRaw * 24n / BigInt(windowHours) : 0n;

  return {
    liquid: money(liquidRaw, USDC_DECIMALS),
    reserved: money(reservedRaw, USDC_DECIMALS),
    runwayDays: dailyBurnRaw > 0n ? Number(liquidRaw) / Number(dailyBurnRaw) : null,
    runwayBasis: "liquid_only",
    liquidDelta: money(liquidDelta, USDC_DECIMALS),
    reservedDelta: money(reservedDelta, USDC_DECIMALS)
  };
}

function buildWorkers({ sessions, windowSessions, events, accountEvents, identities, startMs, endMs }) {
  const lifetimeByWallet = groupByWallet(sessions);
  const windowByWallet = groupByWallet(windowSessions);
  const accountBalances = deriveAccountBalances(accountEvents);
  const items = [];
  for (const [wallet, scoped] of windowByWallet) {
    const lifetime = lifetimeByWallet.get(wallet) ?? scoped;
    const identity = identities.get(wallet);
    const timestamps = scoped.flatMap(activityTimestamps).filter((value) => inWindow(value, startMs, endMs));
    const approved = scoped.filter((session) => settlementInWindow(session, startMs, endMs)
      && settlementOutcome(session) === "approved");
    const rejected = scoped.filter((session) => settlementInWindow(session, startMs, endMs)
      && settlementOutcome(session) === "rejected");
    const amounts = approved.map(settlementAmounts);
    const grossRaw = sum(amounts.map((row) => row.grossRaw));
    const netRaw = sum(amounts.map((row) => row.netRaw));
    const retainedRaw = sum(amounts.map((row) => row.retainedRaw));
    const waivedRaw = sum(approved.filter(isRetentionWaived).map(hypotheticalWaivedRetentionRaw));
    const claimNumber = Math.max(0, ...lifetime.map((session) => Number(session?.claimNumber ?? 0)));
    const latestProgression = latestProgressionFromSessions(lifetime);
    const tierEvents = scoped
      .filter((session) => session?.progression?.justChanged?.field === "tier")
      .map((session) => ({
        timestamp: session.resolvedAt ?? session.updatedAt,
        from: session.progression.justChanged.from,
        to: session.progression.justChanged.to
      }));
    const derivedTierEvents = events
      .filter((event) => event.topic === "ops.wallet_graduated" && normalizeLedgerWallet(event.wallet) === wallet)
      .map((event) => ({ timestamp: event.timestamp, from: event.data?.from, to: event.data?.to }));
    const observedBalance = accountBalances.get(wallet);
    const withdrawnInWindowRaw = sum(events
      .filter((event) => event.topic === "account.withdrawn"
        && normalizeLedgerWallet(event.wallet) === wallet)
      .map((event) => rawFromEvent(event)));
    const observedLifetimeWithdrawnRaw = sum(accountEvents
      .filter((event) => event.topic === "account.withdrawn"
        && normalizeLedgerWallet(event.wallet) === wallet)
      .map((event) => rawFromEvent(event)));
    const fallbackLifetimeNet = sum(lifetime
      .filter((session) => settlementOutcome(session) === "approved")
      .map((session) => settlementAmounts(session).netRaw)) - observedLifetimeWithdrawnRaw;
    const sessionStart = timestamps.slice().sort()[0] ?? null;
    const sessionEnd = timestamps.slice().sort().at(-1) ?? null;
    const firstEver = lifetime.flatMap(activityTimestamps).filter(Boolean).sort()[0];
    items.push({
      wallet,
      isFirstEverActivity: Boolean(firstEver && Date.parse(firstEver) >= startMs),
      selfIdentity: identity,
      sessionStart,
      sessionEnd,
      sessionHours: sessionStart && sessionEnd
        ? Number(((Date.parse(sessionEnd) - Date.parse(sessionStart)) / 3_600_000).toFixed(2))
        : 0,
      claims: scoped.filter((session) => inWindow(session.claimedAt, startMs, endMs)).length,
      approved: approved.length,
      rejected: rejected.length,
      grossEarned: money(grossRaw, USDC_DECIMALS),
      netEarned: money(netRaw, USDC_DECIMALS),
      retentionPaid: money(retainedRaw, USDC_DECIMALS),
      retentionWaived: money(waivedRaw, USDC_DECIMALS),
      waiverSlotsUsed: Math.min(claimNumber, DEFAULT_ONBOARDING_WAIVER_CLAIM_COUNT),
      waiverSlotsTotal: DEFAULT_ONBOARDING_WAIVER_CLAIM_COUNT,
      reputationTier: latestProgression?.tier ?? null,
      tierEvents: uniqueTierEvents([...tierEvents, ...derivedTierEvents])
        .sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp))),
      balanceNow: {
        ...money(observedBalance?.liquidRaw ?? fallbackLifetimeNet, USDC_DECIMALS),
        complete: observedBalance?.complete === true,
        basis: observedBalance
          ? "persisted_account_lifecycle_events"
          : "persisted_settlements_minus_observed_withdrawals"
      },
      withdrawnInWindow: money(withdrawnInWindowRaw, USDC_DECIMALS)
    });
  }
  items.sort((left, right) => compareRawDescending(left.netEarned.raw, right.netEarned.raw)
    || left.wallet.localeCompare(right.wallet));
  return {
    items,
    totals: {
      walletCount: items.length,
      claims: items.reduce((total, row) => total + row.claims, 0),
      approved: items.reduce((total, row) => total + row.approved, 0),
      rejected: items.reduce((total, row) => total + row.rejected, 0),
      grossEarned: money(sum(items.map((row) => row.grossEarned.raw)), USDC_DECIMALS),
      netEarned: money(sum(items.map((row) => row.netEarned.raw)), USDC_DECIMALS),
      retentionPaid: money(sum(items.map((row) => row.retentionPaid.raw)), USDC_DECIMALS),
      retentionWaived: money(sum(items.map((row) => row.retentionWaived.raw)), USDC_DECIMALS),
      balanceNow: money(sum(items.map((row) => row.balanceNow.raw)), USDC_DECIMALS),
      withdrawnInWindow: money(sum(items.map((row) => row.withdrawnInWindow.raw)), USDC_DECIMALS)
    }
  };
}

function buildRetention({ sessions, windowSessions, settlements, env, startMs, endMs }) {
  const approved = settlements.filter((session) => settlementOutcome(session) === "approved");
  const charged = approved.map(settlementAmounts).filter((row) => row.retainedRaw > 0n);
  const waived = approved.filter(isRetentionWaived);
  const activeWallets = new Set(windowSessions.map((session) => normalizeLedgerWallet(session.wallet)).filter(Boolean));
  const lifetimeByWallet = groupByWallet(sessions);
  const walletsInFreeWindow = [...activeWallets].filter((wallet) => {
    const claimNumber = Math.max(0, ...(lifetimeByWallet.get(wallet) ?? []).map((session) => Number(session.claimNumber ?? 0)));
    return claimNumber < DEFAULT_ONBOARDING_WAIVER_CLAIM_COUNT;
  }).length;
  const waiverSlotsConsumed = windowSessions.filter((session) => (
    inWindow(session.claimedAt, startMs, endMs)
    && (session.claimEconomicsWaivedAtClaim === true || session.claimEconomicsWaived === true)
  )).length;
  const subsidySpendRaw = sum(windowSessions
    .filter((session) => inWindow(session.claimedAt, startMs, endMs))
    .map((session) => usdcRaw(session?.onboardingSubsidy?.estimatedClaimSubsidyUsdc ?? 0)));
  const subsidyConfig = loadOnboardingSubsidyBudgetConfig(env);
  const chargedRaw = sum(charged.map((row) => row.retainedRaw));
  const protocolRevenueRaw = sum(approved.map((session) => settlementAmounts(session).retentionFeesRaw));
  const waivedRaw = sum(waived.map(hypotheticalWaivedRetentionRaw));
  return {
    charged: money(chargedRaw, USDC_DECIMALS),
    chargedSettlementCount: charged.length,
    waived: money(waivedRaw, USDC_DECIMALS),
    waivedSettlementCount: waived.length,
    waiverSlotsConsumed,
    waiverSlotsTotal: activeWallets.size * DEFAULT_ONBOARDING_WAIVER_CLAIM_COUNT,
    walletsInFreeWindow,
    subsidySpend: money(subsidySpendRaw, USDC_DECIMALS),
    subsidyDailyBudget: money(usdcRaw(subsidyConfig.dailyBudgetUsdc), USDC_DECIMALS),
    protocolRevenueDelta: money(protocolRevenueRaw, USDC_DECIMALS)
  };
}

function buildDigest({
  reconciliation,
  rewardBankSplit,
  retention,
  workers,
  digestSessions,
  digestSettlements,
  lifecycle,
  events
}) {
  const countType = (type) => lifecycle.filter((event) => event.type === type).length;
  const digestWallets = new Set(digestSessions.map((session) => normalizeLedgerWallet(session.wallet)).filter(Boolean));
  return {
    settlementCount: digestSettlements.filter((session) => settlementOutcome(session) === "approved").length,
    walletCount: digestWallets.size,
    newWalletCount: workers.items.filter((row) => row.isFirstEverActivity
      && digestWallets.has(row.wallet)).length,
    paid: reconciliation.payoutsOut.netUsdc,
    retained: retention.charged,
    bankOpen: reconciliation.openingLiquid,
    bankClose: reconciliation.closingLiquid,
    bankLocked: rewardBankSplit.reserved,
    stuckClaimCount: countType("claim_stuck"),
    gasDelta: money(gasDeltaRaw(events), DOT_DECIMALS),
    graduatedCount: countType("wallet_graduated"),
    waiverWindowsExhausted: countType("waiver_window_exhausted"),
    firstExternalPostings: countType("first_external_posting"),
    walletsInFreeWindow: retention.walletsInFreeWindow,
    warningsOpen: countType("capability_warning_opened"),
    warningsClosed: countType("capability_warning_closed"),
    deployCount: countType("deploy"),
    ledgerMatchState: reconciliation.match,
    ledgerDelta: reconciliation.delta
  };
}

function buildLifecycleEvents(events) {
  return events.flatMap((event) => {
    const classification = LEDGER_EVENT_TYPES.get(event.topic);
    if (!classification) return [];
    const [type, defaultSeverity] = classification;
    return [{
      timestamp: event.timestamp,
      type,
      severity: normalizeLedgerSeverity(event.severity, defaultSeverity),
      ...(event.wallet ? { wallet: normalizeLedgerWallet(event.wallet) } : {}),
      payload: event.data ?? {}
    }];
  }).sort((left, right) => left.timestamp.localeCompare(right.timestamp));
}

function settlementAmounts(session) {
  const settlement = session?.payoutTx?.settlement ?? session?.verification?.settlement ?? {};
  const netRaw = raw(settlement.workerAmountRaw);
  const retainedRaw = raw(
    settlement.gasRetentionAmountRaw
      ?? settlement.gasRetention?.retainedRaw
      ?? session?.gasRetention?.retainedRaw
  );
  const protocolFeeRaw = raw(settlement.protocolFeeAmountRaw);
  const rewardRaw = unsigned(settlement.rewardAmountRaw)
    ? BigInt(settlement.rewardAmountRaw)
    : netRaw + retainedRaw;
  const proofRefs = session?.payoutTx?.txHash ? [{
    kind: "settlement_tx",
    txHash: session.payoutTx.txHash,
    blockNumber: Number(session.payoutTx.blockNumber ?? 0),
    sessionId: session.sessionId
  }] : [];
  return {
    wallet: normalizeLedgerWallet(session.wallet),
    netRaw,
    retainedRaw,
    protocolFeeRaw,
    retentionFeesRaw: retainedRaw + protocolFeeRaw,
    grossRaw: rewardRaw,
    proofRefs
  };
}

function hypotheticalWaivedRetentionRaw(session) {
  const gas = session?.gasRetention ?? session?.jobSnapshot?.claimEconomics?.gasRetention ?? {};
  if (gas.supported !== true || gas.brokered !== true) return 0n;
  const rewardRaw = raw(gas.rewardRaw
    ?? session?.payoutTx?.settlement?.rewardAmountRaw
    ?? session?.payoutTx?.settlement?.workerAmountRaw);
  const flat = raw(gas.retentionFlatRaw);
  const capBps = BigInt(Math.max(0, Number(gas.retentionCapBps ?? 0)));
  const cap = rewardRaw * capBps / 10_000n;
  return flat < cap ? flat : cap;
}

function isRetentionWaived(session) {
  return session?.claimEconomicsWaivedAtClaim === true || session?.claimEconomicsWaived === true;
}

function deriveAccountBalances(events) {
  const balances = new Map();
  const entry = (wallet) => {
    const key = normalizeLedgerWallet(wallet);
    if (!key) return undefined;
    if (!balances.has(key)) balances.set(key, { liquidRaw: 0n, complete: false });
    return balances.get(key);
  };
  for (const event of events.filter((candidate) => ACCOUNT_BALANCE_TOPICS.has(candidate.topic))) {
    const amountRaw = rawFromEvent(event);
    if (event.topic === "account.deposited" || event.topic === "account.reservation_released"
      || event.topic === "account.job_stake_released") {
      const row = entry(event.wallet);
      if (row) row.liquidRaw += amountRaw;
    } else if (event.topic === "account.withdrawn" || event.topic === "account.reserved"
      || event.topic === "account.job_stake_locked") {
      const row = entry(event.wallet);
      if (row) row.liquidRaw -= amountRaw;
    } else if (event.topic === "account.reservation_settled") {
      const row = entry(event.data?.recipient);
      if (row) row.liquidRaw += amountRaw;
    } else if (event.topic === "account.agent_transfer") {
      const from = entry(event.data?.from);
      const to = entry(event.data?.to);
      if (from) from.liquidRaw -= amountRaw;
      if (to) to.liquidRaw += amountRaw;
    }
  }
  return balances;
}

async function collectAllSessions(stateStore) {
  const sessions = [];
  if (typeof stateStore?.listRecentSessions !== "function") return sessions;
  for (let offset = 0; offset < READ_LIMIT; offset += READ_PAGE_SIZE) {
    const page = await stateStore.listRecentSessions(READ_PAGE_SIZE, offset);
    if (!Array.isArray(page) || page.length === 0) break;
    sessions.push(...page);
    if (page.length < READ_PAGE_SIZE) break;
  }
  return Promise.all(sessions.map(async (session) => {
    if (session.verification || session.verificationSummary?.outcome) return session;
    const verification = await stateStore.getVerificationResult?.(session.sessionId);
    return verification ? { ...session, verification } : session;
  }));
}

function classifyWallets(sessions, registry) {
  const grouped = groupByWallet(sessions);
  return new Map([...grouped].map(([wallet, rows]) => [
    wallet,
    registry?.classifySessions?.({ wallet, sessions: rows })
      ?? registry?.classify?.({ wallet })
      ?? { actor: "external", self: false, ambiguous: false, kind: "external", evidence: "unclassified" }
  ]));
}

function identityForSession(session, registry) {
  return registry?.classify?.({ wallet: session?.wallet, session })
    ?? { actor: "external", self: false, ambiguous: false, kind: "external", evidence: "unclassified" };
}

function groupByWallet(sessions) {
  const grouped = new Map();
  for (const session of sessions) {
    const wallet = normalizeLedgerWallet(session?.wallet);
    if (!wallet) continue;
    if (!grouped.has(wallet)) grouped.set(wallet, []);
    grouped.get(wallet).push(session);
  }
  return grouped;
}

function activityTimestamps(session) {
  const lifecycle = [
    session?.claimedAt,
    session?.submittedAt,
    session?.resolvedAt,
    session?.rejectedAt,
    session?.disputedAt,
    session?.closedAt,
    session?.expiredAt,
    session?.timedOutAt
  ].filter(Boolean);
  return lifecycle.length > 0
    ? lifecycle
    : [session?.createdAt, session?.updatedAt].filter(Boolean);
}

function sessionHasWindowActivity(session, startMs, endMs) {
  return activityTimestamps(session).some((timestamp) => inWindow(timestamp, startMs, endMs));
}

function settlementInWindow(session, startMs, endMs) {
  return ["resolved", "rejected", "disputed"].includes(String(session?.status ?? "").toLowerCase())
    && inWindow(settlementTimestamp(session), startMs, endMs);
}

function settlementTimestamp(session) {
  return session?.resolvedAt
    ?? session?.rejectedAt
    ?? session?.disputedAt
    ?? session?.closedAt
    ?? session?.updatedAt;
}

function uniqueTierEvents(events) {
  const seen = new Set();
  return events.filter((event) => {
    const key = [event.timestamp, event.from, event.to].map((value) => String(value ?? "")).join(":");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function latestProgressionFromSessions(sessions) {
  return sessions
    .filter((session) => session?.progression)
    .sort((left, right) => timestampMs(right) - timestampMs(left))[0]?.progression;
}

function timestampMs(value) {
  return Math.max(...activityTimestamps(value).map((timestamp) => Date.parse(timestamp)).filter(Number.isFinite), 0);
}

function rewardBankReservedEventDelta(events, account) {
  const wallet = normalizeLedgerWallet(account);
  return sum(events.flatMap((event) => {
    if (wallet && normalizeLedgerWallet(event.wallet) !== wallet) return [];
    if (event.topic === "account.reserved") return [rawFromEvent(event)];
    if (["account.reservation_released", "account.reservation_settled"].includes(event.topic)) {
      return [-rawFromEvent(event)];
    }
    return [];
  }));
}

function reservedProofs(events, account) {
  const wallet = normalizeLedgerWallet(account);
  return events
    .filter((event) => (
      (!wallet || normalizeLedgerWallet(event.wallet) === wallet)
      && ["account.reserved", "account.reservation_released", "account.reservation_settled"].includes(event.topic)
    ))
    .map(chainEventProof);
}

function gasDeltaRaw(events) {
  return sum(events.flatMap((event) => {
    if (event.topic === "operator_gas.first_withdrawal_granted") {
      return [-raw(event?.data?.amount?.raw)];
    }
    if (String(event?.data?.assetSymbol ?? "").toUpperCase() !== "DOT") return [];
    const amountRaw = rawFromEvent(event);
    if (event.topic === "account.deposited") return [amountRaw];
    if (event.topic === "account.withdrawn") return [-amountRaw];
    return [];
  }));
}

function rawFromEvent(event) {
  return raw(event?.data?.amountRaw ?? event?.data?.amount);
}

function chainEventProof(event) {
  return {
    kind: "chain_event",
    eventId: event.id,
    txHash: event.txHash ?? null,
    blockNumber: event.blockNumber ?? null
  };
}

function snapshotProof(snapshot) {
  return { kind: "position_snapshot", asOf: snapshot.asOf, source: snapshot.source };
}

function normalizeSnapshots(value) {
  return (Array.isArray(value) ? value : [])
    .filter((snapshot) => snapshot?.asOf && unsigned(snapshot.liquidRaw) && unsigned(snapshot.reservedRaw))
    .map((snapshot) => ({
      ...snapshot,
      liquidRaw: String(snapshot.liquidRaw),
      reservedRaw: String(snapshot.reservedRaw)
    }))
    .sort((left, right) => left.asOf.localeCompare(right.asOf));
}

function latestSnapshotAtOrBefore(snapshots, timestamp) {
  return snapshots.filter((snapshot) => Date.parse(snapshot.asOf) <= timestamp).at(-1);
}

function money(value, decimals, proofRefs = undefined) {
  const amountRaw = BigInt(value ?? 0);
  return {
    raw: amountRaw.toString(),
    decimals,
    display: formatUnits(amountRaw, decimals),
    ...(proofRefs ? { proofRefs } : {})
  };
}

function unavailableMoney(decimals) {
  return { raw: null, decimals, display: null, available: false };
}

function raw(value) {
  return unsigned(value) ? BigInt(String(value)) : 0n;
}

function unsigned(value) {
  return /^\d+$/u.test(String(value ?? ""));
}

function sum(values) {
  return values.reduce((total, value) => total + BigInt(value ?? 0), 0n);
}

function usdcRaw(value) {
  const normalized = Number(value ?? 0);
  if (!Number.isFinite(normalized) || normalized <= 0) return 0n;
  return BigInt(Math.round(normalized * 10 ** USDC_DECIMALS));
}

function compareRawDescending(left, right) {
  const a = BigInt(left);
  const b = BigInt(right);
  return a === b ? 0 : a > b ? -1 : 1;
}

function inWindow(timestamp, startMs, endMs) {
  const value = Date.parse(timestamp ?? "");
  return Number.isFinite(value) && value >= startMs && value <= endMs;
}

function normalizeLedgerSeverity(value, fallback) {
  const severity = String(value ?? "").toLowerCase();
  if (["error", "critical", "warning", "warn"].includes(severity)) return "warn";
  if (["success", "ok"].includes(severity)) return "ok";
  return fallback ?? "info";
}

function asIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new ValidationError("Overnight ledger clock is invalid.");
  return date.toISOString();
}
