import {
  AgentPlatformApiError,
  AgentPlatformClient,
  type AccountSummary,
  type BuiltinJobSchemaValue,
  type ClaimResponse,
  type JobDefinition,
  type JobsListResponse,
  type SessionTimelineResponse
} from "./agent-platform-client.js";

const client = new AgentPlatformClient({
  baseUrl: "https://api.averray.com",
  token: "example-token"
});

const jobs: JobsListResponse = await client.listClaimableJobs({ source: "wikipedia", limit: 5 });
const firstJobId: string | undefined = jobs.jobs[0]?.id;

if (firstJobId) {
  const definition: JobDefinition = await client.getJobDefinition(firstJobId);
  const claim: ClaimResponse = await client.claimJob(definition.id, "example-run-id");
  const timeline: SessionTimelineResponse = await client.getSessionTimeline(claim.sessionId);
  const wikipediaSubmission = {
    page_title: "Example",
    revision_id: "123",
    citation_findings: [{
      section: "History",
      problem: "dead_link",
      current_claim: "Example claim",
      evidence_url: "https://example.test/source"
    }],
    proposed_changes: [{
      change_type: "replace_citation",
      target_text: "old citation",
      replacement_text: "new citation",
      source_url: "https://example.test/source"
    }],
    review_notes: "Proposal only."
  } satisfies BuiltinJobSchemaValue<"schema://jobs/wikipedia-citation-repair-output">;

  await client.validateJobSubmission(definition.id, wikipediaSubmission);
  await client.submitWork(claim.sessionId, wikipediaSubmission);
  await client.createSubJob({
    parentSessionId: claim.sessionId,
    id: `${claim.sessionId}-child`,
    category: "coding",
    rewardAmount: 1,
    verifierMode: "benchmark"
  });

  const childJobIds: string[] = timeline.lineage?.childJobIds ?? [];
  void childJobIds;
}

const account: AccountSummary = await client.borrowFunds({ amount: "1", idempotencyKey: "borrow-1" });
await client.repayFunds({ amount: "1" });
void account.wallet;

try {
  await client.getHealth();
} catch (error) {
  if (error instanceof AgentPlatformApiError) {
    const status: number = error.status;
    const code: string | undefined = error.code;
    void status;
    void code;
  }
}
