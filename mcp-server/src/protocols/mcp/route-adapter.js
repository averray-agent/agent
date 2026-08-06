import { Readable } from "node:stream";

/**
 * Invoke an existing HTTP route handler without duplicating its business logic.
 * The MCP transport supplies a small in-memory Node request/response pair and
 * receives the route's JSON payload back as a value.
 */
export async function invokeHttpRoute(handler, {
  body = undefined,
  headers = {},
  method,
  path,
  sourceRequest = undefined
}) {
  const requestBody = body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf8")];
  const request = Readable.from(requestBody);
  request.method = method;
  request.headers = { ...headers };
  request.socket = sourceRequest?.socket ?? { remoteAddress: "unknown" };

  const response = createCapturedResponse();
  const url = new URL(path, "http://localhost");
  const pathname = url.pathname.replace(/\/+$/u, "") || "/";
  const handled = await handler({ request, response, url, pathname });
  if (!handled) {
    throw new Error(`Shared HTTP handler did not accept ${method} ${pathname}.`);
  }

  const text = Buffer.concat(response.chunks).toString("utf8");
  return {
    statusCode: response.statusCode,
    headers: { ...response.headers },
    body: text ? JSON.parse(text) : undefined
  };
}

function createCapturedResponse() {
  return {
    statusCode: 200,
    headers: {},
    chunks: [],
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    getHeader(name) {
      return this.headers[String(name).toLowerCase()];
    },
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      for (const [name, value] of Object.entries(headers)) {
        this.setHeader(name, value);
      }
    },
    end(chunk = undefined) {
      if (chunk !== undefined && chunk !== null) {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8"));
      }
    }
  };
}
