import { randomUUID } from "node:crypto";

import { Contract, ZeroAddress, getAddress } from "ethers";

import { CREDIT_BOOK_ABI } from "../blockchain/abis.js";
import { ConfigError, ConflictError, NotFoundError } from "../core/errors.js";

export const LIVE_CREDIT_BOOK_ADDRESS = "0x70441c9131Bc47c96E8D839C5B30850924838099";
export const L3_DISABLED_REASON = "l3_disabled";
export const L3_POSTING_LIMIT_RAW = 25_000_000n;

const POSTING_MODE = "POSTING";
const ESCROW_STATE_CLOSED = 6;
const ESCROW_STATE_CANCELLED = 7;
const SWEEP_INTERVAL_MS = 30_000;
const LOCK_TTL_SECONDS = 300;
const ACTIVE_REQUEST_STATES = new Set([
  "requested",
  "originating",
  "posted",
  "awaiting_refund_transfer",
  "awaiting_sweep_repayment"
]);

export class EvmL3PostingChainReader {
  constructor({ provider, creditBookAddress = LIVE_CREDIT_BOOK_ADDRESS } = {}) {
    this.provider = provider;
    this.creditBookAddress = getAddress(creditBookAddress || LIVE_CREDIT_BOOK_ADDRESS);
  }

  async readControl() {
    if (!this.provider) throw new Error("L3 CreditBook provider is unavailable.");
    const blockNumber = Number(await this.provider.getBlockNumber());
    const block = await this.provider.getBlock(blockNumber);
    const book = new Contract(this.creditBookAddress, CREDIT_BOOK_ABI, this.provider);
    const at = { blockTag: blockNumber };
    const [enabled, posterWallet] = await Promise.all([
      book.l3Enabled(at),
      book.l3PosterWallet(at)
    ]);
    return {
      enabled: Boolean(enabled),
      posterWallet: getAddress(posterWallet),
      creditBookAddress: this.creditBookAddress,
      blockNumber,
      blockHash: block?.hash ?? null
    };
  }
}

export class L3PostingKeeperService {
  constructor({
    creditBookAddress = LIVE_CREDIT_BOOK_ADDRESS,
    provider,
    chainReader,
    creditBookDoor,
    stateStore,
    gateway,
    eventBus,
    logger = console,
    now = () => new Date(),
    sweepIntervalMs = SWEEP_INTERVAL_MS
  } = {}) {
    this.creditBookAddress = getAddress(creditBookAddress || LIVE_CREDIT_BOOK_ADDRESS);
    if (this.creditBookAddress !== getAddress(LIVE_CREDIT_BOOK_ADDRESS)) {
      throw new ConfigError(
        `L3 posting keeper must read the live CreditBook at ${LIVE_CREDIT_BOOK_ADDRESS}.`
      );
    }
    this.chainReader = chainReader ?? (provider
      ? new EvmL3PostingChainReader({ provider, creditBookAddress: this.creditBookAddress })
      : undefined);
    this.creditBookDoor = creditBookDoor;
    this.stateStore = stateStore;
    this.gateway = gateway;
    this.eventBus = eventBus;
    this.logger = logger;
    this.now = now;
    this.sweepIntervalMs = sweepIntervalMs;
    this.timer = undefined;
  }

  start() {
    if (this.timer || !this.chainReader) return;
    this.timer = setInterval(() => {
      this.#poll().catch((error) => {
        this.logger.warn?.({ error: error?.message ?? String(error) }, "l3_posting.poll_failed");
      });
    }, this.sweepIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async enqueue({ termsHash } = {}) {
    const control = await this.#requireEnabled("enqueue");
    this.#requireRuntime();
    const consent = await this.creditBookDoor.getConsent(termsHash);
    if (consent?.terms?.mode !== POSTING_MODE) {
      return this.#refuse(
        "l3_posting_terms_required",
        "L3 posting requests require POSTING-mode consent terms.",
        { entryPoint: "enqueue", termsHash: consent?.termsHash }
      );
    }
    const borrower = getAddress(consent.wallet);
    return this.#withLock(`l3-posting-borrower:${borrower.toLowerCase()}`, async () => {
      const existing = await this.stateStore.getL3PostingRequest(consent.termsHash);
      if (existing) return existing;

      const info = await this.creditBookDoor.getInfo(borrower);
      if (!info.available || !info.underwriting?.available) {
        return this.#refuse(
          "l3_underwriting_unavailable",
          "Receipt-graph underwriting is unavailable for this L3 request.",
          { entryPoint: "enqueue", borrower }
        );
      }
      if (info.wallet.posting.activeLoan) {
        return this.#refuse(
          "l3_active_posting_loan",
          "A POSTING loan is already active for this borrower.",
          { entryPoint: "enqueue", borrower, loanId: info.wallet.posting.activeLoan.loanId }
        );
      }
      const concurrent = (await this.stateStore.listL3PostingRequests({ borrower }))
        .find((record) => ACTIVE_REQUEST_STATES.has(record.status));
      if (concurrent) {
        return this.#refuse(
          "l3_active_request",
          "An L3 posting request is already active for this borrower.",
          { entryPoint: "enqueue", borrower, requestId: concurrent.id }
        );
      }

      const trailingNetRaw = BigInt(info.underwriting.trailingNetRaw ?? 0);
      const receiptGraphLimitRaw = BigInt(info.underwriting.postingLimitRaw ?? 0);
      const earningsLimitRaw = info.underwriting.disqualified
        ? 0n
        : (trailingNetRaw < receiptGraphLimitRaw ? trailingNetRaw : receiptGraphLimitRaw);
      const keeperLimitRaw = earningsLimitRaw < L3_POSTING_LIMIT_RAW
        ? earningsLimitRaw
        : L3_POSTING_LIMIT_RAW;
      const outstandingRaw = BigInt(info.wallet.posting.outstanding.raw);
      const keeperHeadroomRaw = keeperLimitRaw > outstandingRaw
        ? keeperLimitRaw - outstandingRaw
        : 0n;
      const liveHeadroomRaw = BigInt(info.wallet.posting.headroom.raw);
      const effectiveHeadroomRaw = keeperHeadroomRaw < liveHeadroomRaw
        ? keeperHeadroomRaw
        : liveHeadroomRaw;
      if (trailingNetRaw === 0n || keeperLimitRaw === 0n) {
        return this.#refuse(
          "l3_underwriting_zero",
          "Trailing verified net earnings produce an L3 posting limit of zero.",
          { entryPoint: "enqueue", borrower }
        );
      }
      const amountRaw = BigInt(consent.terms.amountRaw);
      if (amountRaw > effectiveHeadroomRaw) {
        return this.#refuse(
          "l3_limit_exceeded",
          "The requested posting principal exceeds current receipt-graph headroom.",
          {
            entryPoint: "enqueue",
            borrower,
            requestedRaw: amountRaw.toString(),
            headroomRaw: effectiveHeadroomRaw.toString(),
            keeperLimitRaw: keeperLimitRaw.toString()
          }
        );
      }
      if (getAddress(control.posterWallet) !== getAddress(info.book.l3PosterWallet)) {
        return this.#refuse(
          "l3_poster_binding_changed",
          "The posting identity changed between the dedicated chain reads.",
          { entryPoint: "enqueue", borrower }
        );
      }

      const createdAt = this.#timestamp();
      const record = {
        id: consent.termsHash,
        kind: "l3_posting_request_v1",
        status: "requested",
        borrower,
        posterWallet: getAddress(control.posterWallet),
        creditBookAddress: this.creditBookAddress,
        asset: getAddress(info.asset),
        amountRaw: amountRaw.toString(),
        termsHash: consent.termsHash,
        termsPreimage: consent.terms,
        jobDefinition: consent.terms.jobDefinition,
        underwriting: {
          ...info.underwriting,
          keeperLimitRaw: keeperLimitRaw.toString(),
          keeperHeadroomRaw: effectiveHeadroomRaw.toString()
        },
        bookBefore: {
          accountedLiquidityRaw: info.book.accountedLiquidity.raw,
          liquidRaw: info.book.liquid.raw,
          outstandingRaw: info.book.outstanding.raw
        },
        control: controlProof(control),
        createdAt,
        updatedAt: createdAt
      };
      const stored = await this.stateStore.upsertL3PostingRequest(record);
      this.#publish("l3.posting_requested", stored);
      return stored;
    }, {
      busyReason: "l3_active_request",
      busyMessage: "An L3 posting request is already being admitted for this borrower.",
      busyDetails: { entryPoint: "enqueue", borrower }
    });
  }

  async get(id) {
    await this.#requireEnabled("get");
    this.#requireRuntime();
    return this.#getRecord(id);
  }

  async list(options = {}) {
    await this.#requireEnabled("list");
    this.#requireRuntime();
    return this.stateStore.listL3PostingRequests(options);
  }

  async listRefusals(options = {}) {
    await this.#requireEnabled("list_refusals");
    this.#requireRuntime();
    return this.stateStore.listL3PostingRefusals(options);
  }

  async advance(id) {
    const control = await this.#requireEnabled("advance");
    this.#requireRuntime();
    const initial = await this.#getRecord(id);
    return this.#withLock(`l3-posting-borrower:${initial.borrower.toLowerCase()}`, async () => {
      const record = await this.#getRecord(id);
      if (["posted", "awaiting_sweep_repayment", "repaid"].includes(record.status)) return record;
      if (record.status !== "requested" && record.status !== "originating") {
        throw new ConflictError(
          `L3 posting request cannot advance from ${record.status}.`,
          "l3_request_state_invalid",
          { requestId: record.id, status: record.status }
        );
      }
      if (getAddress(control.posterWallet) !== getAddress(record.posterWallet)) {
        return this.#refuse(
          "l3_poster_binding_changed",
          "The live L3 poster wallet changed after request intake.",
          { entryPoint: "advance", requestId: record.id, borrower: record.borrower }
        );
      }
      let updated = await this.#checkpoint(record, {
        status: "originating",
        control: controlProof(control)
      });
      const origination = await this.creditBookDoor.originateConsentedLoan(record.termsHash, {
        l3Keeper: true,
        expectedPosterWallet: control.posterWallet
      });
      const posting = origination?.origination?.posting;
      if (!posting?.jobId) {
        throw new ConflictError(
          "L3 posting did not produce a reconciled external job.",
          "l3_posting_confirmation_missing",
          { requestId: record.id }
        );
      }
      updated = await this.#checkpoint(updated, {
        status: "posted",
        loanId: origination.origination.loanId,
        origination: origination.origination,
        jobId: String(posting.jobId).toLowerCase(),
        postedAt: this.#timestamp()
      });
      this.#publish("l3.posting_posted", updated);
      return updated;
    });
  }

  async reconcile(id) {
    await this.#requireEnabled("reconcile");
    this.#requireRuntime();
    const initial = await this.#getRecord(id);
    if (initial.status === "requested" || initial.status === "originating") {
      return this.advance(initial.id);
    }
    return this.#withLock(`l3-posting-borrower:${initial.borrower.toLowerCase()}`, async () => {
      const record = await this.#getRecord(id);
      if (record.status === "repaid") return record;
      if (!record.jobId) {
        throw new ConflictError("L3 request has no posted job to reconcile.", "l3_job_missing");
      }
      const liveJob = await this.gateway.getJob(record.jobId);
      if (Number(liveJob.state) === ESCROW_STATE_CANCELLED) {
        return this.#completeRefund(record);
      }
      if (Number(liveJob.state) === ESCROW_STATE_CLOSED) {
        const info = await this.creditBookDoor.getInfo(record.borrower);
        const closed = !info.available || !info.wallet.posting.activeLoan;
        return this.#checkpoint(record, {
          status: closed ? "repaid" : "awaiting_sweep_repayment",
          escrowState: Number(liveJob.state),
          reconciledAt: this.#timestamp()
        });
      }
      return this.#checkpoint(record, {
        status: "posted",
        escrowState: Number(liveJob.state),
        reconciledAt: this.#timestamp()
      });
    });
  }

  async sweep({ limit = 50 } = {}) {
    await this.#requireEnabled("sweep");
    this.#requireRuntime();
    const records = await this.stateStore.listL3PostingRequests({ limit });
    const results = [];
    for (const record of records.filter((item) => ACTIVE_REQUEST_STATES.has(item.status))) {
      try {
        const result = record.status === "requested" || record.status === "originating"
          ? await this.advance(record.id)
          : await this.reconcile(record.id);
        results.push({ id: record.id, status: result.status });
      } catch (error) {
        await this.#checkpoint(record, {
          lastError: { code: error?.code ?? "l3_sweep_failed", message: error?.message ?? String(error) }
        });
        results.push({ id: record.id, status: "error", reason: error?.code ?? "l3_sweep_failed" });
      }
    }
    return { scanned: records.length, processed: results.length, results };
  }

  async #completeRefund(record) {
    let updated = record;
    let info = await this.creditBookDoor.getInfo(updated.borrower);
    if (!info.available) {
      throw new ConflictError("CreditBook live state is unavailable.", "credit_book_live_read_failed");
    }
    if (!info.wallet.posting.activeLoan) {
      return this.#finishRepaidRefund(updated, info, { recoveredFromChain: true });
    }
    const requiredRaw = BigInt(info.wallet.posting.activeLoan.outstanding.raw);
    const unaccountedRaw = BigInt(info.book.liquid.raw) - BigInt(info.book.accountedLiquidity.raw);
    if (unaccountedRaw < requiredRaw) {
      return this.#checkpoint(updated, {
        status: "awaiting_refund_transfer",
        refund: {
          ...(updated.refund ?? {}),
          requiredRaw: requiredRaw.toString(),
          observedUnaccountedRaw: (unaccountedRaw > 0n ? unaccountedRaw : 0n).toString(),
          transport: "existing_consent_gated_admin_agent_transfer"
        }
      });
    }
    const repayment = await this.gateway.recordCreditBookRefund(updated.loanId);
    updated = await this.#checkpoint(updated, {
      refund: {
        ...(updated.refund ?? {}),
        requiredRaw: requiredRaw.toString(),
        observedUnaccountedRaw: unaccountedRaw.toString(),
        transport: "existing_consent_gated_admin_agent_transfer",
        repayment
      }
    });
    info = await this.creditBookDoor.getInfo(updated.borrower);
    if (!info.available || info.wallet.posting.activeLoan) {
      throw new ConflictError(
        "Cancelled L3 loan remains active after refund repayment.",
        "l3_refund_reconciliation_failed",
        { requestId: updated.id }
      );
    }
    return this.#finishRepaidRefund(updated, info);
  }

  async #finishRepaidRefund(record, info, extraRefund = {}) {
    if (
      info.book.accountedLiquidity.raw !== record.bookBefore.accountedLiquidityRaw
      || info.book.liquid.raw !== record.bookBefore.liquidRaw
    ) {
      throw new ConflictError(
        "Cancelled L3 posting did not make the CreditBook whole to the raw unit.",
        "l3_book_not_whole",
        {
          requestId: record.id,
          expectedAccountedRaw: record.bookBefore.accountedLiquidityRaw,
          observedAccountedRaw: info.book.accountedLiquidity.raw,
          expectedLiquidRaw: record.bookBefore.liquidRaw,
          observedLiquidRaw: info.book.liquid.raw
        }
      );
    }
    const updated = await this.#checkpoint(record, {
      status: "repaid",
      refund: { ...(record.refund ?? {}), ...extraRefund },
      repaidAt: this.#timestamp(),
      bookAfter: {
        accountedLiquidityRaw: info.book.accountedLiquidity.raw,
        liquidRaw: info.book.liquid.raw,
        outstandingRaw: info.book.outstanding.raw
      }
    });
    this.#publish("l3.posting_repaid_from_refund", updated);
    return updated;
  }

  async #poll() {
    let control;
    try {
      control = await this.chainReader.readControl();
    } catch (error) {
      this.logger.warn?.({ error: error?.message ?? String(error) }, "l3_posting.control_read_failed");
      return;
    }
    // The poller is always installed. The chain flag alone decides whether
    // the dormant module does work; there is no backend enablement switch.
    if (!control.enabled) return;
    await this.sweep();
  }

  async #requireEnabled(entryPoint) {
    if (!this.chainReader) throw new ConfigError("L3 posting chain reader is unavailable.");
    const control = await this.chainReader.readControl();
    if (!control.enabled) {
      return this.#refuse(
        L3_DISABLED_REASON,
        "L3 posting credit is disabled on CreditBook.",
        { entryPoint, control: controlProof(control) }
      );
    }
    if (getAddress(control.posterWallet) === ZeroAddress) {
      return this.#refuse(
        "l3_poster_unavailable",
        "CreditBook has no L3 poster wallet.",
        { entryPoint, control: controlProof(control) }
      );
    }
    return control;
  }

  #requireRuntime() {
    const methods = [
      [this.creditBookDoor, "getConsent"],
      [this.creditBookDoor, "getInfo"],
      [this.creditBookDoor, "originateConsentedLoan"],
      [this.gateway, "getJob"],
      [this.gateway, "recordCreditBookRefund"],
      [this.stateStore, "getL3PostingRequest"],
      [this.stateStore, "upsertL3PostingRequest"],
      [this.stateStore, "listL3PostingRequests"],
      [this.stateStore, "appendL3PostingRefusal"],
      [this.stateStore, "listL3PostingRefusals"],
      [this.stateStore, "acquireClaimLock"],
      [this.stateStore, "releaseClaimLock"]
    ];
    const missing = methods.filter(([owner, method]) => typeof owner?.[method] !== "function")
      .map(([, method]) => method);
    if (missing.length > 0) {
      throw new ConfigError("L3 posting keeper runtime is incomplete.", { missing });
    }
  }

  async #getRecord(id) {
    const record = await this.stateStore.getL3PostingRequest(String(id ?? "").toLowerCase());
    if (!record) throw new NotFoundError("L3 posting request not found.", "l3_request_not_found");
    return record;
  }

  async #checkpoint(record, patch) {
    return this.stateStore.upsertL3PostingRequest({
      ...record,
      ...patch,
      updatedAt: this.#timestamp()
    });
  }

  async #withLock(lockId, operation, {
    busyReason = "l3_request_in_progress",
    busyMessage = "L3 posting request is already being processed.",
    busyDetails = undefined
  } = {}) {
    const owner = randomUUID();
    const acquired = await this.stateStore.acquireClaimLock(lockId, owner, LOCK_TTL_SECONDS);
    if (!acquired) return this.#refuse(busyReason, busyMessage, busyDetails);
    try {
      return await operation();
    } finally {
      await this.stateStore.releaseClaimLock(lockId, owner);
    }
  }

  async #refuse(reason, message, details = {}) {
    const refusal = {
      id: randomUUID(),
      kind: "l3_posting_refusal_v1",
      reason,
      message,
      ...details,
      refusedAt: this.#timestamp()
    };
    try {
      await this.stateStore?.appendL3PostingRefusal?.(refusal);
    } catch (error) {
      this.logger.warn?.(
        { reason, error: error?.message ?? String(error) },
        "l3_posting.refusal_store_failed"
      );
    }
    this.logger.warn?.(refusal, "l3_posting.refused");
    throw new ConflictError(message, reason, details);
  }

  #publish(topic, record) {
    this.eventBus?.publish?.({
      id: `${topic}-${record.id}-${Date.now()}`,
      topic,
      wallet: record.borrower,
      wallets: [record.borrower, record.posterWallet],
      jobId: record.jobId,
      timestamp: this.#timestamp(),
      correlationId: record.id,
      source: "platform",
      phase: "credit",
      severity: "info",
      data: {
        requestId: record.id,
        loanId: record.loanId,
        status: record.status
      }
    });
  }

  #timestamp() {
    return this.now().toISOString();
  }
}

function controlProof(control) {
  return {
    enabled: Boolean(control.enabled),
    posterWallet: getAddress(control.posterWallet),
    creditBookAddress: getAddress(control.creditBookAddress ?? LIVE_CREDIT_BOOK_ADDRESS),
    blockNumber: control.blockNumber ?? null,
    blockHash: control.blockHash ?? null
  };
}
