#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { publicOpenApiErrors } from "../../mcp-server/src/core/public-openapi-contract.js";

const document = JSON.parse(await readFile(new URL("../../docs/api/openapi.json", import.meta.url), "utf8"));
const errors = publicOpenApiErrors(document);
if (errors.length) {
  console.error(`Public OpenAPI contract drift:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  process.exitCode = 1;
} else {
  console.log("Public OpenAPI contract covers the public discovery registry.");
}
