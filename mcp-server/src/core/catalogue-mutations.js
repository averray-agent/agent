import { ConflictError } from "./errors.js";

// Single-backend write-through journal, like the policy/overlay stores. Seed
// and scheduled definitions are reproducible; only operator definitions and
// lifecycle overrides are durable. No hydration call touches funding rails.
export class CatalogueMutations {
  constructor(catalogue, stateStore) {
    this.catalogue = catalogue;
    this.stateStore = stateStore;
    this.records = new Map();
    this.queue = Promise.resolve();
  }

  async hydrate() {
    const records = await this.stateStore.listCatalogueMutations();
    for (const record of records) {
      if (record.schemaVersion !== 1 || record.jobId !== this.catalogue.normalizeId(record.jobId)) {
        throw new Error("invalid_catalogue_mutation");
      }
      this.records.set(record.jobId, record);
      if (record.definition) {
        if (record.origin !== "operator" || record.definition.id !== record.jobId) {
          throw new Error("invalid_operator_catalogue_definition");
        }
        // Already-normalized definitions must not be normalized a second time:
        // doing so can restamp lifecycle dates or change committed terms.
        this.catalogue.restoreJob(record.definition);
      }
      const job = this.catalogue.jobs.find(({ id }) => id === record.jobId);
      if (job && record.lifecycle) job.lifecycle = structuredClone(record.lifecycle);
    }
    return { operatorDefinitions: records.filter(({ definition }) => definition).length,
      lifecycleOverrides: records.filter(({ lifecycle }) => lifecycle).length,
      tombstones: records.filter(isRetired).length };
  }

  assertCanIngest(input) {
    const id = this.catalogue.normalizeId(input.id);
    const sourceKey = upstreamKey(input);
    const retired = [...this.records.values()].find((record) => isRetired(record)
      && (record.jobId === id || (sourceKey && record.sourceKey === sourceKey)));
    if (retired) throw new ConflictError("Catalogue retirement requires an explicit operator reopen.",
      "catalogue_job_retired", { jobId: id, retiredJobId: retired.jobId });
  }

  serialize(action) {
    const pending = this.queue.then(action);
    this.queue = pending.catch(() => {});
    return pending;
  }

  persistOperator(job) {
    return this.serialize(() => {
      this.assertCanIngest(job);
      return this.write(this.operatorRecord(job));
    });
  }

  operatorRecord(job) {
    return { schemaVersion: 1, jobId: job.id, origin: "operator", definition: structuredClone(job),
      lifecycle: structuredClone(job.lifecycle), sourceKey: upstreamKey(job) };
  }

  commitIngest(definition) {
    return this.serialize(async () => {
      this.assertCanIngest(definition);
      const before = this.catalogue.jobs.find(({ id }) => id === definition.id);
      const job = this.catalogue.upsertJob(definition);
      try {
        if (this.records.get(job.id)?.origin === "operator") await this.write(this.operatorRecord(job));
        return job;
      } catch (error) {
        if (before) this.catalogue.restoreJob(before);
        else this.catalogue.removeJob(job.id);
        throw error;
      }
    });
  }

  updateLifecycle(jobId, patch) {
    return this.serialize(async () => {
      const id = this.catalogue.normalizeId(jobId);
      const previous = this.records.get(id);
      const job = this.catalogue.jobs.find((entry) => entry.id === id);
      // Tombstones for reproducible rows have no definition after restart.
      // Reopening such a row changes only its override; ingest supplies terms.
      const scratch = job ?? (previous && { id, lifecycle: previous.lifecycle });
      if (!job && scratch) this.catalogue.jobs.push(scratch);
      const before = scratch && structuredClone(scratch.lifecycle);
      try {
        const updated = this.catalogue.updateJobLifecycle(id, patch);
        const lifecycle = structuredClone(updated.lifecycle);
        if (!job && scratch) this.catalogue.removeJob(id);
        await this.write({ schemaVersion: 1, jobId: id, ...previous, lifecycle,
          ...(previous?.definition ? { definition: { ...previous.definition, lifecycle } } : {}),
          sourceKey: previous?.sourceKey ?? upstreamKey(job) });
        return updated;
      } catch (error) {
        if (scratch) scratch.lifecycle = before;
        throw error;
      } finally {
        if (!job && scratch) this.catalogue.removeJob(id);
      }
    });
  }

  async write(record) {
    await this.stateStore.putCatalogueMutation(record);
    this.records.set(record.jobId, structuredClone(record));
    return record;
  }
}

function isRetired(record) {
  return ["archived", "paused"].includes(record.lifecycle?.status);
}

function upstreamKey(job) {
  const source = job?.source;
  return source?.type === "github_issue" && source.repo && source.issueNumber
    ? `github:${String(source.repo).toLowerCase()}#${Number(source.issueNumber)}` : undefined;
}
