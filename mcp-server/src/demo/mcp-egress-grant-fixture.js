import http from "node:http";

const grants = new Map([["known-good-grant", "mcp-known-good:8080"], ["known-bad-grant", "mcp-known-bad:8080"]]);
http.createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/verify") return send(response, 404, { allowed: false });
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const allowed = grants.get(body.token);
    if (!allowed || allowed !== body.authority) return send(response, 403, { allowed: false });
    return send(response, 200, { allowed: true, authority: allowed });
  } catch { return send(response, 403, { allowed: false }); }
}).listen(8788, "0.0.0.0");

function send(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}
