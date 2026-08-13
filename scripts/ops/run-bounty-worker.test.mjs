import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  appendAverrayDisclosureFooter,
  hasAverrayDisclosureFooter,
  inspectAverrayClaimantBinding,
} from "../../mcp-server/src/core/maintainer-surface-policy.js";
import {
  BOUNTY_WORKER_EXIT,
  createGitHubPublisher,
  runBountyWorker,
} from "./run-bounty-worker.mjs";

const TOKEN_SENTINEL = "github-installation-token-sentinel";
const RUN_ID = "11111111-2222-4333-8444-555555555555";
const SESSION_ID = "session-bounty-1";
const CLAIMANT_ADDRESS = "0x3742de8800000000000000000000000000009620";
const BASE_REVISION = "a".repeat(40);
const HEAD_REVISION = "b".repeat(40);
const JOB_URL = new URL("../../worker/examples/github-issue-job.json", import.meta.url);
const UNVERIFIABLE_URL = new URL(
  "../../worker/test/fixtures/unverifiable-job.json",
  import.meta.url,
);
const PATCH_URL = new URL("../../worker/test/fixtures/workspace.patch", import.meta.url);
const REPORT_URL = new URL(
  "../../worker/test/fixtures/verification-report.json",
  import.meta.url,
);

test("two-shell seam prepares a run, opens one PR, assembles, and uses the existing submit path", async () => {
  const prepared = await prepareCase();
  const sendPlatform = submitPlatform();
  const githubCalls = [];
  const stdout = sink();
  const stderr = sink();
  const evidencePath = path.join(prepared.root, "result.json");
  const code = await runBountyWorker({
    argv: sendArgs(prepared.handoffPath, evidencePath, "averray-agent/agent"),
    env: { GITHUB_INSTALLATION_TOKEN: TOKEN_SENTINEL },
    stdout,
    stderr,
    dependencies: {
      platform: sendPlatform,
      githubPublisher: {
        async publish(packet) {
          githubCalls.push(packet);
          return {
            url: "https://github.com/averray-agent/agent/pull/812",
            number: 812,
            headBranch: "averray/github-averray-agent-agent-741-111111112222",
            headRevision: HEAD_REVISION,
            adopted: false,
          };
        },
      },
    },
  });

  assert.equal(code, 0, stderr.text);
  assert.equal(githubCalls.length, 1);
  assert.equal(sendPlatform.calls.length, 1);
  assert.equal(sendPlatform.calls[0][0], "submitValidatedWork");
  assert.equal(sendPlatform.calls[0][1], "github:averray-agent/agent#741");
  assert.equal(sendPlatform.calls[0][2], SESSION_ID);
  const submission = sendPlatform.calls[0][3];
  assert.equal(submission.prUrl, "https://github.com/averray-agent/agent/pull/812");
  assert.deepEqual(submission.filesChanged, ["src/adapter.js", "test/adapter.test.js"]);
  const evidenceText = await readFile(evidencePath, "utf8");
  const evidence = JSON.parse(evidenceText);
  assert.equal(evidence.runId, RUN_ID);
  assert.equal(evidence.prUrl, submission.prUrl);
  assert.deepEqual(evidence.submission, submission);
  assert.equal(evidence.submitStatus, "submitted");
  for (const output of [stdout.text, stderr.text, evidenceText]) {
    assert.doesNotMatch(output, new RegExp(TOKEN_SENTINEL, "u"));
  }
  assert.match(stdout.text, new RegExp(`BOUNTY_SUBMITTED run_id=${RUN_ID}`, "u"));
  console.log(`BOUNTY_SCRIPTED_PROOF ${JSON.stringify({
    runId: evidence.runId,
    prUrl: evidence.prUrl,
    submission: evidence.submission,
    submitStatus: evidence.submitStatus,
  })}`);
});

test("drill: approval withheld refuses before every GitHub and submit call", async () => {
  const prepared = await prepareCase();
  let githubCalls = 0;
  const platform = submitPlatform();
  const output = await invokeSend(prepared, {
    confirm: undefined,
    platform,
    githubPublisher: {
      async publish() {
        githubCalls += 1;
        throw new Error("must not reach GitHub");
      },
    },
  });

  assert.equal(output.code, BOUNTY_WORKER_EXIT.approvalRequired);
  assert.match(output.stderr.text, /BOUNTY_APPROVAL_REQUIRED/u);
  assert.equal(githubCalls, 0);
  assert.equal(platform.calls.length, 0);
  assert.doesNotMatch(output.stdout.text, new RegExp(TOKEN_SENTINEL, "u"));
  assert.doesNotMatch(output.stderr.text, new RegExp(TOKEN_SENTINEL, "u"));
  console.log("BOUNTY_DRILL_GREEN approval_withheld github_calls=0 submit_calls=0 exit=74");
});

test("drill: mapping warnings refuse submission", async () => {
  const prepared = await prepareCase();
  const unverifiableJob = JSON.parse(await readFile(UNVERIFIABLE_URL, "utf8"));
  const packet = JSON.parse(await readFile(prepared.handoffPath, "utf8"));
  packet.job = unverifiableJob;
  packet.repository.nameWithOwner = unverifiableJob.source.repo;
  packet.mappingWarnings = [
    "No deterministic verify command was provided; acceptance is empty and this job is not eligible for automated submission.",
  ];
  packet.contentSha256 = packetSha256(packet);
  await writeFile(prepared.handoffPath, `${JSON.stringify(packet, null, 2)}\n`);
  let githubCalls = 0;
  const platform = submitPlatform();
  const output = await invokeSend(prepared, {
    confirm: unverifiableJob.source.repo,
    platform,
    githubPublisher: {
      async publish() {
        githubCalls += 1;
        throw new Error("must not reach GitHub");
      },
    },
  });

  assert.equal(output.code, BOUNTY_WORKER_EXIT.mappingWarnings);
  assert.match(output.stderr.text, /BOUNTY_MAPPING_WARNINGS/u);
  assert.equal(githubCalls, 0);
  assert.equal(platform.calls.length, 0);
  console.log("BOUNTY_DRILL_GREEN mapping_warnings github_calls=0 submit_calls=0 exit=68");
});

test("drill: failed verification has a named refusal and never submits", async () => {
  const prepared = await prepareCase();
  const packet = JSON.parse(await readFile(prepared.handoffPath, "utf8"));
  packet.deliverables.verificationReport = {
    ...packet.deliverables.verificationReport,
    passed: false,
  };
  packet.deliverables.verificationSha256 = sha256(
    JSON.stringify(packet.deliverables.verificationReport),
  );
  packet.contentSha256 = packetSha256(packet);
  await writeFile(prepared.handoffPath, `${JSON.stringify(packet, null, 2)}\n`);
  let githubCalls = 0;
  const platform = submitPlatform();
  const output = await invokeSend(prepared, {
    confirm: packet.repository.nameWithOwner,
    platform,
    githubPublisher: {
      async publish() {
        githubCalls += 1;
        throw new Error("must not reach GitHub");
      },
    },
  });

  assert.equal(output.code, BOUNTY_WORKER_EXIT.verificationFailed);
  assert.match(output.stderr.text, /BOUNTY_VERIFICATION_FAILED/u);
  assert.equal(githubCalls, 0);
  assert.equal(platform.calls.length, 0);
  console.log("BOUNTY_DRILL_GREEN verification_failed github_calls=0 submit_calls=0 exit=72");
});

test("drill: missing disclosure binding refuses before every GitHub call", async () => {
  const bodyWithoutFooter = "Preserve verification evidence across retries.";
  assert.equal(
    inspectAverrayClaimantBinding(bodyWithoutFooter, { claimSessionId: SESSION_ID }).status,
    "missing",
  );

  const prepared = await prepareCase();
  const packet = JSON.parse(await readFile(prepared.handoffPath, "utf8"));
  packet.deliverables.changeSummary = [
    bodyWithoutFooter,
    "",
    "This contribution was prepared by an autonomous agent operating on the",
    "Averray platform.",
  ].join("\n");
  packet.deliverables.changeSummarySha256 = sha256(packet.deliverables.changeSummary);
  packet.contentSha256 = packetSha256(packet);
  await writeFile(prepared.handoffPath, `${JSON.stringify(packet, null, 2)}\n`);
  let githubCalls = 0;
  const platform = submitPlatform();
  const output = await invokeSend(prepared, {
    confirm: packet.repository.nameWithOwner,
    platform,
    githubPublisher: {
      async publish() {
        githubCalls += 1;
        throw new Error("must not reach GitHub");
      },
    },
  });

  assert.equal(output.code, BOUNTY_WORKER_EXIT.prOpenRefused);
  assert.match(output.stderr.text, /BOUNTY_DISCLOSURE_REFUSED/u);
  assert.equal(githubCalls, 0);
  assert.equal(platform.calls.length, 0);
});

test("drill: disclosure bound to the wrong claim session refuses before every GitHub call", async () => {
  const prepared = await prepareCase();
  const packet = JSON.parse(await readFile(prepared.handoffPath, "utf8"));
  packet.deliverables.changeSummary = appendAverrayDisclosureFooter(
    packet.deliverables.changeSummary,
    {
      agentWallet: CLAIMANT_ADDRESS,
      claimSessionId: "wrong-claim-session",
      jobSpecUrl: "https://api.averray.com/jobs/definition?jobId=github%3Aaverray-agent%2Fagent%23741",
      submissionHash: packet.deliverables.patchSha256,
    },
  );
  assert.equal(
    inspectAverrayClaimantBinding(packet.deliverables.changeSummary, {
      claimSessionId: SESSION_ID,
    }).status,
    "mismatched",
  );
  packet.deliverables.changeSummarySha256 = sha256(packet.deliverables.changeSummary);
  packet.contentSha256 = packetSha256(packet);
  await writeFile(prepared.handoffPath, `${JSON.stringify(packet, null, 2)}\n`);
  let githubCalls = 0;
  const platform = submitPlatform();
  const output = await invokeSend(prepared, {
    confirm: packet.repository.nameWithOwner,
    platform,
    githubPublisher: {
      async publish() {
        githubCalls += 1;
        throw new Error("must not reach GitHub");
      },
    },
  });

  assert.equal(output.code, BOUNTY_WORKER_EXIT.prOpenRefused);
  assert.match(output.stderr.text, /BOUNTY_DISCLOSURE_REFUSED/u);
  assert.equal(githubCalls, 0);
  assert.equal(platform.calls.length, 0);
});

test("drill: container NetworkMode other than none refuses the prepared run", async () => {
  const output = await prepareCase({ networkMode: "bridge", expectSuccess: false });
  assert.equal(output.code, BOUNTY_WORKER_EXIT.networkRefused);
  assert.match(output.stderr.text, /BOUNTY_NETWORK_REFUSED/u);
  await assert.rejects(access(output.handoffPath), /ENOENT/u);
  assert.equal(output.platform.claimCalls, 1);
  console.log("BOUNTY_DRILL_GREEN network_mode observed=bridge handoff_written=false exit=71");
});

test("prepare refuses a GitHub token and send refuses a Harness database URL", async () => {
  const preparedRoot = await mkdtemp(path.join(tmpdir(), "bounty-token-boundary-"));
  const prepareOutput = await invoke({
    argv: prepareArgs(preparedRoot),
    env: {
      HARNESS_DATABASE_URL: "postgresql://example.test/harness",
      HARNESS_ENV_IMAGE: "worker:test",
      GITHUB_INSTALLATION_TOKEN: TOKEN_SENTINEL,
    },
  });
  assert.equal(prepareOutput.code, BOUNTY_WORKER_EXIT.credentialBoundary);
  assert.match(prepareOutput.stderr.text, /BOUNTY_PREPARE_TOKEN_REFUSED/u);
  assert.doesNotMatch(prepareOutput.stderr.text, new RegExp(TOKEN_SENTINEL, "u"));

  const prepared = await prepareCase();
  const sendOutput = await invoke({
    argv: sendArgs(
      prepared.handoffPath,
      path.join(prepared.root, "not-written.json"),
      "averray-agent/agent",
    ),
    env: {
      HARNESS_DATABASE_URL: "postgresql://example.test/harness",
      GITHUB_INSTALLATION_TOKEN: TOKEN_SENTINEL,
    },
  });
  assert.equal(sendOutput.code, BOUNTY_WORKER_EXIT.credentialBoundary);
  assert.match(sendOutput.stderr.text, /BOUNTY_SEND_DATABASE_REFUSED/u);
  assert.doesNotMatch(sendOutput.stderr.text, new RegExp(TOKEN_SENTINEL, "u"));
});

test("prepare uses the real unverifiable fixture and refuses before claim or run", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bounty-unverifiable-"));
  const job = JSON.parse(await readFile(UNVERIFIABLE_URL, "utf8"));
  let claimCalls = 0;
  let submitCalls = 0;
  const output = await invoke({
    argv: prepareArgs(root, job.id),
    env: prepareEnv(),
    dependencies: {
      fetchJobDefinition: async () => job,
      cloneRepository: async (_job, workspacePath) => checkout(job, workspacePath),
      platform: {
        async preflightJob() {
          claimCalls += 1;
          return { eligible: true, claimable: true };
        },
        async claimJob() {
          claimCalls += 1;
          return { sessionId: SESSION_ID };
        },
        async submitValidatedWork() {
          submitCalls += 1;
        },
      },
      driver: successfulDriver(),
      inspectNetworkMode: async () => "none",
    },
  });
  assert.equal(output.code, BOUNTY_WORKER_EXIT.mappingWarnings);
  assert.match(output.stderr.text, /BOUNTY_MAPPING_WARNINGS/u);
  assert.equal(claimCalls, 0);
  assert.equal(submitCalls, 0);
});

test("first bounty proof refuses a non-testnet money rail before claim or submit", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bounty-mainnet-refusal-"));
  const job = JSON.parse(await readFile(JOB_URL, "utf8"));
  const platform = preparePlatform({ chainId: 420420419 });
  const output = await invoke({
    argv: prepareArgs(root, job.id),
    env: prepareEnv(),
    dependencies: {
      fetchJobDefinition: async () => job,
      cloneRepository: async (_job, workspacePath) => checkout(job, workspacePath),
      platform,
      driver: successfulDriver(),
      inspectNetworkMode: async () => "none",
    },
  });
  assert.equal(output.code, BOUNTY_WORKER_EXIT.testnetRefused);
  assert.match(output.stderr.text, /BOUNTY_TESTNET_REFUSED/u);
  assert.equal(platform.claimCalls, 0);
});

test("GitHub publisher rechecks base, pushes once, opens once, then adopts exact replay", async () => {
  const prepared = await prepareCase();
  const packet = JSON.parse(await readFile(prepared.handoffPath, "utf8"));
  const requests = [];
  let pushed = 0;
  let headExists = false;
  let pullRequestExists = false;
  const fetchImpl = async (url, options = {}) => {
    const parsed = new URL(url);
    requests.push({ path: `${parsed.pathname}${parsed.search}`, method: options.method ?? "GET", body: options.body });
    if (parsed.pathname === "/installation/repositories") {
      return response(200, {
        total_count: 1,
        repositories: [{ full_name: packet.repository.nameWithOwner }],
      });
    }
    if (parsed.pathname.includes(`/git/ref/heads/${packet.repository.baseRef}`)) {
      return response(200, { object: { sha: packet.repository.baseRevision } });
    }
    if (parsed.pathname.includes("/git/ref/heads/averray%2F")) {
      return headExists
        ? response(200, { object: { sha: HEAD_REVISION } })
        : response(404, { message: "not found" });
    }
    if (parsed.pathname.endsWith("/pulls") && (options.method ?? "GET") === "GET") {
      return response(200, pullRequestExists ? [{
        html_url: "https://github.com/averray-agent/agent/pull/812",
        number: 812,
        head: { sha: HEAD_REVISION },
        base: { ref: packet.repository.baseRef },
      }] : []);
    }
    if (parsed.pathname.endsWith("/pulls") && options.method === "POST") {
      pullRequestExists = true;
      return response(201, {
        html_url: "https://github.com/averray-agent/agent/pull/812",
        number: 812,
      });
    }
    throw new Error(`unexpected request ${options.method ?? "GET"} ${parsed.pathname}${parsed.search}`);
  };
  const publisher = createGitHubPublisher({
    installationToken: TOKEN_SENTINEL,
    fetchImpl,
    materializeCommitImpl: async () => ({
      repositoryPath: prepared.root,
      headRevision: HEAD_REVISION,
      cleanup: async () => {},
    }),
    pushBranchImpl: async () => {
      pushed += 1;
      headExists = true;
    },
  });

  const opened = await publisher.publish(packet);
  const adopted = await publisher.publish(packet);
  assert.equal(opened.adopted, false);
  assert.equal(adopted.adopted, true);
  assert.equal(pushed, 1);
  const createRequest = requests.find((entry) => entry.method === "POST");
  assert.ok(createRequest);
  const payload = JSON.parse(createRequest.body);
  assert.equal(hasAverrayDisclosureFooter(payload.body), true);
  assert.equal(
    inspectAverrayClaimantBinding(payload.body, { claimSessionId: SESSION_ID }).status,
    "matched",
  );
  assert.match(payload.body, new RegExp(`^Agent identity: ${CLAIMANT_ADDRESS}$`, "mu"));
  assert.match(
    payload.body,
    /^Job spec:\s+https:\/\/api\.averray\.com\/jobs\/definition\?jobId=github%3Aaverray-agent%2Fagent%23741$/mu,
  );
  assert.match(payload.body, new RegExp(`^Submission:\\s+${packet.deliverables.patchSha256}$`, "mu"));
  assert.equal(requests.filter((entry) => entry.method === "POST").length, 1);
  for (const request of requests) {
    assert.doesNotMatch(`${request.path}${request.body ?? ""}`, new RegExp(TOKEN_SENTINEL, "u"));
  }
});

async function prepareCase({ networkMode = "none", expectSuccess = true } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "bounty-worker-test-"));
  const job = JSON.parse(await readFile(JOB_URL, "utf8"));
  const platform = preparePlatform();
  const stdout = sink();
  const stderr = sink();
  const paths = preparePaths(root);
  const code = await runBountyWorker({
    argv: prepareArgs(root, job.id),
    env: prepareEnv(),
    stdout,
    stderr,
    dependencies: {
      fetchJobDefinition: async () => job,
      cloneRepository: async (_job, workspacePath) => checkout(job, workspacePath),
      platform,
      driver: successfulDriver(),
      inspectNetworkMode: async () => networkMode,
    },
  });
  if (expectSuccess) {
    assert.equal(code, 0, stderr.text);
    const packet = JSON.parse(await readFile(paths.handoffPath, "utf8"));
    assert.equal(packet.runId, RUN_ID);
    assert.equal(packet.network.mode, "none");
    assert.equal(packet.sessionId, SESSION_ID);
    assert.equal(platform.claimCalls, 1);
  }
  return { root, ...paths, code, stdout, stderr, platform };
}

function preparePlatform({ chainId = 420420417 } = {}) {
  return {
    claimCalls: 0,
    async getHealth() {
      return { auth: { chainId } };
    },
    async preflightJob() {
      return { eligible: true, claimable: true };
    },
    async claimJob() {
      this.claimCalls += 1;
      return { status: "claimed", sessionId: SESSION_ID, wallet: CLAIMANT_ADDRESS };
    },
  };
}

function submitPlatform() {
  return {
    calls: [],
    async getHealth() {
      return { auth: { chainId: 420420417 } };
    },
    async submitValidatedWork(...args) {
      this.calls.push(["submitValidatedWork", ...args]);
      return { status: "submitted" };
    },
  };
}

function successfulDriver() {
  const patchPromise = readFile(PATCH_URL);
  const reportPromise = readFile(REPORT_URL);
  return {
    async submit() {
      return RUN_ID;
    },
    async waitForOutcome() {
      return { outcome: "completed", state: "learning_processed", attempt: "1" };
    },
    async deliverables() {
      return {
        workspace_patch: "artifact://patch",
        verification_report: "artifact://verification",
        change_summary: "artifact://summary",
      };
    },
    async artifactGet(uri) {
      if (uri === "artifact://patch") return patchPromise;
      if (uri === "artifact://verification") return reportPromise;
      if (uri === "artifact://summary") return Buffer.from("Preserve verification evidence across retries.\n");
      throw new Error(`unexpected artifact ${uri}`);
    },
  };
}

async function invokeSend(prepared, { confirm, platform, githubPublisher }) {
  return invoke({
    argv: sendArgs(
      prepared.handoffPath,
      path.join(prepared.root, `result-${Math.random()}.json`),
      confirm,
    ),
    env: { GITHUB_INSTALLATION_TOKEN: TOKEN_SENTINEL },
    dependencies: { platform, githubPublisher },
  });
}

async function invoke({ argv, env, dependencies = {} }) {
  const stdout = sink();
  const stderr = sink();
  const code = await runBountyWorker({ argv, env, stdout, stderr, dependencies });
  return { code, stdout, stderr };
}

function prepareArgs(root, jobId = "github:averray-agent/agent#741") {
  const paths = preparePaths(root);
  return [
    "prepare",
    "--job", jobId,
    "--workspace", paths.workspacePath,
    "--intent", paths.intentPath,
    "--handoff", paths.handoffPath,
  ];
}

function preparePaths(root) {
  return {
    workspacePath: path.join(root, "workspace"),
    intentPath: path.join(root, "intent.json"),
    handoffPath: path.join(root, "handoff.json"),
  };
}

function sendArgs(handoffPath, evidencePath, confirm) {
  return [
    "send",
    "--handoff", handoffPath,
    "--evidence", evidencePath,
    ...(confirm ? ["--confirm", confirm] : []),
  ];
}

function prepareEnv() {
  return {
    HARNESS_DATABASE_URL: "postgresql://example.test/harness",
    HARNESS_ENV_IMAGE: "averray-worker:test",
  };
}

function checkout(job, workspacePath) {
  return {
    repository: job.source.repo,
    workspacePath,
    baseRef: "main",
    baseRevision: BASE_REVISION,
  };
}

function sink() {
  return {
    text: "",
    write(value) {
      this.text += String(value);
    },
  };
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function packetSha256(packet) {
  const content = { ...packet };
  delete content.contentSha256;
  return sha256(JSON.stringify(content));
}

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body;
    },
  };
}
