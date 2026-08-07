#!/usr/bin/env node
import { fileURLToPath } from "node:url";

const COMPONENTS = ["backend", "frontend", "indexer", "site", "caddy"];
const TOGGLES = new Set(["auto", "0", "1"]);

export function resolveDeployComponents(
  value = "auto",
  { legacyRunIndexer = "auto" } = {}
) {
  const selection = String(value ?? "").trim().toLowerCase() || "auto";
  const indexerOverride = String(legacyRunIndexer ?? "auto").trim().toLowerCase() || "auto";
  if (!TOGGLES.has(indexerOverride)) {
    throw new Error(`run_indexer must be auto, 1, or 0; received ${legacyRunIndexer}.`);
  }

  if (selection === "auto") {
    return {
      backend: "auto",
      frontend: "auto",
      indexer: indexerOverride,
      site: "auto",
      caddy: "auto"
    };
  }
  if (indexerOverride !== "auto") {
    throw new Error("components and the legacy run_indexer override cannot both be explicit.");
  }

  const requested = selection.split(",").map((entry) => entry.trim());
  if (requested.some((entry) => !entry)) {
    throw new Error("components must be a comma-separated list without empty entries.");
  }
  const unknown = requested.filter((entry) => !COMPONENTS.includes(entry));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown deploy component(s): ${[...new Set(unknown)].join(", ")}. Supported: ${COMPONENTS.join(", ")}.`
    );
  }

  const selected = new Set(requested);
  return Object.fromEntries(
    COMPONENTS.map((component) => [component, selected.has(component) ? "1" : "0"])
  );
}

if (isDirectRun()) {
  try {
    const [components = "auto", legacyRunIndexer = "auto"] = process.argv.slice(2);
    process.stdout.write(`${JSON.stringify(resolveDeployComponents(components, { legacyRunIndexer }))}\n`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

function isDirectRun() {
  return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
}
