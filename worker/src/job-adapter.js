const DEFAULT_BUDGETS = Object.freeze({
  elapsed: "PT30M",
  model_tokens: 2_000_000,
  tool_calls: 400,
  max_children: 1,
  max_concurrent_children: 1,
});

function text(value) {
  return value == null ? "" : String(value).trim();
}

function stringList(value) {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function optionPaths(value, name) {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be an array`);
  }
  return value.map(text).filter(Boolean);
}

// The kernel captures `no_new_failures` baselines only for pytest: it injects
// `--junitxml` and parses JUnit failure identities, and its contract compiler
// rejects any other baseline_command (`invalid_baseline_command`). Mirror that
// predicate (harness verification/checks.py `pytest_arguments`); for every
// other verify command the command check remains the deterministic gate and no
// baseline check is emitted — emitting one fails contract compilation.
export function supportsBaselineComparison(command) {
  const args = String(command).split(/\s+/).filter(Boolean);
  if (args.length === 0) {
    return false;
  }
  if (args.some((arg) => arg.startsWith("--junitxml"))) {
    return false;
  }
  const executable = args[0].split("/").pop();
  if (executable === "pytest" || executable.startsWith("pytest-")) {
    return true;
  }
  return (
    (executable === "python" || executable === "python3" || executable.startsWith("python3.")) &&
    args[1] === "-m" &&
    args[2] === "pytest"
  );
}

export function slugifyJobId(value) {
  const slug = text(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120)
    .replace(/-+$/g, "");
  return slug || "job";
}

function objectiveFor(job) {
  const source = job.source && typeof job.source === "object" ? job.source : {};
  const title = text(job.title) || `Averray job ${text(job.id) || "work item"}`;
  const description = text(job.description);
  const sourceBody = text(source.body);
  const instructions = stringList(job.agentInstructions);
  const criteria = stringList(job.acceptanceCriteria);
  const sections = [`Title: ${title}`];

  if (description) {
    sections.push(`Description:\n${description}`);
  }
  if (sourceBody && sourceBody !== description) {
    sections.push(`Source issue body:\n${sourceBody}`);
  }
  if (instructions.length > 0) {
    sections.push(`Agent instructions:\n${instructions.map((item) => `- ${item}`).join("\n")}`);
  }
  if (criteria.length > 0) {
    sections.push(`Acceptance criteria:\n${criteria.map((item) => `- ${item}`).join("\n")}`);
  }

  sections.push(
    "Execution boundaries:\n" +
      "- The sandbox has no network access.\n" +
      "- Work only in the already-prepared local checkout.\n" +
      "- Do not open a PR, fetch URLs, or submit work. A separate approved step publishes the patch.",
  );
  return sections.join("\n\n");
}

export function mapJobToTaskIntent(job, options = {}) {
  if (!job || typeof job !== "object" || Array.isArray(job)) {
    throw new TypeError("job must be an object");
  }

  const workspacePath = text(options.workspacePath);
  if (!workspacePath) {
    throw new TypeError("options.workspacePath is required");
  }

  const source = job.source && typeof job.source === "object" ? job.source : {};
  const suggestedCheck =
    job.verification && typeof job.verification === "object"
      ? job.verification.suggestedCheck
      : undefined;
  const verifyCommand = text(options.verifyCommand ?? suggestedCheck);
  const acceptance = [];
  const warnings = [];

  if (verifyCommand) {
    const commandCheck = {
      id: "job-checks",
      type: "command",
      command: verifyCommand,
      required: true,
    };
    const workingDirectory = text(options.workingDirectory);
    if (workingDirectory) {
      commandCheck.working_directory = workingDirectory;
    }
    acceptance.push(commandCheck);
    if (supportsBaselineComparison(verifyCommand)) {
      acceptance.push({
        id: "no-regressions",
        type: "baseline_comparison",
        rule: "no_new_failures",
        baseline_command: verifyCommand,
        required: true,
      });
    }
  } else {
    warnings.push(
      "No deterministic verify command was provided; acceptance is empty and this job is not eligible for automated submission.",
    );
  }

  const intent = {
    apiVersion: "harness/v1alpha1",
    kind: "TaskIntent",
    metadata: {
      id: slugifyJobId(job.id),
      labels: {
        averray_job_id: text(job.id),
        source_type: text(source.type),
        repo: text(source.repo),
        issue_number: text(source.issueNumber),
      },
    },
    spec: {
      profile: text(options.profile) || "averray-worker",
      objective: objectiveFor(job),
      deliverables: [
        { type: "workspace_patch" },
        { type: "verification_report" },
        { type: "change_summary" },
      ],
      context: {
        workspace: {
          path: workspacePath,
          revision: text(options.revision) || "HEAD",
        },
      },
      constraints: {
        allowed_paths: optionPaths(options.allowedPaths, "options.allowedPaths"),
        forbidden_paths: optionPaths(options.forbiddenPaths, "options.forbiddenPaths"),
        network: "deny",
      },
      acceptance,
      approvals: [],
      budgets: {
        ...DEFAULT_BUDGETS,
        ...(options.budgets ?? {}),
      },
      learning: {
        episode_capture: true,
        memory_write: "none",
        skill_generation: "ineligible",
      },
    },
  };

  return { intent, warnings };
}

export function serializeIntent(intent) {
  return `${JSON.stringify(intent, null, 2)}\n`;
}
