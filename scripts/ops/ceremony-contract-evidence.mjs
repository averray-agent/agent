import { keccak256 } from "ethers";
import { artifactAbiHash, compareMaskedRuntime, runtimeCodeHash } from "./check-contract-provenance.mjs";

export function assertDeploymentArtifact(artifact) {
  for (const key of ["bytecode", "deployedBytecode"]) {
    if (!/^0x(?:[a-f0-9]{2})+$/iu.test(artifact?.[key]?.object ?? "")) throw new Error(`Artifact ${key} must be nonempty hex.`);
  }
  artifactAbiHash(artifact.abi);
  compareMaskedRuntime(artifact.deployedBytecode.object, artifact.deployedBytecode.object,
    artifact.deployedBytecode.immutableReferences ?? {});
}

// Only call this with code read at the canonically confirmed deployment block.
// Predictions and compiled runtime hashes are never presented as deployed proof.
export function deploymentProvenance({ artifact, deployedCode, sourceCommit, verifiedAt }) {
  assertDeploymentArtifact(artifact);
  if (!/^[a-f0-9]{40}$/u.test(String(sourceCommit))) throw new Error("Full lowercase sourceCommit required for deployment evidence.");
  if (!verifiedAt || new Date(verifiedAt).toISOString() !== verifiedAt) throw new Error("Canonical UTC verifiedAt required.");
  const runtime = compareMaskedRuntime(artifact.deployedBytecode?.object, deployedCode,
    artifact.deployedBytecode?.immutableReferences ?? {});
  if (!runtime.matches || deployedCode === "0x") throw new Error("Deployed masked runtime does not match artifact; evidence withheld.");
  return {
    sourceCommit, creationBytecodeHash: keccak256(artifact.bytecode.object),
    abiHash: artifactAbiHash(artifact.abi), runtimeCodeHash: runtimeCodeHash(deployedCode), verifiedAt,
    maskedRuntimeHash: runtime.maskedDeployedHash,
  };
}
