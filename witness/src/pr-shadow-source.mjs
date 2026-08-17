import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { runProcess } from "./process.mjs";

function failure(label, result) {
  return new Error(
    `${label}: ${(result.stderr || result.stdout || result.spawnError || `exit ${result.exitCode}`).trim()}`
  );
}

async function git(mirror, args, label, options = {}) {
  const result = await runProcess(
    "git",
    ["-C", mirror, "-c", "protocol.ext.allow=never", "-c", "core.hooksPath=/dev/null", ...args],
    { timeoutSeconds: 300, outputLimitBytes: 10 * 1024 * 1024, ...options }
  );
  if (result.exitCode !== 0) throw failure(label, result);
  return result.stdout.trim();
}

export class PullRequestSource {
  constructor({ repository, mirror }) {
    this.repository = repository;
    this.mirror = resolve(mirror);
  }

  async prepare(metadata) {
    if (metadata.repository !== this.repository) {
      throw new Error(`source for ${this.repository} cannot prepare ${metadata.repository}`);
    }
    const namespace = `refs/witness/pr-${metadata.number}`;
    await git(this.mirror, [
      "fetch",
      "--force",
      "--no-tags",
      "origin",
      `${metadata.baseCommit}:${namespace}-base-ref`,
      `refs/pull/${metadata.number}/head:${namespace}-head`
    ], `could not fetch ${metadata.repository}#${metadata.number}`);
    const [baseRefCommit, headCommit] = await Promise.all([
      git(this.mirror, ["rev-parse", `${namespace}-base-ref`], "could not resolve fetched base ref"),
      git(this.mirror, ["rev-parse", `${namespace}-head`], "could not resolve fetched head")
    ]);
    if (baseRefCommit !== metadata.baseCommit || headCommit !== metadata.headCommit) {
      throw new Error(
        `${metadata.repository}#${metadata.number} ref binding mismatch: ` +
        `expected ${metadata.baseCommit}..${metadata.headCommit}, fetched ${baseRefCommit}..${headCommit}`
      );
    }
    const baseCommit = await git(
      this.mirror,
      ["merge-base", baseRefCommit, headCommit],
      "could not derive the pull request merge base"
    );
    return { ...metadata, baseRefCommit, baseCommit, headCommit };
  }

  async materialize(commit, destination) {
    const started = performance.now();
    const target = resolve(destination);
    const clone = await runProcess(
      "git",
      [
        "-c", "protocol.ext.allow=never",
        "-c", "core.hooksPath=/dev/null",
        "clone", "--no-checkout", "--no-tags", "--", this.mirror, target
      ],
      {
        timeoutSeconds: 300,
        outputLimitBytes: 2 * 1024 * 1024,
        env: { ...process.env, GIT_ALLOW_PROTOCOL: "file" }
      }
    );
    if (clone.exitCode !== 0) throw failure(`could not clone local mirror for ${commit}`, clone);
    const checkout = await runProcess(
      "git",
      ["-C", target, "-c", "core.hooksPath=/dev/null", "checkout", "--detach", commit],
      { timeoutSeconds: 300, outputLimitBytes: 2 * 1024 * 1024 }
    );
    if (checkout.exitCode !== 0) throw failure(`could not check out ${commit}`, checkout);
    const materializedCommit = await git(target, ["rev-parse", "HEAD"], "could not verify detached checkout");
    if (materializedCommit !== commit) {
      throw new Error(`materialized ${materializedCommit}; expected ${commit}`);
    }
    return {
      path: target,
      commit,
      source: this.mirror,
      sourceType: "read-only-local-mirror",
      seconds: Number(((performance.now() - started) / 1_000).toFixed(3))
    };
  }

  async writeDiff({ baseCommit, headCommit, destination }) {
    const result = await runProcess(
      "git",
      [
        "-C", this.mirror,
        "-c", "protocol.ext.allow=never",
        "-c", "core.hooksPath=/dev/null",
        "diff", "--binary", "--full-index", "--no-renames", "--no-ext-diff",
        baseCommit, headCommit, "--"
      ],
      { timeoutSeconds: 300, outputLimitBytes: 10 * 1024 * 1024 }
    );
    if (result.exitCode !== 0) throw failure("could not derive pull request diff", result);
    const target = resolve(destination);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, result.stdout, { mode: 0o600 });
    return target;
  }
}
