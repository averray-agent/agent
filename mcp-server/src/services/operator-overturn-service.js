import { randomUUID } from "node:crypto";
import { ConfigError, ConflictError, NotFoundError, ValidationError } from "../core/errors.js";
import { assertJobSnapshotIntegrity } from "../core/job-snapshot.js";
import { transitionSession } from "../core/session-state-machine.js";

export class OperatorOverturnService {
  constructor({ stateStore, gateway, eventBus, now = () => new Date() }) {
    Object.assign(this, { stateStore, gateway, eventBus, now });
  }

  async overturn({ sessionId, rationale, operator }) {
    if (typeof sessionId !== "string" || !sessionId.trim() || typeof rationale !== "string" || !rationale.trim()) {
      throw new ValidationError("sessionId and rationale are required.");
    }
    if (!this.gateway?.isEnabled?.()) throw new ConfigError("Operator overturn requires the live escrow gateway.");
    const owner = randomUUID();
    const key = `operator-overturn:${sessionId}`;
    if (!await this.stateStore.acquireClaimLock(key, owner, 300)) {
      throw new ConflictError("Operator overturn is already in progress.", "overturn_in_progress");
    }
    try {
      let session = await this.stateStore.getSession(sessionId);
      if (!session) throw new NotFoundError(`Unknown session: ${sessionId}`, "session_not_found");
      if (session.operatorOverturn && ["disputed", "resolved"].includes(session.status)) return session;
      if (session.status !== "rejected") {
        throw new ConflictError("Operator overturn requires a rejected session.", "overturn_session_state_invalid");
      }
      const chainJobId = session.chainJobId ?? session.jobId;
      let live = await this.gateway.getJob(chainJobId);
      await assertJobSnapshotIntegrity(session, this.gateway, { liveJob: live });
      this.assertWorker(session, live);
      const state = Number(live.state);
      if (![4, 5].includes(state)) throw new ConflictError(`Cannot overturn escrow state ${state}.`, "overturn_chain_state_invalid");
      let windowEndsAt = session.operatorOverturn?.windowEndsAt;
      if (state === 4) {
        const seconds = Number(await this.gateway.getDisputeWindowSeconds());
        const rejectedAt = Number(live.rejectedAt);
        if (!Number.isFinite(seconds) || seconds <= 0 || !Number.isFinite(rejectedAt) || rejectedAt <= 0) {
          throw new ConflictError("Cannot establish the on-chain dispute window.", "overturn_window_unavailable");
        }
        windowEndsAt = new Date((rejectedAt + seconds) * 1000).toISOString();
        if (this.now().getTime() > Date.parse(windowEndsAt)) {
          throw new ConflictError(`The overturn window closed at ${windowEndsAt}.`, "overturn_window_closed", { windowEndsAt });
        }
      }
      // Durable before sending: the event listener must not label the brokered
      // participant as a worker-initiated dispute, even if this process dies.
      session = await this.stateStore.upsertSession({
        ...session,
        operatorOverturn: session.operatorOverturn ?? {
          origin: "operator_overturn", workerInitiated: false,
          rationale: rationale.trim(), operator, requestedAt: this.now().toISOString(),
          windowEndsAt, releasedBefore: Number(live.released ?? 0),
          remainingPayout: Math.max(Number(live.reward) - Number(live.released ?? 0), 0)
        }
      });
      if (state === 4) {
        await this.gateway.openDispute(chainJobId, session.wallet);
        live = await this.gateway.getJob(chainJobId);
        this.assertWorker(session, live);
      }
      if (Number(live.state) !== 5) throw new ConflictError("Escrow did not confirm Disputed.", "overturn_dispute_unconfirmed");
      const timestamp = this.now().toISOString();
      session = await this.stateStore.upsertSession(transitionSession({
        ...session, operatorOverturn: { ...session.operatorOverturn, openedAt: timestamp }
      }, "disputed", {
        reason: "platform_fault_operator_overturn", timestamp,
        metadata: { origin: "operator_overturn", workerInitiated: false, rationale: session.operatorOverturn.rationale }
      }));
      this.eventBus?.publish?.({
        id: `operator-overturn:${sessionId}`, topic: "platform.overturn_dispute_opened",
        sessionId, jobId: session.jobId, wallet: session.wallet, wallets: [session.wallet], timestamp,
        data: { chainJobId, ...session.operatorOverturn }
      });
      return session;
    } finally {
      await this.stateStore.releaseClaimLock(key, owner);
    }
  }

  assertWorker(session, live) {
    if (!live?.worker || live.worker.toLowerCase() !== session.wallet?.toLowerCase()) {
      throw new ConflictError("Escrow worker does not match the session wallet.", "overturn_worker_mismatch");
    }
  }
}
