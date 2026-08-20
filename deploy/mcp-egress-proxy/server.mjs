import dns from "node:dns/promises";
import http from "node:http";
import net from "node:net";

import { extractBearer, normalizeConnectAuthority, publicTargetAllowed } from "./policy.mjs";

const port = parsePort(process.env.PORT ?? 8080, "PORT");
const verifyTarget = parseGrantVerifier(process.env);
const proberUrl = parseInternalUrl(process.env.MCP_PROBER_URL);
const allowPrivateFixtures = process.env.MCP_EGRESS_ALLOW_PRIVATE_FIXTURES === "1";

const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end('{"ok":true}');
    return;
  }
  if (request.method === "POST" && request.url === "/probe") {
    try {
      await forwardProbe(request, response);
    } catch {
      if (!response.headersSent) {
        response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
        response.end('{"error":"prober_unavailable"}');
      } else {
        response.destroy();
      }
    }
    return;
  }
  response.writeHead(405, { "content-type": "application/json" });
  response.end('{"error":"connect_only"}');
});

server.on("connect", async (request, clientSocket, head) => {
  let authority = "invalid";
  try {
    const target = normalizeConnectAuthority(request.url);
    authority = target.authority;
    const grant = extractBearer(request.headers["proxy-authorization"]);
    await assertGrant({ grant, authority });
    const addresses = await dns.lookup(target.hostname, { all: true, verbatim: true });
    const pinned = addresses.find(({ address }) => publicTargetAllowed(address, { allowPrivateFixtures }));
    if (!pinned) throw new Error("target_address_denied");
    const targetSocket = net.connect({ host: pinned.address, port: target.port });
    const fail = () => deny(clientSocket, 502);
    targetSocket.setTimeout(35_000, () => targetSocket.destroy(new Error("target_timeout")));
    targetSocket.once("error", fail);
    targetSocket.once("connect", () => {
      targetSocket.off("error", fail);
      targetSocket.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => targetSocket.destroy());
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) targetSocket.write(head);
      clientSocket.pipe(targetSocket).pipe(clientSocket);
    });
  } catch (error) {
    console.warn(JSON.stringify({ event: "mcp_egress.denied", authority, reason: error?.message ?? "denied" }));
    deny(clientSocket, error?.message === "target_address_denied" ? 403 : 403);
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(JSON.stringify({ event: "mcp_egress.listening", port }));
});

function assertGrant({ grant, authority }) {
  const body = JSON.stringify({ token: grant, authority });
  return new Promise((resolve, reject) => {
    const request = http.request({
      ...(verifyTarget.socketPath
        ? { socketPath: verifyTarget.socketPath }
        : { hostname: verifyTarget.hostname, port: verifyTarget.port }),
      path: "/verify",
      method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) }
    }, (response) => {
      const chunks = [];
      let bytes = 0;
      response.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 16 * 1024) request.destroy(new Error("grant_response_too_large"));
        else chunks.push(chunk);
      });
      response.on("end", () => {
        if (response.statusCode !== 200) return reject(new Error("grant_denied"));
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          if (parsed.allowed !== true || parsed.authority !== authority) throw new Error("grant_denied");
          resolve();
        } catch { reject(new Error("grant_denied")); }
      });
    });
    request.setTimeout(3_000, () => request.destroy(new Error("grant_timeout")));
    request.on("error", reject);
    request.end(body);
  });
}

function forwardProbe(incoming, outgoing) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const request = http.request({
      hostname: proberUrl.hostname,
      port: proberUrl.port,
      path: "/probe",
      method: "POST",
      headers: { "content-type": "application/json" }
    }, (response) => {
      outgoing.writeHead(response.statusCode ?? 503, {
        "content-type": "application/json",
        "cache-control": "no-store"
      });
      response.pipe(outgoing);
      response.on("end", resolve);
      response.on("error", reject);
    });
    request.setTimeout(35_000, () => request.destroy(new Error("prober_timeout")));
    request.on("error", reject);
    incoming.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 128 * 1024) request.destroy(new Error("probe_request_too_large"));
    });
    incoming.on("error", reject);
    incoming.pipe(request);
  });
}

function deny(socket, status) {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} Denied\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function parsePort(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error(`${name}_invalid`);
  return parsed;
}

function parseInternalUrl(value) {
  const parsed = new URL(String(value ?? ""));
  if (parsed.protocol !== "http:" || !parsed.hostname || parsed.username || parsed.password || parsed.pathname !== "/") {
    throw new Error("MCP_EGRESS_GRANT_VERIFY_URL_invalid");
  }
  return { hostname: parsed.hostname, port: parsePort(parsed.port || 80, "grant_port") };
}

function parseGrantVerifier(env) {
  const socketPath = String(env.MCP_EGRESS_GRANT_VERIFY_SOCKET ?? "").trim();
  if (socketPath) {
    if (!socketPath.startsWith("/") || socketPath.length > 200) throw new Error("MCP_EGRESS_GRANT_VERIFY_SOCKET_invalid");
    return { socketPath };
  }
  return parseInternalUrl(env.MCP_EGRESS_GRANT_VERIFY_URL);
}
