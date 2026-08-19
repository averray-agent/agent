import http from "node:http";
import net from "node:net";

import { authorizeDockerRequest } from "./policy.mjs";

const socketPath = process.env.DOCKER_SOCKET_PATH || "/var/run/docker.sock";
const runtimeRoot = required("WITNESS_RUNTIME_ROOT");
const allowedImage = required("WITNESS_SANDBOX_IMAGE");
const containerPrefix = process.env.WITNESS_CONTAINER_PREFIX || "averray-witness-";
const port = Number(process.env.PORT || 2375);
const maxBodyBytes = 2 * 1024 * 1024;
const logAllowed = process.env.WITNESS_PROXY_LOG_ALLOWED === "1";
const allowedContainerRefs = new Set();
const containerIdsByName = new Map();

const server = http.createServer(async (request, response) => {
  try {
    const body = await readBody(request);
    const decision = authorizeDockerRequest({
      method: request.method,
      url: request.url,
      body,
      runtimeRoot,
      containerPrefix,
      allowedImage,
      allowedContainerRefs
    });
    if (!decision.allowed || !await imageAllowed(decision.image)) {
      deny(
        response,
        decision.reason || "container image does not match the pinned Witness image",
        request
      );
      return;
    }
    if (logAllowed) console.info("witness_docker_proxy.allowed", { method: request.method, path: request.url, transport: "http" });
    proxyRequest({ request, response, body, decision });
  } catch (error) {
    response.writeHead(error?.code === "body_too_large" ? 413 : 502, { "content-type": "text/plain" });
    response.end(`${error?.message ?? String(error)}\n`);
  }
});

server.on("upgrade", async (request, clientSocket, head) => {
  const decision = authorizeDockerRequest({
    method: request.method,
    url: request.url,
    body: Buffer.alloc(0),
    runtimeRoot,
    containerPrefix,
    allowedImage,
    allowedContainerRefs
  });
  if (!decision.allowed) {
    console.warn("witness_docker_proxy.denied", {
      method: request.method,
      path: request.url,
      reason: decision.reason,
      transport: "upgrade"
    });
    clientSocket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  if (logAllowed) console.info("witness_docker_proxy.allowed", { method: request.method, path: request.url, transport: "upgrade" });
  const upstreamSocket = net.createConnection(socketPath);
  upstreamSocket.once("connect", () => {
    const requestLine = `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`;
    const headers = request.rawHeaders.reduce((output, value, index) =>
      output + (index % 2 === 0 ? `${value}: ` : `${value}\r\n`), "");
    upstreamSocket.write(`${requestLine}${headers}\r\n`);
    if (head.length > 0) upstreamSocket.write(head);
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });
  upstreamSocket.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => upstreamSocket.destroy());
});

server.on("clientError", (_error, socket) => {
  socket.end("HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n");
});

server.listen(port, "0.0.0.0", () => {
  console.info("witness_docker_proxy.started", {
    port,
    listener: "internal_only",
    allowedImage,
    runtimeRoot,
    containerPrefix
  });
});

function proxyRequest({ request, response, body, decision }) {
  const headers = { ...request.headers, "content-length": String(body.length) };
  delete headers.host;
  const upstream = http.request({
    socketPath,
    method: request.method,
    path: request.url,
    headers
  }, (upstreamResponse) => {
    if (decision.containerName) {
      bufferCreateResponse({ upstreamResponse, response, containerName: decision.containerName });
      return;
    }
    unregisterRemovedContainer(request, upstreamResponse.statusCode);
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    // Docker's start --attach waits for the /wait response headers before it
    // submits /start. Flush long-lived response headers even when the daemon
    // has not produced a body yet, or the client and proxy deadlock.
    response.flushHeaders();
    upstreamResponse.pipe(response);
  });
  upstream.on("error", (error) => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
    response.end(`${error.message}\n`);
  });
  upstream.end(body);
}

function bufferCreateResponse({ upstreamResponse, response, containerName }) {
  const chunks = [];
  upstreamResponse.on("data", (chunk) => chunks.push(chunk));
  upstreamResponse.on("end", () => {
    const payload = Buffer.concat(chunks);
    if (upstreamResponse.statusCode === 201) {
      try {
        const id = String(JSON.parse(payload.toString("utf8"))?.Id ?? "").toLowerCase();
        if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error("Docker create returned an invalid container id.");
        allowedContainerRefs.add(containerName);
        allowedContainerRefs.add(id);
        containerIdsByName.set(containerName, id);
      } catch (error) {
        response.writeHead(502, { "content-type": "text/plain" });
        response.end(`${error.message}\n`);
        return;
      }
    }
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    response.end(payload);
  });
}

function unregisterRemovedContainer(request, statusCode) {
  if (request.method !== "DELETE" || Number(statusCode) < 200 || Number(statusCode) >= 300) return;
  const parsed = new URL(request.url, "http://docker-proxy.invalid");
  const path = parsed.pathname.replace(/^\/v\d+(?:\.\d+)+/u, "");
  const reference = path.match(/^\/containers\/([^/]+)$/u)?.[1];
  if (!reference) return;
  const id = containerIdsByName.get(reference) ?? reference;
  allowedContainerRefs.delete(reference);
  allowedContainerRefs.delete(id);
  containerIdsByName.delete(reference);
  for (const [name, registeredId] of containerIdsByName) {
    if (registeredId === id) {
      allowedContainerRefs.delete(name);
      containerIdsByName.delete(name);
    }
  }
}

async function imageAllowed(image) {
  if (!image || image === allowedImage) return true;
  const descriptor = await dockerJson(`/images/${encodeURIComponent(allowedImage)}/json`);
  return String(descriptor?.Id ?? "").toLowerCase() === String(image).toLowerCase();
}

function dockerJson(path) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath, method: "GET", path }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        if (response.statusCode !== 200) {
          reject(new Error(`Pinned Witness image inspection returned ${response.statusCode}.`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    request.end();
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBodyBytes) {
        const error = new Error("Docker API request body exceeds the proxy limit.");
        error.code = "body_too_large";
        reject(error);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function deny(response, reason, request) {
  console.warn("witness_docker_proxy.denied", {
    method: request?.method,
    path: request?.url,
    reason,
    transport: "http"
  });
  response.writeHead(403, { "content-type": "text/plain" });
  response.end(`Forbidden: ${reason}\n`);
}

function required(name) {
  const value = String(process.env[name] ?? "").trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
