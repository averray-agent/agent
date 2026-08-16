import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { materializeArtifact } from "./artifacts.mjs";
import { materializeGitBundleSource, SourceCommitBindingError } from "./git-bundle-source.mjs";
import { materializeRepository } from "./materialize.mjs";
import {
  CONTRACT_SOURCE_DIRECTORY,
  VERIFICATION_CONTRACT_SCHEMA_VERSION
} from "./verification-contract.mjs";

export function contractBaseDirectory(contract, fallback = process.cwd()) {
  return contract[CONTRACT_SOURCE_DIRECTORY] || fallback;
}

export async function materializeContractSource({
  contract,
  destination,
  cwd,
  materialize = materializeRepository
}) {
  if (materialize !== materializeRepository) {
    const result = await materialize({
      repo: contract.subject.acquisition.repository,
      commit: contract.subject.acquisition.base_commit,
      destination,
      cwd
    });
    if (contract.schema_version === VERIFICATION_CONTRACT_SCHEMA_VERSION && result.bindingVerified !== true) {
      throw new SourceCommitBindingError("source materializer did not provide verified Git commit binding");
    }
    return result;
  }
  if (contract.schema_version !== VERIFICATION_CONTRACT_SCHEMA_VERSION) {
    return materialize({
      repo: contract.subject.acquisition.repository,
      commit: contract.subject.acquisition.base_commit,
      destination,
      cwd
    });
  }
  return materializeGitBundleSource({
    artifact: contract.subject.acquisition.git_bundle,
    declaredCommit: contract.subject.acquisition.base_commit,
    destination,
    baseDirectory: contractBaseDirectory(contract, cwd)
  });
}

async function artifactMount({ artifact, mountPath, root, label, baseDirectory }) {
  const directoryFormat = artifact.format !== "file";
  const destination = directoryFormat
    ? resolve(root, label)
    : resolve(root, label, basename(mountPath));
  const materialized = await materializeArtifact(artifact, destination, { baseDirectory });
  return {
    label,
    source: materialized.path,
    targetPath: mountPath,
    type: directoryFormat ? "directory" : "file",
    sha256: materialized.sha256,
    bytes: materialized.size,
    format: artifact.format
  };
}

export async function prepareContractArtifacts(contract, temporaryRoot, { cwd = process.cwd() } = {}) {
  if (contract.schema_version !== VERIFICATION_CONTRACT_SCHEMA_VERSION) {
    return { mounts: [], hidden: null, dependencyCache: null, frozenInputs: [] };
  }
  const root = resolve(temporaryRoot, "contract-artifacts");
  const baseDirectory = contractBaseDirectory(contract, cwd);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const frozenInputs = [];
  for (const [index, input] of contract.subject.materialization.frozen_inputs.entries()) {
    frozenInputs.push(await artifactMount({
      artifact: input.artifact,
      mountPath: input.path,
      root,
      label: `frozen-input-${index}`,
      baseDirectory
    }));
  }
  const dependencyCache = contract.subject.materialization.dependency_cache
    ? await artifactMount({
        artifact: contract.subject.materialization.dependency_cache.artifact,
        mountPath: contract.subject.materialization.dependency_cache.mount_path,
        root,
        label: "dependency-cache",
        baseDirectory
      })
    : null;
  const hidden = contract.checks.hidden
    ? await artifactMount({
        artifact: contract.checks.hidden.artifact,
        mountPath: contract.checks.hidden.mount_path,
        root,
        label: "hidden",
        baseDirectory
      })
    : null;
  return {
    mounts: [...frozenInputs, ...(dependencyCache ? [dependencyCache] : []), ...(hidden ? [hidden] : [])],
    hidden,
    dependencyCache,
    frozenInputs
  };
}

export async function prepareWorkspaceMountTargets(workspace, mounts) {
  for (const mount of mounts) {
    const target = join(workspace, mount.targetPath);
    if (mount.type === "directory") {
      await mkdir(target, { recursive: true, mode: 0o777 });
    } else {
      await mkdir(dirname(target), { recursive: true, mode: 0o777 });
      await writeFile(target, "", { mode: 0o666 });
    }
  }
}

export function dockerReadOnlyMounts(mounts) {
  return mounts.map((mount) => ({
    source: mount.source,
    target: `/workspace/${mount.targetPath}`
  }));
}
