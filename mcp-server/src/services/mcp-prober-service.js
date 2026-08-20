import http from "node:http";

import { ConfigError, ValidationError } from "../core/errors.js";
import { McpFailureSemanticsRunner } from "./mcp-failure-semantics-runner.js";
import { MCP_FAILURE_SEMANTICS_PROFILE_REF } from "./verification-profile-registry.js";

const MAX_BODY_BYTES = 128 * 1024;

export class McpProberService {
  constructor({ runner = new McpFailureSemanticsRunner(), proxyUrl, logger = console } = {}) {
    this.runner = runner;
    this.proxyUrl = requiredUrl(proxyUrl, "MCP egress proxy URL");
    this.logger = logger;
    this.server = undefined;
  }

  listen({ port = 8080, host = "0.0.0.0" } = {}) {
    if (this.server) return this.server;
    this.server = http.createServer((request, response) => this.handle(request, response));
    this.server.listen(port, host, () => {
      this.logger.info?.({ port, listener: "internal_only", suite: MCP_FAILURE_SEMANTICS_PROFILE_REF }, "mcp_prober.started");
    });
    return this.server;
  }

  async close() {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }

  async handle(request, response) {
    if (request.method === "GET" && request.url === "/health") {
      return json(response, 200, { ok: true, suite: MCP_FAILURE_SEMANTICS_PROFILE_REF });
    }
    if (request.method !== "POST" || request.url !== "/probe") {
      return json(response, 404, { error: "not_found" });
    }
    let payload;
    try {
      payload = JSON.parse(await readBody(request));
      const execution = await this.runner.run({
        profile: normalizeProfile(payload.profile),
        runId: String(payload.runId ?? ""),
        target: payload.target,
        inputs: payload.inputs,
        credential: payload.credential,
        egressGrant: String(payload.egressGrant ?? ""),
        proxyUrl: this.proxyUrl
      });
      return json(response, 200, execution);
    } catch (error) {
      this.logger.warn?.(
        { runId: String(payload?.runId ?? "unknown"), errorName: error?.name ?? "Error" },
        "mcp_prober.run_failed"
      );
      return json(response, 200, {
        status: "platform_fault",
        reason: "runner_fault",
        detail: "The fixed MCP prober failed internally. No fee is due."
      });
    }
  }
}

export function assertMcpProberEnvironment(env = process.env) {
  const forbidden = Object.keys(env).filter((name) =>
    /^(?:AUTH_|ADMIN_|AWS_|KMS_|OP_|SIGNER_|X402_|REDIS_|.*PRIVATE_KEY|.*PAYMENT)/u.test(name)
    && String(env[name] ?? "").trim() !== ""
  );
  if (forbidden.length > 0) {
    throw new ConfigError(`MCP prober received forbidden credential, state, or payment environment: ${forbidden.sort().join(", ")}.`);
  }
  requiredUrl(env.MCP_EGRESS_PROXY_URL, "MCP_EGRESS_PROXY_URL");
  return true;
}

function normalizeProfile(profile) {
  if (profile?.ref !== MCP_FAILURE_SEMANTICS_PROFILE_REF || Number(profile?.version) !== 1) {
    throw new ValidationError("MCP prober accepts only the pinned mcp-failure-semantics-v1@1 profile.");
  }
  const timeoutMs = Number(profile?.limits?.timeoutMs);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
    throw new ValidationError("MCP prober profile timeout is invalid.");
  }
  return { ref: profile.ref, name: "mcp-failure-semantics-v1", version: 1, limits: { timeoutMs } };
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new ValidationError("MCP prober request exceeded 128 KiB."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function json(response, statusCode, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(statusCode, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) });
  response.end(encoded);
}

function requiredUrl(value, label) {
  let parsed;
  try { parsed = new URL(String(value ?? "")); } catch { throw new ConfigError(`${label} is invalid.`); }
  if (parsed.protocol !== "http:" || !parsed.hostname || parsed.username || parsed.password) {
    throw new ConfigError(`${label} must be an internal HTTP URL without credentials.`);
  }
  return parsed.toString().replace(/\/$/u, "");
}
