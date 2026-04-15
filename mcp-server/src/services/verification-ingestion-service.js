export class VerificationIngestionService {
  constructor(stateStore) {
    this.stateStore = stateStore;
  }

  async ingest(verdict) {
    const session = await this.stateStore.findSessionByJobId(verdict.jobId);
    if (!session) {
      return undefined;
    }

    const status = verdict.outcome === "approved"
      ? "resolved"
      : verdict.outcome === "disputed"
        ? "disputed"
        : "verifying";

    return this.stateStore.upsertSession({
      ...session,
      status
    });
  }
}
