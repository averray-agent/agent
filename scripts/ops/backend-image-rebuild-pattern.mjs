#!/usr/bin/env node

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// These are the pre-existing backend triggers. Dockerfile build-context
// sources are appended at runtime, so image inputs have one source of truth.
export const LEGACY_BACKEND_REBUILD_ALTERNATIVES = Object.freeze([
  "mcp-server/",
  "witness/",
  "sdk/",
  "examples/",
  "docs/schemas/",
  "package(-lock)?\\.json",
  "scripts/ops/redeploy-backend\\.sh",
  "deploy/(witness-docker-proxy|mcp-egress-proxy)/",
  "deploy/docker-compose\\.mainnet\\.yml",
  "deploy/backend(\\.mainnet)?\\.env\\.template",
  "deployments/(testnet|mainnet)\\.json",
]);

function logicalInstructions(source) {
  const instructions = [];
  let current = "";
  for (const rawLine of String(source).split("\n")) {
    const line = rawLine.trim();
    if (!current && (!line || line.startsWith("#"))) continue;
    const continued = line.endsWith("\\");
    const fragment = continued ? line.slice(0, -1).trimEnd() : line;
    current = current ? `${current} ${fragment}` : fragment;
    if (!continued) {
      instructions.push(current);
      current = "";
    }
  }
  if (current) throw new Error("mcp-server/Dockerfile ends inside a continued instruction.");
  return instructions;
}

function normalizeBuildContextSource(value) {
  let source = String(value).trim();
  if ((source.startsWith('"') && source.endsWith('"')) || (source.startsWith("'") && source.endsWith("'"))) {
    source = source.slice(1, -1);
  }
  source = source.replace(/^\.\//u, "");
  if (!source || source.startsWith("/") || source === ".." || source.startsWith("../") || source.includes("/../")) {
    throw new Error(`Dockerfile COPY source is outside the repository build context: ${value}`);
  }
  if (source.includes("$") || /\s/u.test(source)) {
    throw new Error(`Dockerfile COPY source cannot be mapped safely to a changed repository path: ${value}`);
  }
  return source;
}

function shellCopySources(argumentText) {
  const tokens = argumentText.trim().split(/\s+/u);
  let externalStage = false;
  while (tokens[0]?.startsWith("--")) {
    const flag = tokens.shift();
    if (flag === "--from") {
      if (!tokens.shift()) throw new Error("Dockerfile COPY --from is missing its stage.");
      externalStage = true;
    } else if (flag.startsWith("--from=")) {
      externalStage = true;
    }
  }
  if (tokens.length < 2) throw new Error(`Dockerfile COPY has no source/destination pair: ${argumentText}`);
  if (externalStage) return [];
  return tokens.slice(0, -1).map(normalizeBuildContextSource);
}

function jsonCopySources(argumentText) {
  let values;
  try {
    values = JSON.parse(argumentText);
  } catch (error) {
    throw new Error(`Dockerfile JSON COPY is invalid: ${error.message}`);
  }
  if (!Array.isArray(values) || values.length < 2 || values.some((value) => typeof value !== "string")) {
    throw new Error("Dockerfile JSON COPY must contain string sources followed by one destination.");
  }
  return values.slice(0, -1).map(normalizeBuildContextSource);
}

export function dockerfileCopySources(dockerfileText) {
  const sources = [];
  for (const instruction of logicalInstructions(dockerfileText)) {
    const match = /^COPY\s+(.+)$/iu.exec(instruction);
    if (!match) continue;
    const parsed = match[1].trim().startsWith("[")
      ? jsonCopySources(match[1].trim())
      : shellCopySources(match[1]);
    sources.push(...parsed);
  }
  return [...new Set(sources)];
}

function hasGlob(source) {
  return source.includes("*") || source.includes("?") || source.includes("[");
}

function escapeDockerSource(source) {
  let result = "";
  for (const character of source) {
    if (character === "*") result += "[^/]*";
    else if (character === "?") result += "[^/]";
    else if (character === "[") {
      throw new Error(`Dockerfile COPY bracket globs are not supported by the deploy matcher: ${source}`);
    } else if ("\\^$.*+?()|{}]".includes(character)) result += `\\${character}`;
    else result += character;
  }
  return result;
}

function sourceAlternative(source, repoRoot) {
  if (source === ".") return ".+";
  const escaped = escapeDockerSource(source);
  if (hasGlob(source)) return `${escaped}$`;
  let directory = source.endsWith("/");
  if (!directory) {
    try {
      directory = statSync(path.join(repoRoot, source)).isDirectory();
    } catch {
      directory = false;
    }
  }
  return directory ? `${escaped.replace(/\/$/u, "")}(/|$)` : `${escaped}$`;
}

export function buildBackendRebuildPattern({ dockerfileText, repoRoot }) {
  const sources = dockerfileCopySources(dockerfileText);
  if (sources.length === 0) throw new Error("mcp-server/Dockerfile exposes no build-context COPY sources.");
  const alternatives = [
    ...LEGACY_BACKEND_REBUILD_ALTERNATIVES,
    ...sources.map((source) => sourceAlternative(source, repoRoot)),
  ];
  return `^(${[...new Set(alternatives)].join("|")})`;
}

function representativeChangedPath(source, repoRoot) {
  if (source === ".") return "__backend_rebuild_probe__";
  if (hasGlob(source)) return source.replaceAll("*", "__backend_rebuild_probe__").replaceAll("?", "x");
  try {
    if (statSync(path.join(repoRoot, source)).isDirectory()) {
      return `${source.replace(/\/$/u, "")}/__backend_rebuild_probe__`;
    }
  } catch {
    // A mutation fixture may name a not-yet-created file. Treat it as a file;
    // the coverage assertion still identifies the exact uncovered source.
  }
  return source;
}

export function assertDockerfileCopyCoverage({ dockerfileText, rebuildPattern, repoRoot }) {
  const sources = dockerfileCopySources(dockerfileText);
  if (sources.length === 0) throw new Error("mcp-server/Dockerfile exposes no build-context COPY sources.");
  const matcher = new RegExp(rebuildPattern, "u");
  const uncovered = sources.filter((source) => !matcher.test(representativeChangedPath(source, repoRoot)));
  if (uncovered.length > 0) {
    throw new Error(`Backend rebuild pattern does not cover Dockerfile COPY source(s): ${uncovered.join(", ")}`);
  }
  return true;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const dockerfilePath = path.resolve(process.argv[2] ?? "mcp-server/Dockerfile");
  const repoRoot = path.resolve(process.argv[3] ?? path.dirname(path.dirname(dockerfilePath)));
  const dockerfileText = readFileSync(dockerfilePath, "utf8");
  process.stdout.write(`${buildBackendRebuildPattern({ dockerfileText, repoRoot })}\n`);
}
