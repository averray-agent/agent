const CI_STATUSES = new Set(["unknown", "pending", "passing", "failing"]);

function text(value) {
  return value == null ? "" : String(value).trim();
}

export function filesChangedFromPatch(patchText) {
  const files = [];
  const seen = new Set();
  const add = (file) => {
    if (file && !seen.has(file)) {
      seen.add(file);
      files.push(file);
    }
  };
  // Parse unified-diff file headers. The local provider emits git-format patches
  // (`--- a/X` / `+++ b/X`); the docker provider emits plain difflib patches with
  // the same `a/`…`b/` headers but no `diff --git` line (its sandbox image is not
  // required to contain git). Reading both the a/ and b/ headers (deduped) covers
  // modifications, additions (`--- /dev/null`), and deletions (`+++ /dev/null`).
  for (const line of text(patchText).split(/\r?\n/)) {
    const match = /^--- a\/(.+)$/.exec(line) ?? /^\+\+\+ b\/(.+)$/.exec(line);
    if (match) {
      add(match[1].replace(/\t.*$/, "").trim());
    }
  }
  return files;
}

function passedChecksDescription(report) {
  const passed = Array.isArray(report.check_results)
    ? report.check_results.filter((item) => item && item.passed === true)
    : [];
  if (passed.length === 0) {
    return "Harness verification passed; no deterministic checks were reported.";
  }
  const details = passed.map((item) => {
    const id = text(item.id) || "unnamed-check";
    const type = text(item.type);
    const reason = text(item.reason);
    return `${id}${type ? ` (${type})` : ""}: passed${reason ? ` — ${reason}` : ""}`;
  });
  return `Harness deterministic checks passed: ${details.join("; ")}`;
}

export function assembleGithubPrSubmission({
  job,
  prUrl,
  verificationReport,
  changeSummary,
  patchText,
  notes,
  ciStatus,
}) {
  const normalizedPrUrl = text(prUrl);
  if (!normalizedPrUrl) {
    throw new TypeError("prUrl is required");
  }
  if (!verificationReport || verificationReport.passed !== true) {
    throw new Error("Cannot assemble a submission for work that did not pass verification");
  }
  if (ciStatus != null && !CI_STATUSES.has(ciStatus)) {
    throw new TypeError(`Invalid ciStatus: ${ciStatus}`);
  }

  const source = job?.source && typeof job.source === "object" ? job.source : {};
  const repo = text(source.repo) || "repository";
  const issueNumber = Number.isInteger(source.issueNumber) && source.issueNumber >= 1
    ? source.issueNumber
    : undefined;
  const issueUrl = text(source.issueUrl);
  const summary = text(changeSummary) || `Resolve ${repo} issue #${issueNumber ?? "unknown"}`;
  const submission = {
    prUrl: normalizedPrUrl,
    summary,
    tests: passedChecksDescription(verificationReport),
    filesChanged: filesChangedFromPatch(patchText),
    referencesIssue: Boolean(issueNumber || issueUrl),
  };

  if (issueNumber !== undefined) {
    submission.issueNumber = issueNumber;
  }
  if (issueUrl) {
    submission.issueUrl = issueUrl;
  }
  const normalizedNotes = text(notes);
  if (normalizedNotes) {
    submission.notes = normalizedNotes;
  }
  if (ciStatus != null) {
    submission.ciStatus = ciStatus;
    if (ciStatus === "passing") {
      submission.checksPassing = true;
    }
  }

  return submission;
}
