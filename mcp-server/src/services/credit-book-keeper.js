import { getAddress } from "ethers";

const BPS = 10_000n;

export class CreditBookKeeperService {
  constructor({ creditBookDoor, gateway, now = () => new Date(), logger = console } = {}) {
    this.creditBookDoor = creditBookDoor;
    this.gateway = gateway;
    this.now = now;
    this.logger = logger;
  }

  /// Runs only after the payout has been proven and persisted. Every failure
  /// is returned as a paused sweep, never thrown into the settlement path.
  async afterSettlement({ session, payoutTx } = {}) {
    try {
      const settlement = payoutTx?.settlement;
      if (!session?.wallet || !settlement?.workerAmountRaw) {
        return { status: "not_applicable", reason: "settlement_split_unavailable" };
      }
      if (getAddress(settlement.worker) !== getAddress(session.wallet)) {
        return { status: "paused", reason: "settlement_worker_mismatch" };
      }
      const info = await this.creditBookDoor.getInfo(session.wallet);
      if (!info.available) return { status: "not_applicable", reason: info.reason };
      const loans = [info.wallet.cash.activeLoan, info.wallet.posting.activeLoan].filter(Boolean);
      if (loans.length === 0) return { status: "not_applicable", reason: "no_open_loan" };

      let remaining = BigInt(settlement.workerAmountRaw) * BigInt(info.schedule.repayBps) / BPS;
      const sweeps = [];
      for (const loan of loans) {
        if (remaining === 0n) break;
        const amountRaw = remaining < BigInt(loan.outstanding.raw)
          ? remaining
          : BigInt(loan.outstanding.raw);
        const consent = await this.creditBookDoor.getConsent(loan.termsHash);
        const authorizationState = await this.#findAuthorization(consent, amountRaw);
        if (!authorizationState) {
          const expired = consent.repaymentAuthorizations.some(
            (candidate) => BigInt(candidate.amount) === amountRaw
              && BigInt(candidate.deadline) <= BigInt(Math.floor(this.now().getTime() / 1_000))
          );
          return {
            status: "paused",
            reason: expired ? "authorization_expired" : "exact_authorization_missing",
            loanId: loan.loanId,
            requestedAmountRaw: amountRaw.toString(),
            completedSweeps: sweeps
          };
        }
        const { authorization, alreadyTransferred } = authorizationState;
        const transfer = alreadyTransferred
          ? { txHash: null, recoveredFromUsedAuthorization: true }
          : await this.gateway.submitAuthorizedAgentTransfer({
              ...authorization,
              amountRaw: authorization.amount
            });
        const recorded = await this.gateway.recordCreditBookSweep(loan.loanId, amountRaw);
        sweeps.push({
          loanId: loan.loanId,
          amountRaw: amountRaw.toString(),
          transferTxHash: transfer.txHash,
          recordTxHash: recorded.txHash
        });
        remaining -= amountRaw;
      }
      return { status: "swept", payoutRaw: String(settlement.workerAmountRaw), sweeps };
    } catch (error) {
      this.logger.warn?.(
        { sessionId: session?.sessionId, error: error?.message ?? String(error) },
        "credit_book.sweep_paused"
      );
      return {
        status: "paused",
        reason: error?.code ?? "sweep_failed",
        message: error?.message ?? String(error)
      };
    }
  }

  async #findAuthorization(consent, amountRaw) {
    const nowSeconds = BigInt(Math.floor(this.now().getTime() / 1_000));
    let usedCandidate;
    for (const candidate of consent.repaymentAuthorizations ?? []) {
      if (BigInt(candidate.amount) !== amountRaw || BigInt(candidate.deadline) <= nowSeconds) continue;
      if (typeof this.gateway.isSendToAgentAuthorizationUsed === "function") {
        const alreadyTransferred = await this.gateway.isSendToAgentAuthorizationUsed(
          candidate.from,
          candidate.nonce
        );
        if (alreadyTransferred) {
          usedCandidate ??= candidate;
          continue;
        }
      }
      return { authorization: candidate, alreadyTransferred: false };
    }
    return usedCandidate
      ? { authorization: usedCandidate, alreadyTransferred: true }
      : undefined;
  }
}
