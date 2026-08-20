import http from "node:http";
import { randomUUID } from "node:crypto";

import { ConfigError, ValidationError } from "../core/errors.js";
import { MCP_FAILURE_SEMANTICS_PROFILE_REF } from "./verification-profile-registry.js";

export class McpProbeCoordinator {
  constructor({
    stateStore,
    grantService,
    client,
    owner = `mcp-probe-coordinator:${randomUUID()}`,
    now = () => new Date(),
    logger = console
  } = {}) {
    if (!stateStore || !grantService || !client) {
      throw new ValidationError("MCP probe coordinator requires state, egress grants, and the internal prober client.");
    }
    this.stateStore = stateStore;
    this.grantService = grantService;
    this.client = client;
    this.owner = owner;
    this.now = now;
    this.logger = logger;
    this.inFlight = new Map();
  }

  supports(profileRef) {
    return profileRef === MCP_FAILURE_SEMANTICS_PROFILE_REF;
  }

  async start({ run, profile, ephemeralCredential }) {
    if (!this.supports(profile.ref)) return false;
    const claimed = await this.stateStore.claimVerificationRun(run.runId, {
      owner: this.owner,
      claimedAt: this.now().toISOString(),
      leaseSeconds: Math.ceil(profile.limits.timeoutMs / 1_000) + 30,
      profileRef: profile.ref
    });
    if (!claimed) return false;
    const task = this.execute({ run: claimed, profile, ephemeralCredential })
      .catch((error) => {
        this.logger.warn?.({ runId: run.runId, errorName: error?.name ?? "Error" }, "mcp_probe.dispatch_failed");
      })
      .finally(() => this.inFlight.delete(run.runId));
    this.inFlight.set(run.runId, task);
    return true;
  }

  async execute({ run, profile, ephemeralCredential }) {
    let execution;
    try {
      const grant = await this.grantService.mint({
        runId: run.runId,
        profileRef: profile.ref,
        endpoint: run.target.endpoint,
        timeoutMs: profile.limits.timeoutMs
      });
      execution = await this.client.probe({
        runId: run.runId,
        profile: { ref: profile.ref, version: profile.version, limits: { timeoutMs: profile.limits.timeoutMs } },
        target: run.target,
        inputs: run.inputs,
        credential: ephemeralCredential,
        egressGrant: grant.token
      }, { timeoutMs: profile.limits.timeoutMs + 5_000 });
    } catch {
      execution = {
        status: "inconclusive",
        reason: "runner_fault",
        detail: "The isolated MCP prober was unavailable or failed internally. No fee is due."
      };
    } finally {
      ephemeralCredential = undefined;
    }
    return this.stateStore.storeVerificationRunExecution(run.runId, {
      owner: this.owner,
      execution,
      executedAt: this.now().toISOString()
    });
  }
}

export class McpProberClient {
  constructor({ baseUrl } = {}) {
    let parsed;
    try { parsed = new URL(String(baseUrl ?? "")); } catch { throw new ConfigError("MCP_PROBER_URL is invalid."); }
    if (parsed.protocol !== "http:" || !parsed.hostname || parsed.username || parsed.password || parsed.pathname !== "/") {
      throw new ConfigError("MCP_PROBER_URL must be an internal HTTP origin without credentials or a path.");
    }
    this.baseUrl = parsed;
  }

  probe(payload, { timeoutMs }) {
    const body = JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      const request = http.request({
        hostname: this.baseUrl.hostname,
        port: this.baseUrl.port || 80,
        path: "/probe",
        method: "POST",
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }
      }, (response) => {
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024) request.destroy(new Error("MCP prober response exceeded 1 MiB."));
          else chunks.push(chunk);
        });
        response.on("end", () => {
          if (response.statusCode !== 200) {
            reject(new Error(`MCP prober returned HTTP ${response.statusCode}.`));
            return;
          }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("MCP prober returned malformed JSON.")); }
        });
      });
      const timer = setTimeout(() => request.destroy(new Error("MCP prober exceeded its internal deadline.")), timeoutMs);
      timer.unref?.();
      request.on("close", () => clearTimeout(timer));
      request.on("error", reject);
      request.end(body);
    });
  }
}
