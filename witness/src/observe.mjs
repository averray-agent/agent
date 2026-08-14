const NETWORK_PATTERNS = [
  /ENETUNREACH/iu,
  /EAI_AGAIN/iu,
  /ENOTFOUND/iu,
  /network is unreachable/iu,
  /temporary failure in name resolution/iu,
  /could not resolve host/iu,
  /getaddrinfo[^\n]*(?:failed|ENOTFOUND|EAI_AGAIN)/iu,
  /failed to establish a new connection/iu,
  /fetch failed/iu,
  /socket hang up/iu
];

const DEPENDENCY_PATTERNS = [
  /cannot find (?:package|module)/iu,
  /module not found/iu,
  /no module named/iu,
  /could not find a version that satisfies/iu,
  /minversion[^\n]*requires pytest-[^\n]*actual pytest-/iu,
  /cannot load such file/iu,
  /node_modules[^\n]*not found/iu
];

const MISSING_SCRIPT_PATTERNS = [
  /missing script:/iu,
  /command "[^"]+" not found/iu,
  /couldn't find a script named/iu
];

export function executableFromCommand(command) {
  const tokens = command.trim().split(/\s+/u);
  while (tokens[0]?.includes("=") && !tokens[0].startsWith("./")) tokens.shift();
  if (tokens[0] === "env") tokens.shift();
  return (tokens[0] || "").replace(/^.*\//u, "");
}

export function interpretExecution(result, { command, definition }) {
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const rootExecutable = executableFromCommand(command);
  const missingExecutable = extractMissingExecutable(output);
  const missingDeclaredScript = MISSING_SCRIPT_PATTERNS.some((pattern) => pattern.test(output));
  const rootExecutableMissing = result.exitCode === 127 && (
    !missingExecutable || missingExecutable === rootExecutable
  );
  const commandAbsent = definition.declared === false || missingDeclaredScript || rootExecutableMissing;
  const networkFailure = result.exitCode !== 0 && NETWORK_PATTERNS.some((pattern) => pattern.test(output));
  const dependencyFailure = result.exitCode !== 0 && (
    DEPENDENCY_PATTERNS.some((pattern) => pattern.test(output)) ||
    Boolean(missingExecutable && missingExecutable !== rootExecutable)
  );

  return {
    commandAbsent,
    dependencyFailure,
    missingExecutable,
    networkFailure,
    timedOut: result.timedOut === true,
    ran: result.exitCode !== null && !commandAbsent && !rootExecutableMissing
  };
}

export function extractFailureReason(result, fallback) {
  if (result?.timedOut) return `timed out after ${result.seconds} seconds`;
  if (result?.spawnError) return result.spawnError;
  const combined = `${result?.stderr || ""}\n${result?.stdout || ""}`;
  const lines = combined
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("AVERRAY_NETWORK_INTERFACES="));
  return lines.slice(-6).join(" | ") || fallback;
}

function extractMissingExecutable(output) {
  const patterns = [
    /(?:^|\n)(?:(?:\/bin\/)?sh:\s*\d+:\s*)?([A-Za-z0-9_./-]+): (?:not found|command not found)(?:\n|$)/iu,
    /(?:^|\n)([A-Za-z0-9_./-]+): No such file or directory(?:\n|$)/iu
  ];
  for (const pattern of patterns) {
    const match = output.match(pattern);
    if (match) return match[1].replace(/^.*\//u, "");
  }
  return null;
}

export function looksLikeNetworkFailure(result) {
  const output = `${result?.stdout || ""}\n${result?.stderr || ""}`;
  return NETWORK_PATTERNS.some((pattern) => pattern.test(output));
}
