import { ValidationError } from "./errors.js";

const BUILTIN_JOB_SCHEMAS = new Map([
  ["schema://jobs/coding-input", objectSchema({
    $id: "schema://jobs/coding-input",
    description: "Generic coding job input.",
    required: ["task", "acceptanceCriteria"],
    properties: {
      task: stringSchema({ minLength: 1 }),
      acceptanceCriteria: arrayOfStrings({ minItems: 1 }),
      repo: stringSchema({ minLength: 1 }),
      files: arrayOfStrings()
    }
  })],
  ["schema://jobs/coding-output", objectSchema({
    $id: "schema://jobs/coding-output",
    description: "Generic coding job output.",
    required: ["summary", "output", "status"],
    properties: {
      summary: stringSchema({ minLength: 1 }),
      output: stringSchema({ minLength: 1 }),
      status: enumString(["complete", "partial", "blocked"]),
      filesChanged: arrayOfStrings()
    }
  })],
  ["schema://jobs/github-pr-evidence-output", objectSchema({
    $id: "schema://jobs/github-pr-evidence-output",
    description: "GitHub pull request evidence for open-source issue jobs.",
    required: ["prUrl", "summary", "tests"],
    properties: {
      prUrl: stringSchema({ minLength: 1 }),
      summary: stringSchema({ minLength: 1 }),
      tests: stringSchema({ minLength: 1 }),
      notes: stringSchema(),
      issueNumber: integerSchema({ minimum: 1 }),
      issueUrl: stringSchema(),
      commitUrl: stringSchema(),
      branchUrl: stringSchema(),
      filesChanged: arrayOfStrings(),
      referencesIssue: booleanSchema(),
      checksPassing: booleanSchema(),
      ciStatus: enumString(["unknown", "pending", "passing", "failing"]),
      reviewApproved: booleanSchema(),
      merged: booleanSchema()
    }
  })],
  ["schema://jobs/governance-input", objectSchema({
    $id: "schema://jobs/governance-input",
    description: "Generic governance job input.",
    required: ["proposal", "requestedOutcome"],
    properties: {
      proposal: stringSchema({ minLength: 1 }),
      requestedOutcome: stringSchema({ minLength: 1 }),
      constraints: arrayOfStrings()
    }
  })],
  ["schema://jobs/governance-output", objectSchema({
    $id: "schema://jobs/governance-output",
    description: "Generic governance job output.",
    required: ["summary", "decisionSignal"],
    properties: {
      summary: stringSchema({ minLength: 1 }),
      decisionSignal: enumString(["approve", "reject", "revise"]),
      recommendations: arrayOfStrings()
    }
  })],
  ["schema://jobs/review-input", objectSchema({
    $id: "schema://jobs/review-input",
    description: "PR or document review input.",
    required: ["subject", "reviewScope", "rubric"],
    properties: {
      subject: stringSchema({ minLength: 1 }),
      reviewScope: stringSchema({ minLength: 1 }),
      rubric: arrayOfStrings({ minItems: 1 }),
      files: arrayOfStrings()
    }
  })],
  ["schema://jobs/pr-review-findings-output", objectSchema({
    $id: "schema://jobs/pr-review-findings-output",
    description: "Structured PR review findings.",
    required: ["summary", "findings", "risk_level", "files_touched", "recommended_next_step"],
    properties: {
      summary: stringSchema({ minLength: 1 }),
      findings: {
        type: "array",
        minItems: 1,
        items: objectSchema({
          required: ["severity", "file", "issue", "recommendation"],
          properties: {
            severity: enumString(["low", "medium", "high", "critical"]),
            file: stringSchema({ minLength: 1 }),
            issue: stringSchema({ minLength: 1 }),
            recommendation: stringSchema({ minLength: 1 })
          }
        })
      },
      risk_level: enumString(["low", "medium", "high"]),
      files_touched: arrayOfStrings({ minItems: 1 }),
      recommended_next_step: enumString(["merge", "fix_and_retest", "request_changes"])
    }
  })],
  ["schema://jobs/release-input", objectSchema({
    $id: "schema://jobs/release-input",
    description: "Release readiness review input.",
    required: ["release_id", "checklist"],
    properties: {
      release_id: stringSchema({ minLength: 1 }),
      checklist: arrayOfStrings({ minItems: 1 }),
      context: arrayOfStrings()
    }
  })],
  ["schema://jobs/release-readiness-output", objectSchema({
    $id: "schema://jobs/release-readiness-output",
    description: "Structured release go/no-go output.",
    required: ["release_id", "checks_passed", "checks_failed", "blockers", "go_no_go"],
    properties: {
      release_id: stringSchema({ minLength: 1 }),
      checks_passed: arrayOfStrings(),
      checks_failed: arrayOfStrings(),
      blockers: arrayOfStrings(),
      go_no_go: enumString(["go", "no_go"])
    }
  })],
  ["schema://jobs/triage-input", objectSchema({
    $id: "schema://jobs/triage-input",
    description: "Issue triage input.",
    required: ["report", "routingOptions"],
    properties: {
      report: stringSchema({ minLength: 1 }),
      routingOptions: arrayOfStrings({ minItems: 1 }),
      componentHints: arrayOfStrings()
    }
  })],
  ["schema://jobs/issue-defect-triage-output", objectSchema({
    $id: "schema://jobs/issue-defect-triage-output",
    description: "Structured issue triage output.",
    required: ["category", "severity", "component", "repro_clarity", "next_owner", "duplication_risk"],
    properties: {
      category: enumString(["bug", "ops", "docs", "governance", "integration"]),
      severity: enumString(["low", "medium", "high", "critical"]),
      component: enumString(["api", "indexer", "frontend", "contracts", "ops"]),
      repro_clarity: enumString(["clear", "partial", "unclear"]),
      next_owner: enumString(["backend", "frontend", "ops", "contracts", "docs"]),
      duplication_risk: enumString(["low", "medium", "high"])
    }
  })],
  ["schema://jobs/docs-input", objectSchema({
    $id: "schema://jobs/docs-input",
    description: "Documentation audit input.",
    required: ["surfaces", "goal"],
    properties: {
      surfaces: arrayOfStrings({ minItems: 1 }),
      goal: stringSchema({ minLength: 1 }),
      context: arrayOfStrings()
    }
  })],
  ["schema://jobs/docs-drift-audit-output", objectSchema({
    $id: "schema://jobs/docs-drift-audit-output",
    description: "Structured docs drift output.",
    required: ["source_surface", "drift_findings", "missing_updates", "severity", "fix_recommendation"],
    properties: {
      source_surface: stringSchema({ minLength: 1 }),
      drift_findings: {
        type: "array",
        items: objectSchema({
          required: ["surface_a", "surface_b", "mismatch"],
          properties: {
            surface_a: stringSchema({ minLength: 1 }),
            surface_b: stringSchema({ minLength: 1 }),
            mismatch: stringSchema({ minLength: 1 })
          }
        })
      },
      missing_updates: arrayOfStrings(),
      severity: enumString(["low", "medium", "high"]),
      fix_recommendation: stringSchema({ minLength: 1 })
    }
  })],
  ["schema://jobs/dependency-remediation-input", objectSchema({
    $id: "schema://jobs/dependency-remediation-input",
    description: "Dependency vulnerability remediation input from public advisory sources such as OSV/NVD.",
    required: ["ecosystem", "packageName", "vulnerableVersion", "fixedVersion", "advisoryIds", "instructions"],
    properties: {
      ecosystem: enumString(["npm"]),
      packageName: stringSchema({ minLength: 1 }),
      vulnerableVersion: stringSchema({ minLength: 1 }),
      fixedVersion: stringSchema({ minLength: 1 }),
      repo: stringSchema(),
      manifestPath: stringSchema(),
      advisoryIds: arrayOfStrings({ minItems: 1 }),
      advisoryUrls: arrayOfStrings(),
      instructions: arrayOfStrings({ minItems: 1 })
    }
  })],
  ["schema://jobs/dependency-remediation-output", objectSchema({
    $id: "schema://jobs/dependency-remediation-output",
    description: "Structured pull request evidence for a dependency vulnerability remediation.",
    required: ["prUrl", "packageName", "vulnerableVersion", "fixedVersion", "advisoryIds", "summary", "tests"],
    properties: {
      prUrl: stringSchema({ minLength: 1 }),
      packageName: stringSchema({ minLength: 1 }),
      vulnerableVersion: stringSchema({ minLength: 1 }),
      fixedVersion: stringSchema({ minLength: 1 }),
      advisoryIds: arrayOfStrings({ minItems: 1 }),
      summary: stringSchema({ minLength: 1 }),
      tests: stringSchema({ minLength: 1 }),
      repo: stringSchema(),
      manifestPath: stringSchema(),
      lockfilesUpdated: arrayOfStrings(),
      filesChanged: arrayOfStrings(),
      ciStatus: enumString(["unknown", "pending", "passing", "failing"]),
      checksPassing: booleanSchema(),
      notes: stringSchema()
    }
  })],
  ["schema://jobs/open-data-quality-audit-input", objectSchema({
    $id: "schema://jobs/open-data-quality-audit-input",
    description: "Public open-data dataset/resource quality audit input.",
    required: ["portal", "datasetTitle", "datasetUrl", "resourceUrl", "instructions"],
    properties: {
      portal: enumString(["data.gov"]),
      datasetId: stringSchema(),
      datasetTitle: stringSchema({ minLength: 1 }),
      datasetUrl: stringSchema({ minLength: 1 }),
      resourceId: stringSchema(),
      resourceTitle: stringSchema(),
      resourceUrl: stringSchema({ minLength: 1 }),
      resourceFormat: stringSchema(),
      agency: stringSchema(),
      license: stringSchema(),
      modified: stringSchema(),
      metadataModified: stringSchema(),
      instructions: arrayOfStrings({ minItems: 1 })
    }
  })],
  ["schema://jobs/open-data-quality-audit-output", objectSchema({
    $id: "schema://jobs/open-data-quality-audit-output",
    description: "Structured evidence for a public open-data dataset/resource quality audit.",
    required: ["dataset_title", "dataset_url", "resource_url", "checks", "findings", "no_issue_found", "summary", "recommended_actions"],
    properties: {
      dataset_title: stringSchema({ minLength: 1 }),
      dataset_url: stringSchema({ minLength: 1 }),
      resource_url: stringSchema({ minLength: 1 }),
      resource_format: stringSchema(),
      checks: {
        type: "array",
        minItems: 1,
        items: objectSchema({
          required: ["name", "status", "evidence"],
          properties: {
            name: stringSchema({ minLength: 1 }),
            status: enumString(["pass", "warn", "fail", "unknown"]),
            evidence: stringSchema({ minLength: 1 })
          }
        })
      },
      findings: {
        type: "array",
        items: objectSchema({
          required: ["severity", "issue", "evidence", "recommendation"],
          properties: {
            severity: enumString(["low", "medium", "high"]),
            issue: stringSchema({ minLength: 1 }),
            evidence: stringSchema({ minLength: 1 }),
            recommendation: stringSchema({ minLength: 1 })
          }
        })
      },
      no_issue_found: booleanSchema(),
      summary: stringSchema({ minLength: 1 }),
      recommended_actions: arrayOfStrings({ minItems: 1 }),
      notes: stringSchema()
    }
  })],
  ["schema://jobs/wikipedia-maintenance-input", objectSchema({
    $id: "schema://jobs/wikipedia-maintenance-input",
    description: "Wikipedia public article maintenance job input.",
    required: ["project", "pageTitle", "pageUrl", "revisionId", "taskType", "instructions"],
    properties: {
      project: enumString(["wikipedia"]),
      language: stringSchema(),
      pageTitle: stringSchema({ minLength: 1 }),
      pageUrl: stringSchema({ minLength: 1 }),
      revisionId: stringSchema({ minLength: 1 }),
      taskType: enumString(["citation_repair", "freshness_check", "infobox_consistency"]),
      sourceUrls: arrayOfStrings(),
      instructions: arrayOfStrings({ minItems: 1 })
    }
  })],
  ["schema://jobs/wikipedia-citation-repair-output", objectSchema({
    $id: "schema://jobs/wikipedia-citation-repair-output",
    description: "Reviewable citation repair proposal for Wikipedia articles.",
    required: ["page_title", "revision_id", "citation_findings", "proposed_changes", "review_notes"],
    properties: {
      page_title: stringSchema({ minLength: 1 }),
      revision_id: stringSchema({ minLength: 1 }),
      citation_findings: {
        type: "array",
        minItems: 1,
        items: objectSchema({
          required: ["section", "problem", "current_claim", "evidence_url"],
          properties: {
            section: stringSchema({ minLength: 1 }),
            problem: enumString(["dead_link", "missing_citation", "weak_source", "outdated_source", "claim_mismatch"]),
            current_claim: stringSchema({ minLength: 1 }),
            evidence_url: stringSchema({ minLength: 1 })
          }
        })
      },
      proposed_changes: {
        type: "array",
        minItems: 1,
        items: objectSchema({
          required: ["change_type", "target_text", "replacement_text", "source_url"],
          properties: {
            change_type: enumString(["replace_citation", "add_citation", "flag_for_editor_review"]),
            target_text: stringSchema({ minLength: 1 }),
            replacement_text: stringSchema({ minLength: 1 }),
            source_url: stringSchema({ minLength: 1 })
          }
        })
      },
      review_notes: stringSchema({ minLength: 1 })
    }
  })],
  ["schema://jobs/wikipedia-freshness-check-output", objectSchema({
    $id: "schema://jobs/wikipedia-freshness-check-output",
    description: "Freshness and factual drift check for a public Wikipedia article.",
    required: ["page_title", "revision_id", "freshness_findings", "recommended_editor_actions", "risk_level"],
    properties: {
      page_title: stringSchema({ minLength: 1 }),
      revision_id: stringSchema({ minLength: 1 }),
      freshness_findings: {
        type: "array",
        minItems: 1,
        items: objectSchema({
          required: ["claim", "status", "evidence_url", "note"],
          properties: {
            claim: stringSchema({ minLength: 1 }),
            status: enumString(["current", "outdated", "unclear", "needs_editor_review"]),
            evidence_url: stringSchema({ minLength: 1 }),
            note: stringSchema({ minLength: 1 })
          }
        })
      },
      recommended_editor_actions: arrayOfStrings({ minItems: 1 }),
      risk_level: enumString(["low", "medium", "high"])
    }
  })],
  ["schema://jobs/wikipedia-infobox-consistency-output", objectSchema({
    $id: "schema://jobs/wikipedia-infobox-consistency-output",
    description: "Reviewable proposal for reconciling a Wikipedia infobox with cited article evidence.",
    required: ["page_title", "revision_id", "checked_fields", "proposed_changes", "review_notes"],
    properties: {
      page_title: stringSchema({ minLength: 1 }),
      revision_id: stringSchema({ minLength: 1 }),
      checked_fields: {
        type: "array",
        minItems: 1,
        items: objectSchema({
          required: ["field", "current_value", "evidence_url", "status", "note"],
          properties: {
            field: stringSchema({ minLength: 1 }),
            current_value: stringSchema({ minLength: 1 }),
            evidence_url: stringSchema({ minLength: 1 }),
            status: enumString(["consistent", "inconsistent", "missing_source", "needs_editor_review"]),
            note: stringSchema({ minLength: 1 })
          }
        })
      },
      proposed_changes: {
        type: "array",
        minItems: 1,
        items: objectSchema({
          required: ["field", "target_text", "replacement_text", "source_url"],
          properties: {
            field: stringSchema({ minLength: 1 }),
            target_text: stringSchema({ minLength: 1 }),
            replacement_text: stringSchema({ minLength: 1 }),
            source_url: stringSchema({ minLength: 1 })
          }
        })
      },
      review_notes: stringSchema({ minLength: 1 })
    }
  })]
]);

export function getBuiltinJobSchema(schemaRef) {
  const normalized = normalizeBuiltinJobSchemaRef(schemaRef);
  if (!normalized) {
    return undefined;
  }
  if (BUILTIN_JOB_SCHEMAS.has(normalized)) {
    return BUILTIN_JOB_SCHEMAS.get(normalized);
  }
  return undefined;
}

export function getBuiltinJobSchemaByName(name) {
  const normalizedName = String(name ?? "").trim().replace(/\.json$/u, "");
  if (!/^[a-z0-9-]+$/u.test(normalizedName)) {
    return undefined;
  }
  return getBuiltinJobSchema(`schema://jobs/${normalizedName}`);
}

export function getPublicBuiltinJobSchemaByName(name) {
  const schema = getBuiltinJobSchemaByName(name);
  if (!schema) {
    return undefined;
  }
  return toPublicSchemaDocument(schema);
}

export function isBuiltinJobSchemaRef(schemaRef) {
  return Boolean(getBuiltinJobSchema(schemaRef));
}

export function validateStructuredSubmission(schemaRef, submission, { path = "submission" } = {}) {
  const schema = getBuiltinJobSchema(schemaRef);
  if (!schema) {
    throw new ValidationError(
      `Structured submission requires a known built-in schema; unknown schema ref: ${schemaRef}`
    );
  }
  validateAgainstSchema(submission, schema, path);
  return submission;
}

export function listBuiltinJobSchemas({ includeDefinitions = false } = {}) {
  return [...BUILTIN_JOB_SCHEMAS.values()].map((schema) => ({
    $id: schema.$id,
    description: schema.description,
    ...(includeDefinitions ? { schema: cloneSchema(schema) } : {})
  }));
}

function normalizeBuiltinJobSchemaRef(schemaRef) {
  if (typeof schemaRef !== "string") {
    return undefined;
  }
  const trimmed = schemaRef.trim();
  if (BUILTIN_JOB_SCHEMAS.has(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith("schema://jobs/sub-")) {
    const category = trimmed.slice("schema://jobs/sub-".length);
    return `schema://jobs/${category}-output`;
  }
  return undefined;
}

function cloneSchema(schema) {
  return JSON.parse(JSON.stringify(schema));
}

function toPublicSchemaDocument(schema) {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    ...cloneSchema(schema)
  };
}

export function schemaRefToJobSchemaPath(schemaRef) {
  const normalized = normalizeBuiltinJobSchemaRef(schemaRef);
  if (!normalized) {
    return undefined;
  }
  return `/schemas/jobs/${normalized.slice("schema://jobs/".length)}.json`;
}

export function jobSchemaPathToRef(pathname) {
  const raw = String(pathname ?? "").trim().replace(/^\/+/, "");
  if (!raw) {
    return undefined;
  }
  const withoutPrefix = raw.startsWith("schemas/jobs/")
    ? raw.slice("schemas/jobs/".length)
    : raw;
  const normalizedName = withoutPrefix.replace(/\.json$/u, "");
  if (!/^[a-z0-9-]+$/u.test(normalizedName)) {
    return undefined;
  }
  return normalizeBuiltinJobSchemaRef(`schema://jobs/${normalizedName}`);
}

export function validateAgainstSchema(value, schema, path = "value") {
  const expected = schema.type;
  if (expected === "object") {
    if (!isPlainObject(value)) {
      throw new ValidationError(`${path} must be an object`);
    }
    const required = schema.required ?? [];
    for (const key of required) {
      if (!(key in value)) {
        throw new ValidationError(`${path}.${key} is required`);
      }
    }
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (key in value) {
        validateAgainstSchema(value[key], propertySchema, `${path}.${key}`);
      }
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const key of Object.keys(value)) {
        if (!allowed.has(key)) {
          throw new ValidationError(`${path}.${key} is not an allowed field`);
        }
      }
    }
    return;
  }

  if (expected === "array") {
    if (!Array.isArray(value)) {
      throw new ValidationError(`${path} must be an array`);
    }
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) {
      throw new ValidationError(`${path} must contain at least ${schema.minItems} item(s)`);
    }
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      throw new ValidationError(`${path} must contain at most ${schema.maxItems} item(s)`);
    }
    value.forEach((entry, index) => {
      validateAgainstSchema(entry, schema.items ?? {}, `${path}[${index}]`);
    });
    return;
  }

  if (expected === "string") {
    if (typeof value !== "string") {
      throw new ValidationError(`${path} must be a string`);
    }
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      throw new ValidationError(`${path} must be at least ${schema.minLength} character(s)`);
    }
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
      throw new ValidationError(`${path} must be at most ${schema.maxLength} character(s)`);
    }
    if (schema.pattern && !(new RegExp(schema.pattern, "u")).test(value)) {
      throw new ValidationError(`${path} does not match the expected format`);
    }
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
      throw new ValidationError(`${path} must be one of ${schema.enum.join(", ")}`);
    }
    return;
  }

  if (expected === "number") {
    if (!Number.isFinite(value)) {
      throw new ValidationError(`${path} must be a number`);
    }
    if (Number.isFinite(schema.minimum) && value < schema.minimum) {
      throw new ValidationError(`${path} must be at least ${schema.minimum}`);
    }
    return;
  }

  if (expected === "integer") {
    if (!Number.isInteger(value)) {
      throw new ValidationError(`${path} must be an integer`);
    }
    if (Number.isFinite(schema.minimum) && value < schema.minimum) {
      throw new ValidationError(`${path} must be at least ${schema.minimum}`);
    }
    return;
  }

  if (expected === "boolean") {
    if (typeof value !== "boolean") {
      throw new ValidationError(`${path} must be a boolean`);
    }
    return;
  }
}

function stringSchema(options = {}) {
  return {
    type: "string",
    ...options
  };
}

function integerSchema(options = {}) {
  return {
    type: "integer",
    ...options
  };
}

function booleanSchema() {
  return {
    type: "boolean"
  };
}

function enumString(values) {
  return {
    type: "string",
    enum: values
  };
}

function arrayOfStrings(options = {}) {
  return {
    type: "array",
    items: { type: "string", minLength: 1 },
    ...options
  };
}

function objectSchema({ properties = {}, required = [], additionalProperties = false, ...rest }) {
  return {
    type: "object",
    properties,
    required,
    additionalProperties,
    ...rest
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
