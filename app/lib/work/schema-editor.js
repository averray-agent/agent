import Ajv2020 from "ajv/dist/2020.js";
import { schemaFields } from "./schema-shape.js";

export { deriveSchemaExample, rawFieldDraft, schemaFields } from "./schema-shape.js";

const VALIDATOR_CACHE = new WeakMap();

export function assembleSchemaSubmission(schema, rawDraft) {
  const output = {};
  const errors = [];
  for (const field of schemaFields(schema)) {
    const raw = String(rawDraft?.[field.name] ?? "");
    if (!raw.trim() && !field.required) continue;
    try {
      output[field.name] = parseFieldValue(field.schema, raw);
    } catch (error) {
      errors.push({
        path: `/${field.name}`,
        message: error instanceof Error ? error.message : "Enter a valid value."
      });
    }
  }
  if (errors.length) return { valid: false, value: output, errors };
  const validation = validateSubmissionAgainstSchema(schema, output);
  return { ...validation, value: output };
}

export function validateSubmissionAgainstSchema(schema, submission) {
  try {
    let validate = VALIDATOR_CACHE.get(schema);
    if (!validate) {
      const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
      validate = ajv.compile(schema);
      VALIDATOR_CACHE.set(schema, validate);
    }
    if (validate(submission)) return { valid: true, errors: [] };
    return {
      valid: false,
      errors: (validate.errors ?? []).map(readableAjvError)
    };
  } catch (error) {
    return {
      valid: false,
      errors: [{
        path: "/",
        message: `The advertised output schema could not be compiled: ${error instanceof Error ? error.message : "unknown schema error"}`
      }]
    };
  }
}

function parseFieldValue(schema, raw) {
  const type = Array.isArray(schema?.type)
    ? schema.type.find((entry) => entry !== "null")
    : schema?.type;
  if (type === "array" || type === "object") {
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`Enter valid JSON for this ${type}.`);
    }
  }
  if (type === "integer") {
    const number = Number(raw);
    if (!Number.isInteger(number)) throw new Error("Enter a whole number.");
    return number;
  }
  if (type === "number") {
    const number = Number(raw);
    if (!Number.isFinite(number)) throw new Error("Enter a number.");
    return number;
  }
  if (type === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    throw new Error("Choose true or false.");
  }
  return raw;
}

function readableAjvError(error) {
  const missing = error?.keyword === "required" ? error?.params?.missingProperty : undefined;
  const path = `${error?.instancePath || ""}${missing ? `/${missing}` : ""}` || "/";
  if (error?.keyword === "required") {
    return { path, message: "This required field is missing." };
  }
  if (error?.keyword === "enum") {
    return { path, message: `Choose one of: ${(error?.params?.allowedValues ?? []).join(", ")}.` };
  }
  if (error?.keyword === "minLength") {
    return { path, message: `Enter at least ${error?.params?.limit} character(s).` };
  }
  if (error?.keyword === "minItems") {
    return { path, message: `Add at least ${error?.params?.limit} item(s).` };
  }
  if (error?.keyword === "pattern") {
    return { path, message: "This value does not match the required format." };
  }
  return { path, message: String(error?.message ?? "This value is invalid.") };
}
