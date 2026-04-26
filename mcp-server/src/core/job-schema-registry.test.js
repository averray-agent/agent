import test from "node:test";
import assert from "node:assert/strict";

import { ValidationError } from "./errors.js";
import {
  getBuiltinJobSchema,
  getBuiltinJobSchemaByName,
  getPublicBuiltinJobSchemaByName,
  listBuiltinJobSchemas,
  schemaRefToJobSchemaPath,
  validateStructuredSubmission
} from "./job-schema-registry.js";

test("getBuiltinJobSchema resolves built-in first-wave schemas", () => {
  const schema = getBuiltinJobSchema("schema://jobs/pr-review-findings-output");
  assert.equal(schema?.$id, "schema://jobs/pr-review-findings-output");
});

test("validateStructuredSubmission accepts a schema-compliant PR review payload", () => {
  const payload = {
    summary: "Found two issues in the auth flow.",
    findings: [
      {
        severity: "high",
        file: "frontend/auth.js",
        issue: "Reauth loop can hide expired token state.",
        recommendation: "Surface token expiry and short-circuit reauth once."
      }
    ],
    risk_level: "high",
    files_touched: ["frontend/auth.js"],
    recommended_next_step: "request_changes"
  };

  assert.doesNotThrow(() => {
    validateStructuredSubmission("schema://jobs/pr-review-findings-output", payload);
  });
});

test("validateStructuredSubmission accepts GitHub PR evidence payload", () => {
  const payload = {
    prUrl: "https://github.com/example/project/pull/77",
    summary: "Added parser validation regression coverage.",
    tests: "npm test passed",
    issueNumber: 42,
    referencesIssue: true,
    checksPassing: true,
    ciStatus: "passing"
  };

  assert.doesNotThrow(() => {
    validateStructuredSubmission("schema://jobs/github-pr-evidence-output", payload);
  });
});

test("validateStructuredSubmission accepts Wikipedia citation repair payload", () => {
  const payload = {
    page_title: "Example",
    revision_id: "123456789",
    citation_findings: [
      {
        section: "History",
        problem: "dead_link",
        current_claim: "The cited source no longer resolves.",
        evidence_url: "https://web.archive.org/example"
      }
    ],
    proposed_changes: [
      {
        change_type: "replace_citation",
        target_text: "<ref>dead source</ref>",
        replacement_text: "<ref>archived reliable source</ref>",
        source_url: "https://web.archive.org/example"
      }
    ],
    review_notes: "Suggestion-only output for human editor review."
  };

  assert.doesNotThrow(() => {
    validateStructuredSubmission("schema://jobs/wikipedia-citation-repair-output", payload);
  });
});

test("validateStructuredSubmission accepts dependency remediation evidence", () => {
  const payload = {
    prUrl: "https://github.com/example/app/pull/12",
    packageName: "minimist",
    vulnerableVersion: "0.0.8",
    fixedVersion: "1.2.3",
    advisoryIds: ["GHSA-vh95-rmgr-6w4m", "CVE-2020-7598"],
    summary: "Updated minimist and regenerated the npm lockfile.",
    tests: "npm test passed",
    manifestPath: "package.json",
    lockfilesUpdated: ["package-lock.json"],
    checksPassing: true,
    ciStatus: "passing"
  };

  assert.doesNotThrow(() => {
    validateStructuredSubmission("schema://jobs/dependency-remediation-output", payload);
  });
});

test("validateStructuredSubmission accepts open-data audit evidence", () => {
  const payload = {
    dataset_title: "Federal sample spending data",
    dataset_url: "https://catalog.data.gov/dataset/federal-sample-spending-data",
    resource_url: "https://example.gov/spending.csv",
    resource_format: "CSV",
    checks: [
      {
        name: "resource_reachability",
        status: "pass",
        evidence: "HTTP 200 with text/csv content type."
      }
    ],
    findings: [
      {
        severity: "low",
        issue: "Metadata modified date is present but resource last_modified is five years old.",
        evidence: "resource last_modified=2021-01-01",
        recommendation: "Ask the publisher to confirm whether the resource is still refreshed."
      }
    ],
    no_issue_found: false,
    summary: "Resource is reachable; metadata freshness needs review.",
    recommended_actions: ["Confirm refresh cadence", "Document column names in resource metadata"]
  };

  assert.doesNotThrow(() => {
    validateStructuredSubmission("schema://jobs/open-data-quality-audit-output", payload);
  });
});

test("validateStructuredSubmission rejects missing required fields", () => {
  assert.throws(
    () => validateStructuredSubmission("schema://jobs/pr-review-findings-output", {
      summary: "Looks good"
    }),
    (error) => error instanceof ValidationError && /findings is required/.test(error.message)
  );
});

test("validateStructuredSubmission rejects unknown schemas for structured payloads", () => {
  assert.throws(
    () => validateStructuredSubmission("schema://jobs/custom-output", { ok: true }),
    (error) => error instanceof ValidationError && /known built-in schema/.test(error.message)
  );
});

test("getBuiltinJobSchemaByName resolves a schema from its public name", () => {
  const schema = getBuiltinJobSchemaByName("release-input.json");
  assert.equal(schema?.$id, "schema://jobs/release-input");
});

test("getPublicBuiltinJobSchemaByName returns a JSON-schema-shaped document", () => {
  const schema = getPublicBuiltinJobSchemaByName("release-input");
  assert.equal(schema?.$schema, "http://json-schema.org/draft-07/schema#");
  assert.equal(schema?.$id, "schema://jobs/release-input");
});

test("listBuiltinJobSchemas can expose canonical paths for discovery consumers", () => {
  const schemas = listBuiltinJobSchemas();
  const release = schemas.find((entry) => entry.$id === "schema://jobs/release-input");
  assert.equal(schemaRefToJobSchemaPath(release?.$id), "/schemas/jobs/release-input.json");
});
