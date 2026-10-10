import { hashCanonicalContent } from "../core/canonical-content.js";
import { ConflictError, ValidationError } from "../core/errors.js";

// Provenance belongs to the evaluation overlay, never to worker-supplied JSON.
const pinProvenance = new WeakMap();
export function repositoryPinProvenance(job) { return pinProvenance.get(job); }

// Bind to the repository identity and creation event, not mutable issue metadata.
// The catalogue and claim snapshots remain byte-for-byte unchanged.
export function repositoryPinKey(job) {
  return hashCanonicalContent({ jobId: job.id, repo: job.source?.repo ?? null, createdAt: job.lifecycle?.createdAt ?? null });
}

export async function withPinnedRepositoryIdentity(job, store) {
  if (job.source?.type !== "github_issue" || job.source.githubRepoId != null) return job;
  const key = repositoryPinKey(job);
  const pin = await store.getGithubRepositoryPin(key);
  if (!pin) return job;
  if (pin.key !== key || !Number.isSafeInteger(pin.source?.githubRepoId) || pin.source.githubRepoId <= 0
    || !Number.isFinite(Date.parse(pin.pinnedAt))) {
    throw new ConflictError("Stored repository identity requires operator review.", "github_repository_pin_invalid");
  }
  const overlaid = { ...job, source: { ...job.source, githubRepoId: pin.source.githubRepoId } };
  pinProvenance.set(overlaid, Object.freeze({ pinnedAt: pin.pinnedAt }));
  return overlaid;
}

export async function backfillGithubRepositoryIds(service, payload, {
  fetchImpl = globalThis.fetch, githubToken = process.env.GITHUB_TOKEN, now = () => new Date()
} = {}) {
  if (!Array.isArray(payload?.jobIds) || payload.jobIds.length < 1 || payload.jobIds.length > 10
    || payload.jobIds.some((id) => typeof id !== "string" || !id.trim() || id.length > 256)
    || (payload.apply !== undefined && typeof payload.apply !== "boolean")) {
    throw new ValidationError("jobIds must contain 1–10 non-empty IDs; apply must be a boolean (default false).");
  }
  const dryRun = payload.apply !== true;
  const store = service.stateStore;
  const rows = [];
  for (const jobId of new Set(payload.jobIds)) {
    let job;
    try { job = service.getJobDefinition(jobId); }
    catch (error) {
      if (error.code !== "job_not_found") throw error;
      rows.push({ jobId, status: "skipped", reason: "job_not_found" });
      continue;
    }
    const eligibility = async (candidate) => {
      if (candidate.source?.type !== "github_issue" || (candidate.verifierConfig?.handler ?? candidate.verifierMode) !== "github_pr") return "not_github_pr_issue";
      if ((candidate.lifecycle?.state ?? candidate.lifecycle?.status) !== "open"
        || (await store.findSessionByJobId(jobId))?.status === "resolved") return "job_not_open";
      if (candidate.source.githubRepoId != null) return "already_pinned";
      if (await store.getGithubRepositoryPin(repositoryPinKey(candidate))) return "already_pinned";
      return null;
    };
    let reason = await eligibility(job);
    const repo = job.source?.repo;
    if (!reason && (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/u.test(repo))) reason = "source_repo_invalid";
    if (!reason && !Number.isFinite(Date.parse(job.lifecycle?.createdAt))) reason = "job_creation_time_unavailable";
    if (!reason && !githubToken?.trim()) reason = "github_token_not_configured";
    let repository;
    if (!reason) {
      try {
        const response = await fetchImpl(`https://api.github.com/repos/${repo}`, {
          headers: { accept: "application/vnd.github+json", authorization: `Bearer ${githubToken}`, "X-GitHub-Api-Version": "2022-11-28" },
          redirect: "manual", signal: AbortSignal.timeout(5_000)
        });
        if (response.status >= 300 && response.status < 400) reason = "renamed_or_transferred";
        else if (!response.ok) reason = `github_api_${response.status}`;
        else repository = await response.json();
      } catch { reason = "github_read_unavailable"; }
    }
    if (!reason && repository?.full_name !== repo) reason = "repository_name_mismatch";
    if (!reason && (!Number.isSafeInteger(repository?.id) || repository.id <= 0)) reason = "repository_id_unavailable";
    if (!reason && !Number.isFinite(Date.parse(repository?.created_at))) reason = "repository_creation_time_unavailable";
    if (!reason && !(Date.parse(repository.created_at) < Date.parse(job.lifecycle.createdAt))) reason = "repository_not_older_than_job";
    // A concurrent catalogue edit must not turn a reviewed candidate into a different job.
    if (!reason) {
      const current = service.getJobDefinition(jobId);
      reason = repositoryPinKey(current) !== repositoryPinKey(job) ? "job_changed" : await eligibility(current);
    }
    if (reason) { rows.push({ jobId, status: "skipped", reason }); continue; }
    const pin = {
      key: repositoryPinKey(job), jobId, source: { githubRepoId: repository.id },
      fullName: repository.full_name, repositoryCreatedAt: repository.created_at,
      jobCreatedAt: job.lifecycle.createdAt, pinnedAt: now().toISOString(), origin: "operator_backfill"
    };
    const created = dryRun ? false : await store.putGithubRepositoryPin(pin);
    rows.push({ jobId, status: dryRun ? "would_pin" : created ? "pinned" : "skipped",
      ...(dryRun || created ? { githubRepoId: repository.id } : { reason: "already_pinned" }) });
  }
  return { dryRun, pinned: rows.filter((r) => r.status === "pinned").length,
    wouldPin: rows.filter((r) => r.status === "would_pin").length,
    skipped: rows.filter((r) => r.status === "skipped").length, rows };
}
