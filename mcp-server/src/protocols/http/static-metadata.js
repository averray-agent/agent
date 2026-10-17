import { createHash } from "node:crypto";
import { serializeJson } from "./http-helpers.js";

// Cache the final bytes, not just the parsed OpenAPI object. Share the first
// in-flight build as well; retry a failed build instead of caching a rejection.
export function createCachedMetadata(build, { json = true } = {}) {
  let pending;
  return () => {
    pending ??= Promise.resolve().then(build).then((payload) => {
      const body = json ? serializeJson(payload) : String(payload);
      return {
        payload, body, json,
        headers: {
          "content-type": json ? "application/json" : "text/plain; charset=utf-8",
          "content-length": Buffer.byteLength(body),
          "cache-control": "public, max-age=300",
          etag: `"${createHash("sha256").update(body).digest("hex")}"`
        }
      };
    }).catch((error) => { pending = undefined; throw error; });
    return pending;
  };
}

export function matchesEntityTag(value, etag) {
  return String(value ?? "").split(",").some((entry) => {
    const tag = entry.trim().replace(/^W\//u, "");
    return tag === "*" || tag === etag;
  });
}
