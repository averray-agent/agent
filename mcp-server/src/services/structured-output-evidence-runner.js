import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Ajv2020 from "ajv/dist/2020.js";

import { hashCanonicalContent } from "../core/canonical-content.js";
import { normalizeWhitespace } from "../core/evidence-normalization.js";
import { ValidationError } from "../core/errors.js";
import {
  STRUCTURED_OUTPUT_EVIDENCE_CHECKS,
  STRUCTURED_OUTPUT_EVIDENCE_OUTPUTS,
  STRUCTURED_OUTPUT_EVIDENCE_PROFILE_REF
} from "./verification-profile-registry.js";
import {
  ArtifactAcquisitionError,
  ArtifactIntegrityError,
  materializeArtifact
} from "../../../witness/src/artifacts.mjs";

const DEFAULT_CITATIONS_POINTER = "/citations";
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export class StructuredOutputEvidenceRunner {
  constructor({
    materializeArtifactImpl = materializeArtifact,
    makeTemporaryDirectory = () => mkdtemp(join(tmpdir(), "averray-structured-verify-")),
    removeTemporaryDirectory = (path) => rm(path, { recursive: true, force: true }),
    ajvFactory = () => new Ajv2020({ allErrors: true, strict: false, validateFormats: false })
  } = {}) {
    this.materializeArtifactImpl = materializeArtifactImpl;
    this.makeTemporaryDirectory = makeTemporaryDirectory;
    this.removeTemporaryDirectory = removeTemporaryDirectory;
    this.ajvFactory = ajvFactory;
  }

  async inspectAvailability() {
    try {
      this.ajvFactory();
      return Object.freeze({ status: "available" });
    } catch (error) {
      return Object.freeze({
        status: "unavailable",
        reasonCode: "structured_schema_runtime_unavailable",
        reason: "The deterministic JSON Schema 2020-12 runtime is unavailable.",
        error: error instanceof Error ? error : new Error(String(error))
      });
    }
  }

  validate({ profile, target, inputs }) {
    validateStructuredOutputInputs({ profile, target, inputs });
    return true;
  }

  async run({ profile, runId, target, inputs = {} }) {
    try {
      this.validate({ profile, target, inputs });
    } catch (error) {
      if (!(error instanceof VerificationResourceLimitError)) throw error;
      return inconclusiveExecution({
        target,
        reason: "runner_fault",
        detail: error.message
      });
    }

    const temporaryDirectory = await this.makeTemporaryDirectory();
    try {
      const materialized = await materializeArtifactSet({
        target,
        temporaryDirectory,
        materializeArtifactImpl: this.materializeArtifactImpl
      });
      const artifacts = await readAndReverifyArtifactSet({ target, materialized });
      return evaluateStructuredOutputEvidence({
        profile,
        runId,
        target,
        inputs,
        artifacts,
        ajvFactory: this.ajvFactory
      });
    } catch (error) {
      if (error instanceof ArtifactAcquisitionError) {
        return inconclusiveExecution({
          target,
          reason: "target_unreachable",
          detail: error.message
        });
      }
      if (error instanceof ArtifactIntegrityError || error instanceof InRunnerArtifactIntegrityError) {
        return inconclusiveExecution({
          target,
          reason: "ambiguous_evidence",
          detail: error.message
        });
      }
      throw error;
    } finally {
      await this.removeTemporaryDirectory(temporaryDirectory);
    }
  }
}

export function evaluateStructuredOutputEvidence({
  profile,
  runId,
  target,
  inputs = {},
  artifacts,
  ajvFactory = () => new Ajv2020({ allErrors: true, strict: false, validateFormats: false })
}) {
  const checks = [];
  let output;
  let schema;
  let outputParseError;
  let schemaParseError;

  try { output = JSON.parse(decodeUtf8(artifacts.output.bytes)); }
  catch (error) { outputParseError = error; }
  try { schema = JSON.parse(decodeUtf8(artifacts.schema.bytes)); }
  catch (error) { schemaParseError = error; }

  if (!outputParseError && !schemaParseError) {
    checks.push(pass("output-integrity", "All artifact hashes were re-verified in-runner and the output and schema parsed as JSON."));
  } else {
    checks.push(fail(
      "output-integrity",
      "json_parse_failed",
      parseFailureDetail({ outputParseError, schemaParseError })
    ));
  }

  let validateSchema;
  if (schemaParseError) {
    checks.push(fail("schema-valid", "schema_json_invalid", "The declared schema did not parse as JSON."));
  } else {
    const depth = jsonDepth(schema);
    if (depth > profile.limits.schemaDepth) {
      checks.push(fail(
        "schema-valid",
        "schema_depth_exceeded",
        `The declared schema depth ${depth} exceeds the pinned maximum ${profile.limits.schemaDepth}.`
      ));
    } else {
      try {
        validateSchema = ajvFactory().compile(schema);
        checks.push(pass("schema-valid", "The declared schema compiled as JSON Schema draft 2020-12 within the pinned depth limit."));
      } catch (error) {
        checks.push(fail("schema-valid", "schema_compile_failed", boundedMessage(error)));
      }
    }
  }

  if (!validateSchema || outputParseError) {
    checks.push(fail(
      "schema-conformance",
      "schema_or_output_unavailable",
      "Schema conformance could not pass because the output or declared schema was invalid."
    ));
  } else if (validateSchema(output)) {
    checks.push(pass("schema-conformance", "The output conformed to the declared JSON Schema."));
  } else {
    checks.push(fail(
      "schema-conformance",
      "output_schema_mismatch",
      formatAjvErrors(validateSchema.errors)
    ));
  }

  const citationsPointer = inputs.citationsPointer ?? DEFAULT_CITATIONS_POINTER;
  const citationResult = outputParseError
    ? { ok: false, reason: "output_json_invalid", detail: "Citations could not resolve because the output document was invalid." }
    : resolveCitations({ output, citationsPointer, sourceCount: artifacts.sources.length });
  if (citationResult.ok) {
    checks.push(pass(
      "citation-resolution",
      `${citationResult.citations.length} citation(s) resolved through ${JSON.stringify(citationsPointer)}.`
    ));
  } else {
    checks.push(fail("citation-resolution", citationResult.reason, citationResult.detail));
  }

  if (!citationResult.ok) {
    checks.push(fail(
      "quote-support",
      "citations_unresolved",
      "Quote support could not pass because the citation contract did not resolve."
    ));
  } else {
    const sourceTexts = [];
    let sourceDecodeError;
    for (const source of artifacts.sources) {
      try { sourceTexts.push(decodeUtf8(source.bytes)); }
      catch (error) { sourceDecodeError = error; break; }
    }
    if (sourceDecodeError) {
      checks.push(fail("quote-support", "source_utf8_invalid", "A referenced source artifact was not valid UTF-8 text."));
    } else {
      const unsupported = citationResult.citations.find(({ source, quote }) =>
        !normalizeWhitespace(sourceTexts[source]).includes(normalizeWhitespace(quote))
      );
      if (unsupported) {
        checks.push(fail(
          "quote-support",
          "quote_not_present",
          `A cited quote did not appear verbatim after whitespace normalization in source ${unsupported.source}.`
        ));
      } else {
        checks.push(pass(
          "quote-support",
          "Every cited quote appeared verbatim after trim-and-collapse whitespace normalization; no case folding or fuzzy matching was used."
        ));
      }
    }
  }

  const report = {
    schemaVersion: "averray.structured-output-evidence.v1",
    profileRef: STRUCTURED_OUTPUT_EVIDENCE_PROFILE_REF,
    runId,
    citationsPointer,
    normalization: {
      whitespace: "trim_then_collapse_runs_to_single_ascii_space",
      caseFolding: false,
      fuzzyMatching: false
    },
    checks
  };
  return {
    ...executionIdentity({ target, hashesVerified: true }),
    status: "decidable",
    evidence: checks
      .filter(({ verdict }) => verdict === "pass")
      .map(({ evidenceOutput }) => evidenceOutput)
      .join(" "),
    report
  };
}

export { normalizeWhitespace } from "../core/evidence-normalization.js";

async function materializeArtifactSet({ target, temporaryDirectory, materializeArtifactImpl }) {
  const materialize = (artifact, filename) => materializeArtifactImpl(
    { ...artifact, format: "file" },
    join(temporaryDirectory, filename),
    { baseDirectory: temporaryDirectory }
  );
  return {
    output: await materialize(target.output, "output.json"),
    schema: await materialize(target.schema, "schema.json"),
    sources: await Promise.all(target.sources.map((source, index) =>
      materialize(source, `source-${index}.${source.format}`)
    ))
  };
}

async function readAndReverifyArtifactSet({ target, materialized }) {
  return {
    output: await readAndReverifyArtifact(target.output, materialized.output.path),
    schema: await readAndReverifyArtifact(target.schema, materialized.schema.path),
    sources: await Promise.all(target.sources.map((source, index) =>
      readAndReverifyArtifact(source, materialized.sources[index].path)
    ))
  };
}

async function readAndReverifyArtifact(artifact, path) {
  const bytes = await readFile(path);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== Number(artifact.bytes) || sha256 !== artifact.sha256) {
    throw new InRunnerArtifactIntegrityError(
      `In-runner artifact hash verification failed for ${artifact.locator.url}.`
    );
  }
  return { bytes, sha256, size: bytes.length, format: artifact.format };
}

function validateStructuredOutputInputs({ profile, target, inputs }) {
  if (profile?.ref !== STRUCTURED_OUTPUT_EVIDENCE_PROFILE_REF
      || profile?.handler !== "deterministic"
      || Number(profile?.handlerVersion) !== 1) {
    throw new ValidationError("structured-output-evidence-v1 requires its pinned deterministic/v1 profile.");
  }
  if (!target || typeof target !== "object" || Array.isArray(target)) {
    throw new ValidationError("The structured-output target is required.");
  }
  validateArtifact(target.output, "target.output", ["json"]);
  validateArtifact(target.schema, "target.schema", ["json"]);
  if (!Array.isArray(target.sources) || target.sources.length < 1 || target.sources.length > 16) {
    throw new ValidationError("target.sources must contain between 1 and 16 artifacts.");
  }
  target.sources.forEach((source, index) =>
    validateArtifact(source, `target.sources[${index}]`, ["text", "markdown", "json"])
  );
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) {
    throw new ValidationError("Structured-output inputs must be an object.");
  }

  const limits = profile.limits;
  enforceArtifactSize(target.output, limits.outputSizeBytes, "Output");
  enforceArtifactSize(target.schema, limits.schemaSizeBytes, "Schema");
  target.sources.forEach((source, index) =>
    enforceArtifactSize(source, limits.sourceSizeBytes, `Source ${index}`)
  );
  const totalBytes = [target.output, target.schema, ...target.sources]
    .reduce((total, artifact) => total + Number(artifact.bytes), 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.sizeBytes) {
    throw new VerificationResourceLimitError(
      `Declared artifacts exceed the ${limits.sizeBytes}-byte total materialization limit.`
    );
  }
}

function validateArtifact(artifact, label, formats) {
  if (!artifact || !formats.includes(artifact.format) || !/^[a-f0-9]{64}$/u.test(String(artifact.sha256 ?? ""))) {
    throw new ValidationError(`${label} must be a hash-pinned ${formats.join("/")} artifact.`);
  }
  if (!Number.isSafeInteger(Number(artifact.bytes)) || Number(artifact.bytes) <= 0) {
    throw new ValidationError(`${label}.bytes must be a positive integer.`);
  }
  if (artifact.locator?.kind !== "https" || !String(artifact.locator?.url ?? "").startsWith("https://")) {
    throw new ValidationError(`${label}.locator must be an HTTPS URL.`);
  }
}

function enforceArtifactSize(artifact, maximum, label) {
  if (Number(artifact.bytes) > maximum) {
    throw new VerificationResourceLimitError(`${label} artifact exceeds its ${maximum}-byte pinned limit.`);
  }
}

function resolveCitations({ output, citationsPointer, sourceCount }) {
  let value;
  try { value = resolveJsonPointer(output, citationsPointer); }
  catch (error) {
    return { ok: false, reason: "citations_pointer_invalid", detail: boundedMessage(error) };
  }
  if (!Array.isArray(value) || value.length === 0) {
    return {
      ok: false,
      reason: "citations_absent_or_empty",
      detail: "The citations pointer must resolve to a non-empty citations array."
    };
  }
  const citations = [];
  for (let index = 0; index < value.length; index += 1) {
    const citation = value[index];
    if (!citation || typeof citation !== "object" || Array.isArray(citation)
        || Object.keys(citation).some((key) => !new Set(["source", "quote"]).has(key))
        || !Number.isInteger(citation.source)
        || citation.source < 0
        || citation.source >= sourceCount
        || typeof citation.quote !== "string"
        || codePointLength(citation.quote) < 1
        || codePointLength(citation.quote) > 2_048) {
      return {
        ok: false,
        reason: "citation_entry_invalid",
        detail: `Citation ${index} must be {source: valid source index, quote: 1..2048 character string}.`
      };
    }
    citations.push({ source: citation.source, quote: citation.quote });
  }
  return { ok: true, citations };
}

function resolveJsonPointer(document, pointer) {
  if (pointer === "") return document;
  if (typeof pointer !== "string" || !pointer.startsWith("/")) {
    throw new Error("citationsPointer must be an RFC 6901 JSON Pointer.");
  }
  return pointer.slice(1).split("/").reduce((current, rawToken) => {
    if (/~(?![01])/u.test(rawToken)) throw new Error("citationsPointer contains an invalid RFC 6901 escape.");
    const token = rawToken.replaceAll("~1", "/").replaceAll("~0", "~");
    if ((current === null || typeof current !== "object") || !Object.hasOwn(current, token)) {
      throw new Error(`citationsPointer did not resolve at token ${JSON.stringify(token)}.`);
    }
    return current[token];
  }, document);
}

function jsonDepth(value, depth = 1) {
  if (!value || typeof value !== "object") return depth;
  const children = Array.isArray(value) ? value : Object.values(value);
  if (children.length === 0) return depth;
  return Math.max(...children.map((child) => jsonDepth(child, depth + 1)));
}

function pass(name, detail) {
  return Object.freeze({
    name,
    verdict: "pass",
    evidenceOutput: STRUCTURED_OUTPUT_EVIDENCE_OUTPUTS[name],
    detail
  });
}

function fail(name, reason, detail) {
  return Object.freeze({
    name,
    verdict: "fail",
    evidenceOutput: STRUCTURED_OUTPUT_EVIDENCE_OUTPUTS[name],
    reason,
    detail
  });
}

function executionIdentity({ target, hashesVerified }) {
  const artifactSet = {
    output: target.output.sha256,
    schema: target.schema.sha256,
    sources: target.sources.map(({ sha256 }) => sha256)
  };
  return {
    artifactHash: hashCanonicalContent(artifactSet),
    sourceBinding: {
      method: "sha256_artifact_set",
      verified: hashesVerified,
      ref: hashCanonicalContent(artifactSet)
    },
    environment: {
      kind: "averray_witness",
      profile: STRUCTURED_OUTPUT_EVIDENCE_PROFILE_REF,
      checkEgress: "none"
    }
  };
}

function inconclusiveExecution({ target, reason, detail }) {
  return {
    ...executionIdentity({ target, hashesVerified: false }),
    status: "inconclusive",
    reason,
    detail
  };
}

function decodeUtf8(bytes) {
  return UTF8_DECODER.decode(bytes);
}

function parseFailureDetail({ outputParseError, schemaParseError }) {
  const failed = [outputParseError && "output", schemaParseError && "schema"].filter(Boolean);
  return `The ${failed.join(" and ")} artifact${failed.length === 1 ? "" : "s"} did not parse as JSON.`;
}

function formatAjvErrors(errors) {
  const material = (errors ?? []).slice(0, 8).map(({ instancePath, keyword, message }) =>
    `${instancePath || "/"} ${keyword}: ${message}`
  ).join("; ");
  return material || "The output did not conform to the declared schema.";
}

function boundedMessage(error) {
  return String(error?.message ?? error ?? "Unknown validation error").slice(0, 1_024);
}

function codePointLength(value) {
  return [...value].length;
}

class InRunnerArtifactIntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = "InRunnerArtifactIntegrityError";
  }
}

class VerificationResourceLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "VerificationResourceLimitError";
  }
}

export function structuredOutputChecksComplete(execution) {
  return STRUCTURED_OUTPUT_EVIDENCE_CHECKS.every((name) =>
    execution?.report?.checks?.some((check) => check.name === name && check.verdict === "pass")
  );
}
