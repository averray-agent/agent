#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_IMAGE } from "../src/constants.mjs";
import { ensureWitnessImage, runInWitnessContainer } from "../src/docker.mjs";
import { runPreflight } from "../src/preflight.mjs";

const WITNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = resolve(WITNESS_ROOT, "test", "fixtures");
const outputIndex = process.argv.indexOf("--out");
const outputPath = outputIndex >= 0 ? resolve(process.argv[outputIndex + 1]) : null;

function staticInference(name) {
  if (name === "missing-toolchain") throw new Error("unsupported toolchain");
  return "HERMETIC";
}

function redGreen({ redOutput, greenOutput, expected }) {
  return {
    expected,
    withoutExecutionGuard: {
      status: redOutput === expected ? "GREEN" : "RED",
      output: redOutput
    },
    withExecutionGuard: {
      status: greenOutput === expected ? "GREEN" : "RED",
      output: greenOutput
    }
  };
}

await ensureWitnessImage(DEFAULT_IMAGE);
const networkRequired = await runPreflight({
  repo: resolve(FIXTURES, "network-required"),
  check: "npm test"
});
const looksHermetic = await runPreflight({
  repo: resolve(FIXTURES, "looks-hermetic"),
  check: "npm test"
});
const missingToolchain = await runPreflight({
  repo: resolve(FIXTURES, "missing-toolchain"),
  check: "ruby test.rb"
});
const bridgeControl = await runInWitnessContainer({
  image: DEFAULT_IMAGE,
  workspace: resolve(FIXTURES, "network-none"),
  command: "node -e 'const names=Object.keys(require(\"node:os\").networkInterfaces()).sort(); console.log(\"CONTROL_INTERFACES=\"+names.join(\",\")); process.exit(names.some((name)=>name!==\"lo\")?1:0)'",
  networkMode: "bridge",
  timeoutSeconds: 30
});
const networkNone = await runPreflight({
  repo: resolve(FIXTURES, "network-none"),
  check: "npm test"
});

let missingStatic;
try {
  missingStatic = staticInference("missing-toolchain");
} catch (error) {
  missingStatic = `UNTYPED_ERROR: ${error.message}`;
}

const evidence = {
  generatedAt: new Date().toISOString(),
  drills: {
    genuinelyNeedsNetwork: {
      ...redGreen({
        redOutput: staticInference("network-required"),
        greenOutput: networkRequired.classification,
        expected: "REQUIRES_NETWORK"
      }),
      guardedExitStatus: networkRequired.baseExitStatus,
      guardedFailureReason: networkRequired.observedFailureReason
    },
    missingToolchain: {
      ...redGreen({
        redOutput: missingStatic,
        greenOutput: missingToolchain.classification,
        expected: "UNMATERIALIZABLE"
      }),
      guardedFailureReason: missingToolchain.observedFailureReason
    },
    looksHermeticButIsNot: {
      ...redGreen({
        redOutput: staticInference("looks-hermetic"),
        greenOutput: looksHermetic.classification,
        expected: "REQUIRES_NETWORK"
      }),
      misleadingEvidence: ["package.json#scripts.test", "package-lock.json"],
      guardedExitStatus: looksHermetic.baseExitStatus,
      guardedFailureReason: looksHermetic.observedFailureReason
    },
    networkModeNone: {
      expected: "only loopback visible from inside container",
      withoutExecutionGuard: {
        status: bridgeControl.exitCode === 0 ? "GREEN" : "RED",
        output: {
          requestedMode: "bridge",
          exitStatus: bridgeControl.exitCode,
          stderr: bridgeControl.stderr.trim()
        }
      },
      withExecutionGuard: {
        status: networkNone.sandbox.networkAssertion === "passed" &&
          networkNone.sandbox.observedInterfaces.join(",") === "lo" ? "GREEN" : "RED",
        output: {
          observedMode: networkNone.sandbox.observedNetworkMode,
          observedInterfaces: networkNone.sandbox.observedInterfaces,
          assertion: networkNone.sandbox.networkAssertion
        }
      }
    }
  }
};

const json = `${JSON.stringify(evidence, null, 2)}\n`;
if (outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, json);
}
process.stdout.write(json);

const allGreenWithGuard = Object.values(evidence.drills).every((drill) => drill.withExecutionGuard.status === "GREEN");
const allRedWithoutGuard = Object.values(evidence.drills).every((drill) => drill.withoutExecutionGuard.status === "RED");
if (!allGreenWithGuard || !allRedWithoutGuard) process.exitCode = 1;
