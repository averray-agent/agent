import { randomUUID } from "node:crypto";
import { lockedTierActivationGate } from "./locked-tier-service.js";
import { GuardedSchedulerLoop } from "./guarded-scheduler-loop.js";

const JOURNAL = "pool-v22:movement";
const RUN_LOCK = "pool-v22:locked-keeper";
const MAX_ENTRIES = 100;
const MAX_TERM = 90 * 86400;
const seconds = (date) => Math.floor(Date.parse(date) / 1000);
const allocated = (entry) => BigInt(entry.poolV22?.sharesRaw ?? "0") > 0n;

export function sharedCommitmentPlan(entries, candidate, snapshot) {
  const participants = entries.filter(allocated);
  if (candidate && seconds(candidate.commitmentConsentUntil) < snapshot.committedUntil) {
    return { allowed: false, reason: "lock_shorter_than_shared_commitment" };
  }
  const cohort = candidate ? [...participants, candidate] : participants;
  if (!cohort.length) return { allowed: false, reason: "no_consented_participants" };
  const ends = cohort.map((e) => Math.min(seconds(e.expiresAt), seconds(e.commitmentConsentUntil)));
  if (ends.some((end) => !Number.isSafeInteger(end))) return { allowed: false, reason: "commitment_consent_unreadable" };
  if (cohort.some((e) => e.status !== "active") || Math.min(...ends) <= snapshot.now) {
    return { allowed: false, reason: "participant_exit_pending" };
  }
  const until = Math.min(snapshot.now + MAX_TERM, ...ends);
  if (until < snapshot.committedUntil) return { allowed: false, reason: "shared_commitment_exceeds_consent" };
  return { allowed: true, committedUntil: until,
    isolationTrigger: cohort.some((e) => e.tier === "t90" && seconds(e.commitmentConsentUntil) > until
      && ends.some((end) => end === until)) };
}

export function assertPositionReconciled(entries, snapshot) {
  const expected = new Map();
  for (const entry of entries.filter(allocated)) {
    const wallet = entry.wallet.toLowerCase();
    expected.set(wallet, (expected.get(wallet) ?? 0n) + BigInt(entry.poolV22.sharesRaw));
  }
  let total = 0n;
  for (const [wallet, account] of Object.entries(snapshot.accounts)) {
    if (BigInt(account.sharesRaw) !== (expected.get(wallet) ?? 0n)) throw new Error("pool_v22_position_unreconciled");
    total += BigInt(account.sharesRaw);
  }
  if (total !== BigInt(snapshot.totalSharesRaw)) throw new Error("pool_v22_unknown_participant");
}

export class PoolV22LockedKeeper {
  constructor({ config, stateStore, chain, lockedTierService, logger = console }) {
    Object.assign(this, { config, stateStore, chain, lockedTierService });
    this.running = false;
    this.scheduler = new GuardedSchedulerLoop({ host: this, name: "pool-v22-locked-keeper", intervalMs: 60_000,
      runOnce: () => this.runOnce(), logger });
  }
  start() { if (this.config.enabled && !this.running) { this.running = true; void this.scheduler.runOnceAndSchedule(); } }
  stop() { this.running = false; this.scheduler.stop(); }

  async runOnce() {
    if (!this.config.enabled) return { status: "disabled", reason: "ceremony_c_or_keeper_disabled" };
    const owner = randomUUID();
    if (!await this.stateStore.acquireClaimLock(RUN_LOCK, owner, 1800)) return { status: "refused", reason: "keeper_lock_held" };
    try {
      // A pre-send durable intent survives crash/timeout. NEVER resend an
      // ambiguous funds movement; the operator reconciles its transaction first.
      if ((await this.stateStore.getServiceState(JOURNAL))?.pending) return { status: "refused", reason: "movement_reconciliation_required" };
      let entries = await this.stateStore.listLockedTierEntries();
      if (entries.length > MAX_ENTRIES) throw new Error("pool_v22_scan_limit_exceeded");
      const snapshot = await this.chain.snapshot(entries.map((e) => e.wallet));
      assertPositionReconciled(entries, snapshot);
      const exiting = entries.find((e) => allocated(e) && (e.status !== "active" || seconds(e.expiresAt) <= snapshot.now));
      // Exit never requires consent or an open activation gate.
      if (exiting) return await this.#exit(exiting, snapshot);
      const gate = lockedTierActivationGate(entries, new Date(snapshot.now * 1000), {
        measuredRate: await this.lockedTierService.readMeasuredVenueRate()
      });
      if (!gate.open) return { status: "refused", reason: gate.blockers[0], blockers: gate.blockers };
      const candidate = entries.find((e) => e.status === "active" && e.tier !== "t7" && !allocated(e) && seconds(e.expiresAt) > snapshot.now);
      const plan = sharedCommitmentPlan(entries, candidate, snapshot);
      if (!plan.allowed) {
        if (candidate) await this.#record(candidate, { status: "idle", reason: plan.reason });
        return { status: "refused", reason: plan.reason };
      }
      // Re-read signed consent for ALL co-depositors at the attempt, never cache it.
      for (const entry of [...entries.filter(allocated), ...(candidate ? [candidate] : [])]) {
        if (!await this.lockedTierService.allocationConsentCovers(entry)) {
          if (candidate) await this.#record(candidate, { status: "idle", reason: "commitment_consent_missing_or_revoked" });
          return { status: "refused", reason: "commitment_consent_missing_or_revoked" };
        }
      }
      if (candidate) {
        const account = snapshot.accounts[candidate.wallet.toLowerCase()];
        if (BigInt(account.liquidRaw) < BigInt(candidate.amountRaw) || BigInt(account.debtRaw) > 0n) {
          await this.#record(candidate, { status: "idle", reason: "locked_principal_unavailable" });
          return { status: "refused", reason: "locked_principal_unavailable" };
        }
        await this.#intent("allocate", candidate.id);
        await this.#guardAttempt(plan, candidate);
        await this.chain.allocate(candidate.wallet, candidate.amountRaw);
        const after = await this.chain.snapshot(entries.map((e) => e.wallet));
        const shares = BigInt(after.accounts[candidate.wallet.toLowerCase()].sharesRaw) - BigInt(account.sharesRaw);
        if (shares <= 0n) throw new Error("pool_v22_allocation_receipt_unreconciled");
        await this.#record(candidate, { status: "float", sharesRaw: String(shares), amountRaw: candidate.amountRaw });
        await this.#finishIntent();
        // The next tick re-reads every consent and gate BEFORE the pool deposit.
        return { status: "allocated", amountRaw: candidate.amountRaw };
      }
      if (BigInt(snapshot.floatRaw) > 0n) {
        await this.#intent("sweep_and_commit");
        await this.#guardAttempt(plan);
        await this.chain.sweep(snapshot.floatRaw, plan.committedUntil);
        await this.#finishIntent();
      } else if (BigInt(snapshot.poolSharesRaw) > 0n && plan.committedUntil > snapshot.committedUntil) {
        await this.#intent("commit");
        await this.#guardAttempt(plan);
        await this.chain.commit(plan.committedUntil);
        await this.#finishIntent();
      }
      if (plan.isolationTrigger) await this.stateStore.upsertServiceState("pool-v22:isolation-trigger", {
        triggered: true, reason: "t90_limited_by_co_depositor", committedUntil: plan.committedUntil
      });
      return { status: "committed", committedUntil: plan.committedUntil, isolationTrigger: plan.isolationTrigger };
    } catch (error) {
      return { status: "refused", reason: /^pool_v22_[a-z_]+$/u.test(error.message ?? "")
        ? error.message : "pool_v22_movement_or_read_failed" };
    } finally { await this.stateStore.releaseClaimLock(RUN_LOCK, owner); }
  }

  async #exit(entry, snapshot) {
    if (snapshot.committedUntil > snapshot.now) return { status: "exit_pending", committedUntil: snapshot.committedUntil };
    const exitState = await this.stateStore.getServiceState("pool-v22:exit");
    if (exitState?.requestId) {
      const request = await this.chain.readExit(exitState.requestId);
      if (!request.fulfilled) {
        if (request.unlockAt > snapshot.now) return { status: "exit_pending", releaseAt: request.unlockAt };
        await this.#intent("fulfil_exit");
        await this.chain.fulfilExit(exitState.requestId);
        await this.#finishIntent();
      }
      await this.stateStore.upsertServiceState("pool-v22:exit", { requestId: null });
      return { status: "exit_recalled" };
    }
    if (BigInt(snapshot.poolSharesRaw) > 0n) {
      await this.#intent("request_exit");
      const request = await this.chain.requestExit(snapshot.poolSharesRaw);
      await this.stateStore.upsertServiceState("pool-v22:exit", request);
      await this.#finishIntent();
      return { status: "exit_pending", requestId: request.requestId };
    }
    const amount = BigInt(entry.poolV22.sharesRaw) * BigInt(snapshot.totalAssetsRaw) / BigInt(snapshot.totalSharesRaw);
    if (amount <= 0n || amount > BigInt(snapshot.floatRaw)) return { status: "exit_pending", reason: "recall_liquidity_unavailable" };
    await this.#intent("deallocate", entry.id);
    await this.chain.deallocate(entry.wallet, String(amount));
    const after = await this.chain.snapshot([entry.wallet]);
    const burned = BigInt(snapshot.accounts[entry.wallet.toLowerCase()].sharesRaw) - BigInt(after.accounts[entry.wallet.toLowerCase()].sharesRaw);
    if (burned <= 0n || burned > BigInt(entry.poolV22.sharesRaw)) throw new Error("pool_v22_exit_unreconciled");
    const remaining = BigInt(entry.poolV22.sharesRaw) - burned;
    await this.#record(entry, { sharesRaw: String(remaining), status: remaining === 0n ? "returned" : "exit_dust",
      returnedAssetsRaw: String(amount), principalHaircutRaw: "0" });
    await this.#finishIntent();
    return { status: remaining === 0n ? "returned" : "exit_dust" };
  }

  async #record(entry, state) {
    // Do not overwrite an exit submitted while a chain transaction was pending.
    const latest = (await this.stateStore.listLockedTierEntries(entry.wallet)).find((e) => e.id === entry.id);
    if (!latest) throw new Error("pool_v22_lock_missing");
    await this.stateStore.upsertLockedTierEntry({ ...latest, poolV22: { ...latest.poolV22, ...state } });
  }
  async #guardAttempt(plan, candidate) {
    // Persisting the intent can yield long enough for an exit or revocation.
    // Re-read AFTER that boundary, immediately before the chain call. Failure
    // here is known pre-send, so clearing this intent cannot cause a resend.
    try {
      const entries = await this.stateStore.listLockedTierEntries();
      if (entries.length > MAX_ENTRIES) throw new Error("pool_v22_scan_limit_exceeded");
      const snapshot = await this.chain.snapshot(entries.map((e) => e.wallet));
      assertPositionReconciled(entries, snapshot);
      const latest = candidate && entries.find((e) => e.id === candidate.id);
      if (candidate && (!latest || latest.amountRaw !== candidate.amountRaw || latest.wallet !== candidate.wallet || allocated(latest))) {
        throw new Error("pool_v22_lock_changed_before_send");
      }
      const freshPlan = sharedCommitmentPlan(entries, latest, snapshot);
      if (!freshPlan.allowed || freshPlan.committedUntil < plan.committedUntil || snapshot.committedUntil > plan.committedUntil) {
        throw new Error("pool_v22_commitment_changed_before_send");
      }
      const gate = lockedTierActivationGate(entries, new Date(snapshot.now * 1000), {
        measuredRate: await this.lockedTierService.readMeasuredVenueRate()
      });
      if (!gate.open) throw new Error("pool_v22_gate_closed_before_send");
      for (const entry of [...entries.filter(allocated), ...(latest ? [latest] : [])]) {
        if (!await this.lockedTierService.allocationConsentCovers(entry)) {
          throw new Error("pool_v22_consent_missing_or_revoked_before_send");
        }
      }
    } catch (error) {
      await this.#finishIntent();
      throw error;
    }
  }
  async #intent(operation, lockId = null) {
    await this.stateStore.upsertServiceState(JOURNAL, { pending: true, operation, lockId });
  }
  async #finishIntent() { await this.stateStore.upsertServiceState(JOURNAL, { pending: false }); }
}
