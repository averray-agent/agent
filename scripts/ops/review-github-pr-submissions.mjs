#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

export function parseArgs(argv) {
  const options = { baseUrl: "https://api.averray.com" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (["--list", "--preview", "--settle"].includes(flag)) {
      if (options.mode) throw new Error("Choose exactly one of --list, --preview, --settle.");
      options.mode = flag.slice(2);
      if (flag !== "--list") options.sessionId = argv[++i];
    } else if (flag === "--expect") options.expect = argv[++i];
    else if (flag === "--base-url") options.baseUrl = argv[++i];
    else throw new Error(`Unknown option: ${flag}`);
  }
  if (!options.mode || (options.mode !== "list" && (!options.sessionId || options.sessionId.startsWith("--")))) throw new Error("A mode and session id (except --list) are required.");
  if (options.mode === "settle" && !["approved", "rejected", "disputed", "platform_fault", "inconclusive"].includes(options.expect)) throw new Error("--settle requires --expect <verdict outcome> (human_fallback has outcome disputed).");
  const url = new URL(options.baseUrl);
  if (url.username || url.password || (url.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(url.hostname))) throw new Error("Use HTTPS (or a local test server).");
  return options;
}

export async function review(options, { request, print = console.log }) {
  if (options.mode === "list") { print(JSON.stringify(await request("GET", "/admin/verifier/pending"), null, 2)); return 0; }
  if (!["preview", "settle"].includes(options.mode)) throw new Error(`Unknown review mode: ${options.mode}`);
  const payload = { sessionId: options.sessionId };
  const verdict = await request("POST", "/admin/verifier/run", { ...payload, preview: true });
  print(JSON.stringify(verdict, null, 2));
  if (options.mode === "preview") return 0;
  if (verdict.outcome !== options.expect) return 2;
  print(JSON.stringify(await request("POST", "/admin/verifier/run", { ...payload, expectOutcome: options.expect }), null, 2));
  return 0;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  // Reuse the established KMS mint helper, never print or persist the token.
  const { stdout } = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL("./mint-admin-jwt.mjs", import.meta.url)),
    "--profile", "mainnet", "--roles", "admin", "--expires-in-days", "0.04", "--use-kms", "--quiet"
  ], { env: process.env, maxBuffer: 64 * 1024 });
  const token = stdout.trim();
  if (!token || /\s/u.test(token)) throw new Error("KMS mint did not return a single token.");
  process.exitCode = await review(options, { request: async (method, path, payload) => {
    const response = await fetch(new URL(path, options.baseUrl), { method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(payload ? { body: JSON.stringify(payload) } : {}), signal: AbortSignal.timeout(180_000), redirect: "error" });
    const body = await response.json();
    if (!response.ok) throw new Error(`Review request failed (HTTP ${response.status}): ${body.code ?? body.error ?? "see operator logs"}`);
    return body;
  } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("Review failed. Check KMS configuration, authentication and the backend; no token is logged. Do not retry settlement without checking the session."); process.exitCode = 1; });
}
