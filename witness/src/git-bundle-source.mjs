import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { ArtifactIntegrityError, verifyArtifact } from "./artifacts.mjs";
import { runProcess } from "./process.mjs";

const GIT_TIMEOUT_SECONDS = 300;

export class SourceCommitBindingError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "SourceCommitBindingError";
    this.code = "SOURCE_COMMIT_BINDING_FAILED";
  }
}

export class SourceBindingInfrastructureError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "SourceBindingInfrastructureError";
    this.code = "SOURCE_BINDING_INFRASTRUCTURE_FAILED";
  }
}

function isolatedGitEnvironment(configPath) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key === "GIT_DIR" || key === "GIT_WORK_TREE" || key === "GIT_INDEX_FILE" ||
        key.startsWith("GIT_CONFIG_KEY_") || key.startsWith("GIT_CONFIG_VALUE_")) {
      delete env[key];
    }
  }
  return {
    ...env,
    GIT_ALLOW_PROTOCOL: "file",
    GIT_CONFIG_GLOBAL: configPath,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0"
  };
}

async function git(args, { cwd, env, label }) {
  const result = await runProcess("git", [
    "-c", "protocol.ext.allow=never",
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.autocrlf=false",
    "-c", "core.eol=lf",
    ...args
  ], { cwd, env, timeoutSeconds: GIT_TIMEOUT_SECONDS });
  if (result.spawnError) {
    throw new SourceBindingInfrastructureError(`${label}: ${result.spawnError}`);
  }
  if (result.exitCode !== 0) {
    throw new SourceCommitBindingError(
      `${label}: ${(result.stderr || result.stdout || `git exited ${result.exitCode}`).trim()}`
    );
  }
  return result.stdout.trim();
}

export function assertDeclaredBundleBinding(advertisedHeads, checkedOutCommit, declaredCommit) {
  if (advertisedHeads.length !== 1 || advertisedHeads[0].oid !== declaredCommit ||
      checkedOutCommit !== declaredCommit) {
    const advertised = advertisedHeads.length === 0
      ? "no refs"
      : advertisedHeads.map((head) => `${head.oid} ${head.ref}`).join(", ");
    throw new SourceCommitBindingError(
      `Git bundle must advertise and check out exactly the declared commit ${declaredCommit}; ` +
      `advertised ${advertised}; checked out ${checkedOutCommit || "no commit"}`
    );
  }
}

function parseAdvertisedHeads(output) {
  if (!output) return [];
  return output.split("\n").map((line) => {
    const separator = line.indexOf(" ");
    return separator === -1
      ? { oid: line, ref: "" }
      : { oid: line.slice(0, separator), ref: line.slice(separator + 1) };
  });
}

export async function materializeGitBundleSource({
  artifact,
  declaredCommit,
  destination,
  baseDirectory
}) {
  const started = performance.now();
  let verified;
  try {
    verified = await verifyArtifact(artifact, { baseDirectory });
  } catch (error) {
    if (error instanceof ArtifactIntegrityError) {
      throw new SourceCommitBindingError(error.message, { cause: error });
    }
    throw error;
  }

  const binding = await verifyAndCheckoutGitBundle(verified.bytes, declaredCommit, destination);
  return {
    path: resolve(destination),
    commit: declaredCommit,
    checkedOutCommit: binding.checkedOutCommit,
    tree: binding.tree,
    bindingVerified: true,
    source: artifact.locator,
    sourceType: "verified-git-bundle",
    sha256: verified.sha256,
    bytes: verified.size,
    format: artifact.format,
    seconds: Number(((performance.now() - started) / 1_000).toFixed(3))
  };
}

async function verifyAndCheckoutGitBundle(bytes, declaredCommit, destination) {
  const root = dirname(resolve(destination));
  const supportRoot = `${resolve(destination)}.git-binding`;
  const bundlePath = resolve(supportRoot, "declared-source.bundle");
  const verificationRepository = resolve(supportRoot, "bundle-verification.git");
  const configPath = resolve(supportRoot, "isolated-gitconfig");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(supportRoot, { recursive: false, mode: 0o700 });
  await writeFile(bundlePath, bytes, { mode: 0o600 });
  await writeFile(configPath, "", { mode: 0o600 });
  const env = isolatedGitEnvironment(configPath);

  await git(["init", "--bare", "--", verificationRepository], {
    env,
    label: "could not create isolated bundle verifier"
  });
  await git(["-C", verificationRepository, "bundle", "verify", "--", bundlePath], {
    env,
    label: "Git bundle object-graph verification failed"
  });
  const headsOutput = await git(["bundle", "list-heads", "--", bundlePath], {
    env,
    label: "Git bundle ref inspection failed"
  });
  const advertisedHeads = parseAdvertisedHeads(headsOutput);
  if (advertisedHeads.length === 0) {
    throw new SourceCommitBindingError("Git bundle advertises no refs");
  }
  const checkoutCommit = advertisedHeads[0].oid;

  await git(["clone", "--no-checkout", "--no-tags", "--", bundlePath, resolve(destination)], {
    env,
    label: "verified Git bundle could not be cloned"
  });
  await git(["-C", resolve(destination), "checkout", "--detach", checkoutCommit], {
    env,
    label: "declared Git commit could not be checked out"
  });
  await git(["-C", resolve(destination), "fsck", "--full", "--strict", "--no-reflogs"], {
    env,
    label: "checked-out Git object graph failed fsck"
  });
  const reachableObjects = new Set((await git([
    "-C", resolve(destination), "rev-list", "--objects", "--all"
  ], {
    env,
    label: "reachable Git objects could not be enumerated"
  })).split("\n").filter(Boolean).map((line) => line.split(" ", 1)[0]));
  const allObjects = (await git([
    "-C", resolve(destination), "cat-file", "--batch-all-objects", "--batch-check=%(objectname)"
  ], {
    env,
    label: "Git bundle objects could not be enumerated"
  })).split("\n").filter(Boolean);
  const unreachableObjects = allObjects.filter((oid) => !reachableObjects.has(oid));
  if (unreachableObjects.length > 0) {
    throw new SourceCommitBindingError(
      `Git bundle contains ${unreachableObjects.length} object(s) unreachable from its advertised ref`
    );
  }
  const checkedOutCommit = await git(["-C", resolve(destination), "rev-parse", "HEAD"], {
    env,
    label: "checked-out Git commit could not be read"
  });
  assertDeclaredBundleBinding(advertisedHeads, checkedOutCommit, declaredCommit);
  const tree = await git(["-C", resolve(destination), "rev-parse", "HEAD^{tree}"], {
    env,
    label: "checked-out Git tree could not be read"
  });
  const gitlinks = await git(["-C", resolve(destination), "ls-tree", "-r", "HEAD"], {
    env,
    label: "checked-out Git tree could not be inspected"
  });
  if (gitlinks.split("\n").some((line) => line.startsWith("160000 commit "))) {
    throw new SourceCommitBindingError(
      "Git bundle source contains submodules; v1.1 has no offline artifact binding for submodule repositories"
    );
  }
  return {
    checkedOutCommit,
    tree
  };
}
