import { buildAverrayDisclosureRequirement } from "./maintainer-surface-policy.js";

export const isGithubPrJob = (job) => (job?.verifierConfig?.handler ?? job?.verifierMode) === "github_pr";

export function githubPrWorkerDefinition(job) {
  if (!isGithubPrJob(job)) return job;
  return {
    ...job,
    disclosure: buildAverrayDisclosureRequirement(),
    settlement: {
      ...job.settlement, path: "human_review",
      description: "Submitting stops the claim clock. Your stake is never lost while a verdict is pending. GitHub PR verdicts are initially run by the operator and automatically re-run when the PR merges or its checks change (when GitHub access is configured). The review SLA is 48 hours by default; the live operator setting may differ. status=blocked documents an external dependency and is scored like any other submission; ambiguous results go to human review. Ask at https://github.com/averray-agent/agent/issues and include the session id."
    }
  };
}
