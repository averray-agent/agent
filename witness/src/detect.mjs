import { access, readFile } from "node:fs/promises";
import { join, normalize, relative } from "node:path";

async function exists(root, path) {
  try {
    await access(join(root, path));
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function hasExactUvBuildBackend(pyproject) {
  const lines = pyproject.split(/\r?\n/u);
  const section = [];
  let inside = false;
  for (const line of lines) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/u);
    if (header) {
      if (inside) break;
      inside = header[1] === "build-system";
      continue;
    }
    if (inside) section.push(line);
  }
  const buildSystem = section.join("\n");
  return /^\s*build-backend\s*=\s*["']uv_build["']\s*(?:#.*)?$/mu.test(buildSystem) &&
    /^\s*requires\s*=\s*\[\s*["']uv_build==0\.9\.27["']\s*,?\s*\]\s*(?:#.*)?$/mu.test(buildSystem);
}

function commandFamily(command) {
  const first = command.trim().split(/\s+/u)[0] || "";
  if (["node", "npm", "npx", "pnpm", "yarn"].includes(first)) return "node";
  if (["python", "python3", "pip", "pip3", "pytest"].includes(first)) return "python";
  if (["cargo", "rustc"].includes(first)) return "rust";
  if (["go", "gofmt"].includes(first)) return "go";
  if (["ruby", "bundle", "rake"].includes(first)) return "ruby";
  return null;
}

export async function detectToolchain(root, command) {
  const detectedBy = [];
  const family = commandFamily(command);
  const probes = [
    ["package.json", "node"],
    ["pyproject.toml", "python"],
    ["requirements.txt", "python"],
    ["setup.py", "python"],
    ["Cargo.toml", "rust"],
    ["go.mod", "go"],
    ["Gemfile", "ruby"],
    ["Makefile", "other"]
  ];
  const found = [];
  for (const [file, kind] of probes) {
    if (await exists(root, file)) {
      detectedBy.push(file);
      found.push(kind);
    }
  }

  const detail = family || found[0] || "unknown";
  let kind = detail === "node" || detail === "python" ? detail : "other";
  if (!family && found.includes("node")) kind = "node";
  if (!family && !found.includes("node") && found.includes("python")) kind = "python";

  let packageManager = null;
  if (kind === "node") {
    const packageJson = await readJson(join(root, "package.json"));
    if (typeof packageJson?.packageManager === "string") {
      packageManager = packageJson.packageManager.split("@")[0];
      detectedBy.push("package.json#packageManager");
    } else if (await exists(root, "pnpm-lock.yaml")) {
      packageManager = "pnpm";
    } else if (await exists(root, "yarn.lock")) {
      packageManager = "yarn";
    } else {
      packageManager = "npm";
    }
  }

  return {
    kind,
    detail,
    packageManager,
    detectedBy: [...new Set(detectedBy)],
    additional: [...new Set(found.filter((entry) => entry !== detail))]
  };
}

export async function inferCheckDefinition(root, command, protectedPaths = []) {
  const trimmed = command.trim();
  let definitionFile = null;
  let declared = null;
  let definitionKind = "external-command";

  const npm = trimmed.match(/^(?:npm|pnpm)\s+(?:run\s+)?([A-Za-z0-9:_-]+)(?:\s|$)/u);
  const yarn = trimmed.match(/^yarn\s+([A-Za-z0-9:_-]+)(?:\s|$)/u);
  if (npm || yarn) {
    const scriptName = (npm || yarn)[1] === "test" ? "test" : (npm || yarn)[1];
    const packageJson = await readJson(join(root, "package.json"));
    definitionFile = "package.json";
    declared = typeof packageJson?.scripts?.[scriptName] === "string";
    definitionKind = "package-script";
  } else if (/^make(?:\s|$)/u.test(trimmed) && await exists(root, "Makefile")) {
    definitionFile = "Makefile";
    declared = true;
    definitionKind = "make-target";
  } else {
    const script = trimmed.match(/^(?:(?:node|python3?|sh|bash)\s+)?(\.\.?\/[A-Za-z0-9_./-]+|[A-Za-z0-9_.-]+\.(?:m?js|cjs|py|sh))(?:\s|$)/u);
    if (script) {
      const candidate = normalize(script[1]).replace(/^\.\//u, "");
      if (!candidate.startsWith("..") && await exists(root, candidate)) {
        definitionFile = candidate;
        declared = true;
        definitionKind = "repository-script";
      }
    }
  }

  const protectedDefinition = definitionFile
    ? protectedPaths.some((path) => {
      const clean = normalize(path).replace(/^\.\//u, "").replace(/[\\/]$/u, "");
      const rel = relative(clean, definitionFile);
      return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
    })
    : false;

  return {
    definitionFile,
    definitionKind,
    declared,
    candidateModifiable: definitionFile !== null && !protectedDefinition,
    protectedBy: protectedDefinition
      ? protectedPaths.find((path) => definitionFile === path || definitionFile.startsWith(`${path}/`)) || null
      : null
  };
}

export async function dependencyPlan(root, toolchain) {
  if (toolchain.kind === "node") {
    if (toolchain.packageManager !== "npm") {
      return {
        supported: false,
        reason: `phase-1 image does not pin ${toolchain.packageManager} cache preparation`
      };
    }
    const lockfile = await exists(root, "npm-shrinkwrap.json")
      ? "npm-shrinkwrap.json"
      : await exists(root, "package-lock.json") ? "package-lock.json" : null;
    if (!lockfile) {
      return { supported: false, reason: "Node dependencies are not frozen by an npm lockfile" };
    }
    return {
      supported: true,
      kind: "npm-cache",
      evidence: lockfile,
      populateCommand: "npm ci --ignore-scripts --cache /dependency-cache --no-audit --no-fund",
      offlineInstallCommand: "npm ci --offline --cache /dependency-cache --no-audit --no-fund"
    };
  }

  if (toolchain.kind === "python") {
    if (await exists(root, "uv.lock") && await exists(root, "pyproject.toml")) {
      const pyproject = await readFile(join(root, "pyproject.toml"), "utf8");
      if (!hasExactUvBuildBackend(pyproject)) {
        return {
          supported: false,
          reason: "uv projects require an exactly proven uv_build==0.9.27 build-system for this pinned Witness image"
        };
      }
      return {
        supported: true,
        proactive: true,
        kind: "uv-cache",
        evidence: {
          files: ["pyproject.toml", "uv.lock"],
          lockValidation: "uv sync --locked --no-install-local --no-build",
          buildBackend: "pyproject-proven and image-pinned uv-build==0.9.27"
        },
        populateCommand: "UV_CACHE_DIR=/dependency-cache/uv-cache UV_PROJECT_ENVIRONMENT=/tmp/witness-populate-venv UV_PYTHON_INSTALL_DIR=/dependency-cache/python UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy uv sync --locked --no-install-local --no-build",
        offlineInstallCommand: "python3 -m venv /workspace/.venv && /workspace/.venv/bin/pip install --no-index --only-binary=:all: --require-hashes --find-links=/opt/witness-wheels -r /opt/witness-toolchain/uv-build-requirements.txt && UV_CACHE_DIR=/dependency-cache/uv-cache UV_PYTHON_INSTALL_DIR=/dependency-cache/python UV_OFFLINE=1 UV_PYTHON_DOWNLOADS=never UV_LINK_MODE=copy uv sync --locked --no-build-isolation",
        checkEnvironment: {
          PATH: "/workspace/.venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
          UV_CACHE_DIR: "/dependency-cache/uv-cache",
          UV_LINK_MODE: "copy",
          UV_NO_SYNC: "1",
          UV_OFFLINE: "1",
          UV_PYTHON_DOWNLOADS: "never",
          UV_PYTHON_INSTALL_DIR: "/dependency-cache/python"
        }
      };
    }
    const candidates = [
      "requirements-test.txt",
      "requirements-dev.txt",
      "requirements.txt",
      "requirements/test.txt",
      "requirements/dev.txt"
    ];
    const requirements = [];
    for (const candidate of candidates) {
      if (await exists(root, candidate)) requirements.push(candidate);
    }
    if (requirements.length === 0) {
      return { supported: false, reason: "Python test dependencies are not frozen in a requirements file" };
    }
    const unpinned = [];
    for (const requirementsFile of requirements) {
      const content = await readFile(join(root, requirementsFile), "utf8");
      for (const line of logicalRequirementLines(content)) {
        if (!isExactRequirement(line)) unpinned.push(`${requirementsFile}: ${line}`);
      }
    }
    if (unpinned.length > 0) {
      return {
        supported: false,
        reason: `Python requirements are not exact, hash-pinned, local-code-free pins: ${unpinned.slice(0, 3).join("; ")}`
      };
    }
    const args = requirements.map((path) => `-r ${shellQuote(path)}`).join(" ");
    return {
      supported: true,
      kind: "python-wheelhouse",
      evidence: { files: requirements, pinValidation: "exact-with-sha256" },
      populateCommand: `python3 -m pip download --require-hashes --only-binary=:all: --dest /dependency-cache ${args}`,
      offlineInstallCommand: `python3 -m venv /workspace/.witness-venv && /workspace/.witness-venv/bin/pip install --require-hashes --no-index --find-links /dependency-cache ${args}`,
      checkEnvironment: { PATH: "/workspace/.witness-venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" }
    };
  }

  return {
    supported: false,
    reason: `phase-1 image has no pinned ${toolchain.detail} dependency preparation path`
  };
}

function logicalRequirementLines(content) {
  return content
    .replace(/\\\r?\n/gu, " ")
    .split(/\r?\n/gu)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function isExactRequirement(line) {
  const hashes = line.match(/\s+--hash=sha256:[a-f0-9]{64}/giu) || [];
  if (hashes.length === 0) return false;
  const withoutHashes = line.replace(/\s+--hash=sha256:[a-f0-9]{64}/giu, "").trim();
  return /^[A-Za-z0-9_.-]+(?:\[[A-Za-z0-9_.,-]+\])?==[^\s;]+(?:\s*;\s*[^#]+)?$/u.test(withoutHashes);
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
