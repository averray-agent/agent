import { access, cp, lstat, mkdir, readdir, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { runProcess } from "./process.mjs";

function looksLikeGithubSlug(value) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(value);
}

export async function resolveRepositorySource(repo, cwd = process.cwd()) {
  const candidate = isAbsolute(repo) ? repo : resolve(cwd, repo);
  try {
    const info = await stat(candidate);
    if (info.isDirectory()) {
      return { source: candidate, sourceType: "path" };
    }
  } catch {
    // A non-path value is handled as a URL or GitHub owner/repository slug.
  }

  if (looksLikeGithubSlug(repo)) {
    return { source: `https://github.com/${repo}.git`, sourceType: "github" };
  }
  if (/^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:[A-Za-z0-9_./-]+$/u.test(repo)) {
    return { source: repo, sourceType: "ssh" };
  }
  let url;
  try {
    url = new URL(repo);
  } catch {
    throw new Error(`repository is neither an existing path nor an allowed Git URL: ${repo}`);
  }
  if (!new Set(["https:", "ssh:"]).has(url.protocol)) {
    throw new Error(`repository URL protocol is not allowed: ${url.protocol}`);
  }
  return { source: repo, sourceType: "url" };
}

export async function materializeRepository({ repo, destination, cwd }) {
  const resolved = await resolveRepositorySource(repo, cwd);
  const gitProbe = resolved.sourceType === "path" && await hasGitMetadata(resolved.source)
    ? await runProcess("git", ["-C", resolved.source, "rev-parse", "--is-inside-work-tree"])
    : null;

  if (resolved.sourceType === "path" && gitProbe?.exitCode !== 0) {
    const started = performance.now();
    await cp(resolved.source, destination, {
      recursive: true,
      errorOnExist: true,
      verbatimSymlinks: true
    });
    return {
      path: destination,
      commit: null,
      source: resolved.source,
      sourceType: "path-copy",
      seconds: Number(((performance.now() - started) / 1_000).toFixed(3))
    };
  }

  const started = performance.now();
  const clone = await runProcess(
    "git",
    [
      "-c",
      "protocol.ext.allow=never",
      "-c",
      "core.hooksPath=/dev/null",
      "clone",
      "--depth",
      "1",
      "--no-tags",
      "--recurse-submodules",
      "--shallow-submodules",
      "--",
      resolved.source,
      destination
    ],
    {
      timeoutSeconds: 300,
      env: {
        ...process.env,
        GIT_ALLOW_PROTOCOL: resolved.sourceType === "path" ? "file:https:ssh" : "https:ssh"
      }
    }
  );
  if (clone.exitCode !== 0) {
    const reason = clone.spawnError || clone.stderr || clone.stdout || "git clone failed";
    throw new Error(reason.trim());
  }

  const commitResult = await runProcess("git", ["-C", destination, "rev-parse", "HEAD"]);
  if (commitResult.exitCode !== 0) {
    throw new Error((commitResult.stderr || "materialized repository has no HEAD commit").trim());
  }

  return {
    path: destination,
    commit: commitResult.stdout.trim(),
    source: resolved.source,
    sourceType: resolved.sourceType,
    seconds: Number(((performance.now() - started) / 1_000).toFixed(3))
  };
}

async function hasGitMetadata(root) {
  try {
    await access(join(root, ".git"));
    return true;
  } catch {
    return false;
  }
}

export async function createAttemptCopy(source, destination) {
  await cp(source, destination, {
    recursive: true,
    errorOnExist: true,
    verbatimSymlinks: true,
    filter(path) {
      const rel = relative(source, path);
      return rel === "" || !rel.split(/[\\/]/u).includes(".git");
    }
  });
  await makeTreeWritable(destination);
  return destination;
}

export async function makeTreeWritable(root) {
  const info = await lstat(root);
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await mkdir(root, { recursive: true, mode: 0o777 });
    await Promise.all((await readdir(root)).map((entry) => makeTreeWritable(join(root, entry))));
    await chmodForSandbox(root, info.mode, true);
    return;
  }
  await chmodForSandbox(root, info.mode, false);
}

async function chmodForSandbox(path, mode, directory) {
  const { chmod } = await import("node:fs/promises");
  const executableBits = mode & 0o111;
  await chmod(path, directory ? 0o777 : 0o666 | executableBits);
}
