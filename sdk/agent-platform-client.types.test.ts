import {
  AgentPlatformApiError,
  AgentPlatformClient,
  AgentPlatformValidationError,
  createIdempotencyKey,
  type AccountSummary,
  type BuiltinJobSchemaValue,
  type ClaimResponse,
  type IdempotencyKey,
  type JobDefinition,
  type JobsListResponse,
  type SchemaNativeSubmissionReadiness,
  type ServiceTokenIssueResponse,
  type ServiceTokenListResponse,
  type ServiceTokenRevokeResponse,
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
  const readiness: SchemaNativeSubmissionReadiness<typeof wikipediaSubmission> =
    await client.assertSchemaNativeSubmissionReady(definition.id, wikipediaSubmission, {
      expectedSchemaRef: "schema://jobs/wikipedia-citation-repair-output"
    });
  void readiness.invalidWrappedOutput?.path;
  await client.claimJobAfterValidation(definition.id, wikipediaSubmission, "example-run-id-validated");
  await client.submitValidatedWork(definition.id, claim.sessionId, wikipediaSubmission);
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

const generatedKey: IdempotencyKey = createIdempotencyKey("borrow");
await client.fundAccount({ amount: "1", idempotencyKey: createIdempotencyKey("fund") });
const account: AccountSummary = await client.borrowFunds({ amount: "1", idempotencyKey: generatedKey });
await client.repayFunds({ amount: "1" });
await client.sendToAgent({
  recipient: "0x1111111111111111111111111111111111111111",
  amount: "1",
  idempotencyKey: createIdempotencyKey("send")
});
void account.wallet;
void createIdempotencyKey();
void AgentPlatformValidationError;

const serviceTokens: ServiceTokenListResponse = await client.listServiceTokens({
  status: "active",
  limit: 25
});
void serviceTokens.items.length;

const issued: ServiceTokenIssueResponse = await client.issueServiceToken({
  subject: "0xagent-wallet-0xagent-wallet-0xagent-wal",
  capabilities: ["jobs:claim", "jobs:submit"],
  scope: "wikipedia-bot",
  tokenTtlSeconds: 3600,
  idempotencyKey: "issue-1"
});
const bearerToken: string = issued.token;
void bearerToken;

const rotated: ServiceTokenIssueResponse = await client.rotateServiceToken(issued.grant.id, {
  capabilities: ["jobs:claim"]
});
void rotated.grant.id;

const revoked: ServiceTokenRevokeResponse = await client.revokeServiceToken(issued.grant.id, {
  note: "key rotated"
});
void revoked.alreadyRevoked;

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
