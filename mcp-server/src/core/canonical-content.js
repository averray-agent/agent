import { createHash } from "node:crypto";

import { ValidationError } from "./errors.js";

export function canonicalizeContent(value) {
  if (value === null) return "null";

  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new ValidationError("Canonical content numbers must be finite.");
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalizeContent(entry)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalizeContent(value[key])}`);
    return `{${entries.join(",")}}`;
  }

  throw new ValidationError(`Unsupported canonical content type: ${typeof value}.`);
}

export function hashCanonicalContent(value) {
  const digest = createHash("sha256").update(canonicalizeContent(value)).digest("hex");
  return `0x${digest}`;
}
