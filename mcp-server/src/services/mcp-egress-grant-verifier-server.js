import http from "node:http";
import { chmod, unlink } from "node:fs/promises";

import { ConfigError, ValidationError } from "../core/errors.js";

const MAX_BODY_BYTES = 32 * 1024;

/**
 * Private control-plane listener used only by the egress proxy. It is bound to
 * an unexposed, internal-only compose network; the customer-facing HTTP router
 * deliberately has no equivalent route.
 */
export class McpEgressGrantVerifierServer {
  constructor({ grantService, logger = console } = {}) {
    if (!grantService) throw new ValidationError("MCP egress grant verifier requires a grant service.");
    this.grantService = grantService;
    this.logger = logger;
    this.server = http.createServer((request, response) => this.handle(request, response));
  }

  async listen({ socketPath } = {}) {
    const normalizedPath = String(socketPath ?? "").trim();
    if (!normalizedPath.startsWith("/") || normalizedPath.length > 200) {
      throw new ConfigError("MCP_EGRESS_GRANT_SOCKET must be a bounded absolute path.");
    }
    this.socketPath = normalizedPath;
    await unlink(normalizedPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(normalizedPath, async () => {
        this.server.off("error", reject);
        try {
          // The socket lives in a volume shared with exactly one unprivileged
          // proxy container. Filesystem isolation, not a TCP listener, is the
          // control-plane boundary.
          await chmod(normalizedPath, 0o666);
          this.logger.info?.({ transport: "unix_socket" }, "mcp_egress_grant_verifier.listening");
          resolve(this.server.address());
        } catch (error) {
          this.server.close(() => reject(error));
        }
      });
    });
  }

  async close() {
    if (this.server.listening) {
      await new Promise((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
    }
    if (this.socketPath) await unlink(this.socketPath).catch(() => {});
  }

  async handle(request, response) {
    if (request.method === "GET" && request.url === "/health") {
      return respond(response, 200, { ok: true });
    }
    if (request.method !== "POST" || request.url !== "/verify") {
      return respond(response, 404, { allowed: false });
    }
    try {
      const body = await readJson(request);
      const verified = await this.grantService.verifyBoundary({
        token: body.token,
        authority: body.authority
      });
      return respond(response, 200, verified);
    } catch (error) {
      this.logger.warn?.({ errorName: error?.name ?? "Error" }, "mcp_egress_grant_verifier.denied");
      return respond(response, 403, { allowed: false });
    }
  }
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) request.destroy(new ValidationError("MCP grant request is too large."));
      else chunks.push(chunk);
    });
    request.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new ValidationError("MCP grant request must be JSON.")); }
    });
    request.on("error", reject);
  });
}

function respond(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}
