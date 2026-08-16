import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { runProcess } from "./process.mjs";
import { isProtectedPath } from "./verification-contract.mjs";

const MAX_PATCH_BYTES = 5 * 1024 * 1024;

function isolatedGitEnvironment(root) {
  return {
    ...process.env,
    // Candidate workspaces can live below the Witness repository. Prevent Git
    // from discovering that parent worktree and silently prefixing patch paths.
    GIT_CEILING_DIRECTORIES: dirname(resolve(root))
  };
}

function parseNumstat(stdout) {
  return stdout
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const [added, deleted, ...pathParts] = record.split("\t");
      return {
        path: pathParts.join("\t"),
        added: added === "-" ? null : Number(added),
        deleted: deleted === "-" ? null : Number(deleted)
      };
    });
}

function unquoteDiffPath(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') || trimmed.includes("\\")) return null;
  return trimmed.replace(/^[ab]\//u, "");
}

function parseUnifiedDiff(text) {
  const files = new Map();
  let current = null;
  for (const line of text.split(/\r?\n/u)) {
    if (line.startsWith("diff --git ")) {
      const match = line.match(/^diff --git a\/(\S+) b\/(\S+)$/u);
      if (!match) {
        current = { path: null, addedLines: [], removedLines: [], unsupportedHeader: line };
      } else {
        current = {
          path: unquoteDiffPath(match[2]),
          previousPath: unquoteDiffPath(match[1]),
          addedLines: [],
          removedLines: [],
          isNew: false,
          isDeleted: false,
          mode: null,
          unsupportedHeader: null
        };
      }
      if (current.path) files.set(current.path, current);
      continue;
    }
    if (!current) continue;
    if (line === "new file mode 120000" || line === "new mode 120000") current.mode = "symlink";
    else if (line.startsWith("new file mode ")) current.isNew = true;
    else if (line.startsWith("deleted file mode ")) current.isDeleted = true;
    else if (line.startsWith("rename from ") || line.startsWith("rename to ") || line.startsWith("copy from ") || line.startsWith("copy to ")) {
      current.unsupportedHeader = line;
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      current.addedLines.push(line.slice(1));
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      current.removedLines.push(line.slice(1));
    }
  }
  return [...files.values()];
}

export async function inspectCandidatePatch({ patchPath, baseRoot }) {
  const absolutePatch = resolve(patchPath);
  const content = await readFile(absolutePatch);
  if (content.length === 0) {
    return { valid: false, reason: "candidate patch is empty", patchPath: absolutePatch };
  }
  if (content.length > MAX_PATCH_BYTES) {
    return { valid: false, reason: `candidate patch exceeds ${MAX_PATCH_BYTES} bytes`, patchPath: absolutePatch };
  }
  if (content.includes(0)) {
    return { valid: false, reason: "candidate patch contains a NUL byte", patchPath: absolutePatch };
  }

  const check = await runProcess(
    "git",
    ["-c", "core.hooksPath=/dev/null", "apply", "--check", "--whitespace=nowarn", "--", absolutePatch],
    { cwd: baseRoot, env: isolatedGitEnvironment(baseRoot), timeoutSeconds: 30 }
  );
  if (check.exitCode !== 0) {
    return {
      valid: false,
      reason: (check.stderr || check.stdout || "git apply --check failed").trim(),
      patchPath: absolutePatch
    };
  }

  const numstat = await runProcess(
    "git",
    ["-c", "core.hooksPath=/dev/null", "apply", "--numstat", "-z", "--", absolutePatch],
    { cwd: baseRoot, env: isolatedGitEnvironment(baseRoot), timeoutSeconds: 30 }
  );
  if (numstat.exitCode !== 0) {
    return {
      valid: false,
      reason: (numstat.stderr || numstat.stdout || "git apply --numstat failed").trim(),
      patchPath: absolutePatch
    };
  }

  const text = content.toString("utf8");
  const files = parseUnifiedDiff(text);
  const stats = parseNumstat(numstat.stdout);
  const changedPaths = [...new Set(stats.map((entry) => entry.path))];
  const parsedPaths = new Set(files.map((entry) => entry.path));
  const unsupported = files.find((entry) => entry.unsupportedHeader) ||
    changedPaths.find((path) => !parsedPaths.has(path));
  if (unsupported) {
    return {
      valid: false,
      reason: typeof unsupported === "string"
        ? `patch path cannot be matched to a plain unified diff: ${unsupported}`
        : `unsupported patch operation: ${unsupported.unsupportedHeader}`,
      patchPath: absolutePatch
    };
  }
  const unaccountedPath = [...parsedPaths].find((path) => !changedPaths.includes(path));
  if (files.length === 0 || unaccountedPath) {
    return {
      valid: false,
      reason: unaccountedPath
        ? `git apply did not account for parsed patch path: ${unaccountedPath}`
        : "candidate patch contains no supported file changes",
      patchPath: absolutePatch
    };
  }

  return {
    valid: true,
    patchPath: absolutePatch,
    bytes: content.length,
    changedPaths,
    stats,
    files
  };
}

export function evaluateCandidatePolicy(contract, patch) {
  const violations = [];
  const candidate = contract.candidate;
  const suppliedTestPath = contract.schema_version === "averray.verification-contract/v1.1"
    ? contract.checks.hidden?.mount_path
    : null;
  const artifactPaths = contract.schema_version === "averray.verification-contract/v1.1"
    ? [
        contract.subject.materialization.dependency_cache?.mount_path,
        ...contract.subject.materialization.frozen_inputs.map((input) => input.path)
      ].filter(Boolean)
    : [];
  if (patch.changedPaths.length > candidate.maximum_changed_files) {
    violations.push({
      detection: "maximum_changed_files_exceeded",
      message: `patch changes ${patch.changedPaths.length} files; maximum is ${candidate.maximum_changed_files}`,
      paths: patch.changedPaths
    });
  }

  for (const path of patch.changedPaths) {
    if (!candidate.allowed_paths.some((pattern) => isProtectedPath(path, [pattern]))) {
      violations.push({
        detection: "path_not_allowed",
        message: `${path} is outside candidate.allowed_paths`,
        paths: [path]
      });
    }
    if (isProtectedPath(path, candidate.protected_paths)) {
      violations.push({
        detection: "protected_path_modified",
        message: `${path} is protected from candidate modification`,
        paths: [path]
      });
    }
    if (suppliedTestPath && isProtectedPath(path, [suppliedTestPath])) {
      violations.push({
        detection: "supplied_test_modified",
        message: `${path} attempts to modify a contract-supplied test mounted read-only by the Witness`,
        paths: [path]
      });
    }
    if (artifactPaths.some((artifactPath) => isProtectedPath(path, [artifactPath]))) {
      violations.push({
        detection: "contract_artifact_modified",
        message: `${path} attempts to modify a contract artifact mounted read-only by the Witness`,
        paths: [path]
      });
    }
  }

  for (const file of patch.files) {
    if (file.mode === "symlink") {
      violations.push({
        detection: "symlink_added",
        message: `${file.path} adds or replaces a symbolic link`,
        paths: [file.path]
      });
    }
  }
  return violations;
}

export async function applyCandidatePatch({ patch, workspace }) {
  const applied = await runProcess(
    "git",
    ["-c", "core.hooksPath=/dev/null", "apply", "--whitespace=nowarn", "--", patch.patchPath],
    { cwd: workspace, env: isolatedGitEnvironment(workspace), timeoutSeconds: 30 }
  );
  return {
    applied: applied.exitCode === 0,
    reason: applied.exitCode === 0 ? null : (applied.stderr || applied.stdout || "git apply failed").trim()
  };
}
