import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_IMAGE } from "./constants.mjs";
import { runProcess } from "./process.mjs";

const WITNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NETWORK_MARKER = "AVERRAY_NETWORK_INTERFACES=";
const NETWORK_ASSERTION_EXIT = 124;

export async function ensureWitnessImage(image = DEFAULT_IMAGE) {
  const inspect = await runProcess("docker", ["image", "inspect", "--format", "{{.Id}}", image]);
  if (inspect.exitCode === 0) {
    return { image, imageId: inspect.stdout.trim(), built: false, seconds: inspect.seconds };
  }
  if (inspect.spawnError) throw new Error(`Docker is unavailable: ${inspect.spawnError}`);

  const built = await runProcess(
    "docker",
    ["build", "--pull", "-t", image, resolve(WITNESS_ROOT, "sandbox")],
    { timeoutSeconds: 900 }
  );
  if (built.exitCode !== 0) {
    throw new Error((built.stderr || built.stdout || "Witness image build failed").trim());
  }
  const builtInspect = await runProcess("docker", ["image", "inspect", "--format", "{{.Id}}", image]);
  if (builtInspect.exitCode !== 0) {
    throw new Error((builtInspect.stderr || "built Witness image could not be identified").trim());
  }
  return { image, imageId: builtInspect.stdout.trim(), built: true, seconds: built.seconds };
}

export async function runInWitnessContainer({
  image = DEFAULT_IMAGE,
  workspace,
  cache = null,
  readOnlyMounts = [],
  workingDirectory = ".",
  command,
  environment = {},
  networkMode = "none",
  timeoutSeconds,
  cpuLimit = 2,
  memoryMb = 4096,
  processLimit = 512,
  temporaryStorageMb = 1024,
  outputLimitBytes
}) {
  const name = `averray-witness-${randomUUID()}`;
  const assertNetwork = networkMode === "none";
  const wrapper = assertNetwork
    ? [
        "interfaces=$(find /sys/class/net -mindepth 1 -maxdepth 1 -exec basename '{}' ';' | LC_ALL=C sort | paste -sd, -)",
        `printf '${NETWORK_MARKER}%s\\n' \"$interfaces\" >&2`,
        `[ \"$interfaces\" = lo ] || exit ${NETWORK_ASSERTION_EXIT}`,
        "exec /bin/sh -lc \"$AVERRAY_WITNESS_COMMAND\""
      ].join("; ")
    : "exec /bin/sh -lc \"$AVERRAY_WITNESS_COMMAND\"";

  const args = [
    "create",
    "--name",
    name,
    "--network",
    networkMode,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(processLimit),
    "--memory",
    `${memoryMb}m`,
    "--cpus",
    String(cpuLimit),
    "--tmpfs",
    `/tmp:rw,nosuid,nodev,size=${temporaryStorageMb}m`,
    "--user",
    "65532:65532",
    "--env",
    "HOME=/tmp",
    "--env",
    "CI=1",
    "--env",
    "npm_config_update_notifier=false",
    "--env",
    "npm_config_audit=false",
    "--env",
    "npm_config_nodedir=/usr/local",
    "--env",
    "PIP_DISABLE_PIP_VERSION_CHECK=1",
    "--env",
    `AVERRAY_WITNESS_COMMAND=${command}`,
    "--volume",
    `${resolve(workspace)}:/workspace:rw`
  ];
  if (cache) {
    args.push("--volume", `${resolve(cache)}:/dependency-cache:rw`);
  }
  for (const mount of readOnlyMounts) {
    args.push("--volume", `${resolve(mount.source)}:${mount.target}:ro`);
  }
  args.push(
    "--workdir",
    workingDirectory === "." ? "/workspace" : `/workspace/${workingDirectory}`
  );
  for (const [key, value] of Object.entries(environment)) {
    args.push("--env", `${key}=${value}`);
  }
  args.push(image, "/bin/sh", "-lc", wrapper);

  const created = await runProcess("docker", args);
  if (created.exitCode !== 0) {
    return {
      exitCode: null,
      signal: null,
      stdout: created.stdout,
      stderr: created.stderr,
      spawnError: created.spawnError || (created.stderr || "docker create failed").trim(),
      timedOut: false,
      outputTruncated: created.outputTruncated,
      seconds: created.seconds,
      containerId: null,
      networkMode,
      networkInterfaces: [],
      networkAssertionPassed: false
    };
  }

  try {
    const containerId = created.stdout.trim() || null;
    const started = await runProcess(
      "docker",
      ["start", "--attach", name],
      { timeoutSeconds, outputLimitBytes }
    );
    const inspected = await runProcess(
      "docker",
      ["inspect", "--format", "{{json .State}} {{json .HostConfig.NetworkMode}}", name]
    );
    const markerMatch = started.stderr.match(new RegExp(`${NETWORK_MARKER}([^\\n\\r]*)`, "u"));
    const networkInterfaces = markerMatch?.[1]
      ? markerMatch[1].split(",").filter(Boolean)
      : [];
    const hostModeMatch = inspected.stdout.match(/\s+"([^"]+)"\s*$/u);
    const observedHostMode = hostModeMatch?.[1] || null;
    const networkAssertionPassed = !assertNetwork || (
      networkInterfaces.length === 1 &&
      networkInterfaces[0] === "lo" &&
      observedHostMode === "none" &&
      started.exitCode !== NETWORK_ASSERTION_EXIT
    );

    return {
      ...started,
      containerId,
      networkMode: observedHostMode,
      networkInterfaces,
      networkAssertionPassed
    };
  } finally {
    await runProcess("docker", ["rm", "--force", name]);
  }
}

export { NETWORK_ASSERTION_EXIT };
