import { readFile } from "node:fs/promises";

// /docs in the backend image, docs/ in a checkout. The Dockerfile copies this
// exact source document; do not serve a separately maintained runtime mirror.
export const PUBLIC_OPENAPI_DOCUMENT_URL = new URL("../../../docs/api/openapi.json", import.meta.url);
let documentPromise;

export function readPublicOpenApi() {
  documentPromise ??= readFile(PUBLIC_OPENAPI_DOCUMENT_URL, "utf8")
    .then(JSON.parse)
    .catch((error) => {
      documentPromise = undefined;
      throw error;
    });
  return documentPromise;
}
