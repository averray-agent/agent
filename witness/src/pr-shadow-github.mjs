import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { runProcess } from "./process.mjs";

const REPOSITORY_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;

function assertRepository(repository) {
  if (!REPOSITORY_SLUG.test(repository)) {
    throw new Error(`invalid GitHub repository slug: ${JSON.stringify(repository)}`);
  }
}

function assertPullNumber(number) {
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`invalid pull request number: ${JSON.stringify(number)}`);
  }
}

function commandFailure(label, result) {
  return new Error(
    `${label}: ${(result.stderr || result.stdout || result.spawnError || `exit ${result.exitCode}`).trim()}`
  );
}

/**
 * The only GitHub transport exposed to shadow mode. It deliberately has no
 * generic request method and no mutation-shaped operation.
 */
export function createReadOnlyGitHubClient({ run = runProcess, audit = [] } = {}) {
  async function execute(program, args, options = {}, auditArgs = args) {
    audit.push({ program, args: [...auditArgs], access: "read" });
    return run(program, args, options);
  }

  return Object.freeze({
    audit,

    async getMergedPullRequest(repository, number) {
      assertRepository(repository);
      assertPullNumber(number);
      const endpoint = `repos/${repository}/pulls/${number}`;
      const result = await execute("gh", ["api", "--method", "GET", endpoint], {
        timeoutSeconds: 60,
        outputLimitBytes: 2 * 1024 * 1024
      });
      if (result.exitCode !== 0) throw commandFailure(`GitHub GET ${endpoint} failed`, result);
      let pull;
      try {
        pull = JSON.parse(result.stdout);
      } catch (error) {
        throw new Error(`GitHub GET ${endpoint} returned invalid JSON: ${error.message}`);
      }
      if (!pull.merged_at || typeof pull.base?.sha !== "string" || typeof pull.head?.sha !== "string") {
        throw new Error(`${repository}#${number} is not a materializable merged pull request`);
      }
      return {
        repository,
        number,
        title: pull.title,
        url: pull.html_url,
        mergedAt: pull.merged_at,
        baseCommit: pull.base.sha,
        headCommit: pull.head.sha
      };
    },

    async cloneMirror(repository, destination) {
      assertRepository(repository);
      const target = resolve(destination);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const result = await execute(
        "gh",
        ["repo", "clone", repository, target, "--", "--mirror"],
        { timeoutSeconds: 300, outputLimitBytes: 2 * 1024 * 1024 },
        ["repo", "clone", repository, "<temporary-mirror>", "--", "--mirror"]
      );
      if (result.exitCode !== 0) throw commandFailure(`read-only clone of ${repository} failed`, result);
      return target;
    }
  });
}

export function assertReadOnlyGitHubAudit(audit) {
  for (const entry of audit) {
    if (entry.access !== "read") throw new Error("shadow GitHub audit contains a non-read operation");
    if (entry.program !== "gh") throw new Error(`unexpected GitHub transport program: ${entry.program}`);
    const [command, ...args] = entry.args;
    if (command === "api") {
      const methodIndex = args.indexOf("--method");
      if (methodIndex === -1 || args[methodIndex + 1] !== "GET") {
        throw new Error(`shadow GitHub API invocation is not GET-only: ${entry.args.join(" ")}`);
      }
      continue;
    }
    if (command === "repo" && args[0] === "clone") continue;
    throw new Error(`shadow GitHub invocation is not allowlisted read-only access: ${entry.args.join(" ")}`);
  }
  return true;
}
