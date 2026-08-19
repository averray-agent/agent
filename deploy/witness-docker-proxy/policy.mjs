import { resolve, sep } from "node:path";

const SAFE_ENV = /^(?:HOME|CI|npm_config_update_notifier|npm_config_audit|npm_config_nodedir|PIP_DISABLE_PIP_VERSION_CHECK|AVERRAY_WITNESS_[A-Z0-9_]+)$/u;
const CONTAINER_REF = "([a-zA-Z0-9][a-zA-Z0-9_.-]*)";

export function authorizeDockerRequest({
  method,
  url,
  body,
  runtimeRoot,
  containerPrefix = "averray-witness-",
  allowedImage,
  allowedContainerRefs = new Set()
} = {}) {
  const verb = String(method ?? "").toUpperCase();
  let parsed;
  try {
    parsed = new URL(String(url ?? ""), "http://docker-proxy.invalid");
  } catch {
    return denied("invalid Docker API URL");
  }
  const path = parsed.pathname.replace(/^\/v\d+(?:\.\d+)+/u, "") || "/";

  if ((verb === "GET" || verb === "HEAD") && path === "/_ping") return allowed();
  if (verb === "GET" && path === "/version") return allowed();
  if (verb === "GET" && /^\/images\/.+\/json$/u.test(path)) return allowed();

  if (verb === "POST" && path === "/containers/create") {
    const name = parsed.searchParams.get("name") ?? "";
    if (!name.startsWith(containerPrefix)) return denied("container name is outside the Witness prefix");
    let payload;
    try {
      payload = JSON.parse(Buffer.isBuffer(body) ? body.toString("utf8") : String(body ?? ""));
    } catch {
      return denied("container create body is not valid JSON");
    }
    const validation = validateWitnessContainerCreate(payload, { runtimeRoot, allowedImage });
    return validation.allowed ? { ...validation, containerName: name } : validation;
  }

  const lifecycle = path.match(new RegExp(`^/containers/${CONTAINER_REF}/(start|attach)$`, "u"));
  if (verb === "POST" && lifecycle) {
    return allowedContainerReference(lifecycle[1], allowedContainerRefs)
      ? allowed()
      : denied("container lifecycle target is outside the Witness prefix");
  }
  const wait = path.match(new RegExp(`^/containers/${CONTAINER_REF}/wait$`, "u"));
  if (verb === "POST" && wait) {
    return allowedContainerReference(wait[1], allowedContainerRefs)
      && parsed.searchParams.get("condition") === "next-exit"
      ? allowed()
      : denied("only next-exit waits for an approved Witness container are allowed");
  }
  const inspect = path.match(new RegExp(`^/containers/${CONTAINER_REF}/json$`, "u"));
  if (verb === "GET" && inspect) {
    return allowedContainerReference(inspect[1], allowedContainerRefs)
      ? allowed()
      : denied("container inspect target is outside the Witness prefix");
  }
  const remove = path.match(new RegExp(`^/containers/${CONTAINER_REF}$`, "u"));
  if (verb === "DELETE" && remove) {
    return allowedContainerReference(remove[1], allowedContainerRefs)
      && parsed.searchParams.get("force") === "1"
      ? allowed()
      : denied("only forced removal of Witness-prefixed containers is allowed");
  }
  return denied("Docker API endpoint is not in the Witness allowlist");
}

function allowedContainerReference(reference, allowedContainerRefs) {
  return allowedContainerRefs.has(reference);
}

export function validateWitnessContainerCreate(payload, { runtimeRoot, allowedImage } = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return denied("invalid create payload");
  const root = resolve(String(runtimeRoot ?? ""));
  if (!root || root === sep) return denied("invalid Witness runtime root");
  const image = String(payload.Image ?? "");
  if (!image || (image !== allowedImage && !/^sha256:[a-f0-9]{64}$/u.test(image))) {
    return denied("container image is not the pinned Witness image");
  }
  if (payload.User !== "65532:65532") return denied("container user must be 65532:65532");
  if (!Array.isArray(payload.Cmd) || payload.Cmd.length !== 3
      || payload.Cmd[0] !== "/bin/sh" || payload.Cmd[1] !== "-lc") {
    return denied("container command must use the fixed Witness shell wrapper");
  }
  if (!String(payload.WorkingDir ?? "").startsWith("/workspace")) {
    return denied("container working directory must stay below /workspace");
  }
  if (payload.Entrypoint != null && (!Array.isArray(payload.Entrypoint) || payload.Entrypoint.length > 0)) {
    return denied("custom entrypoints are forbidden");
  }
  for (const entry of payload.Env ?? []) {
    const separator = String(entry).indexOf("=");
    const name = separator === -1 ? String(entry) : String(entry).slice(0, separator);
    if (!SAFE_ENV.test(name)) return denied(`container environment ${name} is forbidden`);
  }

  const host = payload.HostConfig ?? {};
  if (host.NetworkMode !== "none") return denied("container network mode must be none");
  if (host.ReadonlyRootfs !== true) return denied("container root filesystem must be read-only");
  if (host.Privileged === true) return denied("privileged containers are forbidden");
  if (!Array.isArray(host.CapDrop) || !host.CapDrop.includes("ALL")) {
    return denied("all Linux capabilities must be dropped");
  }
  if ((host.CapAdd ?? []).length > 0) return denied("added Linux capabilities are forbidden");
  if (!Array.isArray(host.SecurityOpt) || !host.SecurityOpt.includes("no-new-privileges")) {
    return denied("no-new-privileges is required");
  }
  if ((host.Devices ?? []).length > 0 || (host.DeviceRequests ?? []).length > 0) {
    return denied("host devices are forbidden");
  }
  if ((host.Mounts ?? []).length > 0 || (host.VolumesFrom ?? []).length > 0) {
    return denied("Docker mounts and volumes-from are forbidden");
  }
  if (host.PidMode === "host" || host.IpcMode === "host" || host.UTSMode === "host") {
    return denied("host namespaces are forbidden");
  }
  if (host.PublishAllPorts === true || Object.keys(host.PortBindings ?? {}).length > 0) {
    return denied("published ports are forbidden");
  }
  if (!boundedPositive(host.PidsLimit, 2_048)) return denied("invalid process limit");
  if (!boundedPositive(host.Memory, 8 * 1024 * 1024 * 1024)) return denied("invalid memory limit");
  if (!boundedPositive(host.NanoCpus, 8_000_000_000)) return denied("invalid CPU limit");

  const binds = host.Binds ?? [];
  if (!Array.isArray(binds) || binds.length === 0) return denied("a bounded Witness workspace bind is required");
  for (const bind of binds) {
    const parsed = parseBind(bind);
    if (!parsed) return denied("invalid bind mount syntax");
    if (!within(root, resolve(parsed.source))) return denied("bind source escapes the Witness runtime root");
    if (!(parsed.target === "/workspace" || parsed.target === "/averray-source"
        || parsed.target === "/dependency-cache" || parsed.target.startsWith("/workspace/"))) {
      return denied("bind target escapes the Witness workspace");
    }
    if (!new Set(["ro", "rw"]).has(parsed.mode)) return denied("bind mode must be explicit ro or rw");
  }
  const tmpfs = host.Tmpfs ?? {};
  if (Object.keys(tmpfs).some((target) => !new Set(["/tmp", "/workspace"]).has(target))) {
    return denied("tmpfs target is outside the Witness workspace");
  }
  if (Object.keys(payload.NetworkingConfig?.EndpointsConfig ?? {}).length > 0) {
    return denied("network endpoint attachments are forbidden");
  }
  return { ...allowed(), image };
}

function parseBind(value) {
  const parts = String(value).split(":");
  if (parts.length !== 3) return null;
  return { source: parts[0], target: parts[1], mode: parts[2] };
}

function within(root, candidate) {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate === root || candidate.startsWith(prefix);
}

function boundedPositive(value, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 && parsed <= maximum;
}

function allowed() {
  return { allowed: true };
}

function denied(reason) {
  return { allowed: false, reason };
}
