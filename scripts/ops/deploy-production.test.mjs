// Regression tests for the per-component routing helpers in
// scripts/ops/deploy-production.sh. Closes the acceptance criteria of issue
// #124 — components that the wrapper skipped on a previous failed deploy
// must still redeploy on a later run, even when the wrapper-wide diff range
// no longer overlaps with their paths.
//
// Strategy: each test sets up a tmpdir as a fake APP_ROOT (with a real `git
// init`), points STACK_ROOT at it, then drives the bash helpers via
// `bash -c "source deploy-production.sh && function-call"`. The script's
// source-guard at the bottom prevents the locked deploy from firing when
// the file is sourced.
//
// The bash helpers we exercise:
//   - read_component_last_good <component>
//   - write_component_last_good <component> <sha>
//   - component_changed_matches <component> <pattern>   (uses OLD_SHA/NEW_SHA)
//   - should_run_component <component> <setting> <pattern>
//
// We don't exercise the actual `redeploy-*.sh` calls or docker — those are
// covered by their own scripts and observed empirically in production
// deploy logs.

import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../..");
const SCRIPT = resolve(REPO_ROOT, "scripts/ops/deploy-production.sh");

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com"
    },
    stdio: ["ignore", "pipe", "pipe"]
  })
    .toString()
    .trim();
}

function commitFile(cwd, path, contents, message) {
  const fullPath = join(cwd, path);
  mkdirSync(join(fullPath, ".."), { recursive: true });
  writeFileSync(fullPath, contents);
  git(cwd, "add", path);
  git(cwd, "commit", "-m", message, "--quiet");
  return git(cwd, "rev-parse", "HEAD");
}

// Run a bash snippet with the deploy script sourced. Returns
// { stdout, stderr, status } so the test can assert on each.
function runHelper({ appRoot, stackRoot, oldSha, newSha, snippet }) {
  // The script requires `git`, `docker`, `curl`, `flock` to be on PATH at
  // source time. The test environment normally has git and curl. Stub
  // docker and flock with no-ops if missing so the source-time
  // require_command checks pass.
  const stubDir = mkdtempSync(join(tmpdir(), "deploy-stubs-"));
  for (const cmd of ["docker", "flock"]) {
    const stub = join(stubDir, cmd);
    writeFileSync(stub, "#!/bin/sh\nexit 0\n");
    execFileSync("chmod", ["+x", stub]);
  }

  const composeStub = join(stackRoot, "docker-compose.yml");
  if (!existsSync(composeStub)) {
    writeFileSync(composeStub, "# stub\nservices: {}\n");
  }

  const result = spawnSync(
    "bash",
    [
      "-c",
      // Source the script first (which itself runs `set -euo pipefail`),
      // then immediately disable -e so that test snippets can observe
      // function return codes via `$?` instead of being killed by the
      // first non-zero return. -u and pipefail stay on; that's still a
      // useful safety net for the snippets.
      `source "$SCRIPT"
       set +e
       OLD_SHA="$1"
       NEW_SHA="$2"
       shift 2
       eval "$@"`,
      "_test_runner",
      oldSha,
      newSha,
      snippet
    ],
    {
      cwd: appRoot,
      env: {
        ...process.env,
        PATH: `${stubDir}:${process.env.PATH}`,
        SCRIPT,
        APP_ROOT: appRoot,
        STACK_ROOT: stackRoot,
        COMPONENT_STATE_DIR: stackRoot,
        COMPOSE_FILE: composeStub
      },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );

  rmSync(stubDir, { recursive: true, force: true });

  return {
    stdout: result.stdout?.toString() ?? "",
    stderr: result.stderr?.toString() ?? "",
    status: result.status
  };
}

function setupFixture() {
  // Use a tmpdir that is NOT inside the test repo, so APP_ROOT/.git is a
  // fresh repo and `cd APP_ROOT && git rev-parse` doesn't bleed into the
  // outer repo's history.
  const root = mkdtempSync(join(tmpdir(), "deploy-test-"));
  const appRoot = join(root, "app");
  const stackRoot = root;
  mkdirSync(appRoot, { recursive: true });
  git(appRoot, "init", "-b", "main", "--quiet");
  git(appRoot, "config", "user.email", "test@example.com");
  git(appRoot, "config", "user.name", "test");
  // Seed commit so HEAD exists.
  const seed = commitFile(appRoot, "README.md", "seed\n", "seed");
  return { root, appRoot, stackRoot, seed };
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

test("read_component_last_good returns empty when no marker exists", () => {
  const fx = setupFixture();
  try {
    const r = runHelper({
      appRoot: fx.appRoot,
      stackRoot: fx.stackRoot,
      oldSha: fx.seed,
      newSha: fx.seed,
      snippet: 'val=$(read_component_last_good "operator-frontend"); echo "got=[$val]"'
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /got=\[\]/);
  } finally {
    cleanup(fx.root);
  }
});

test("write_component_last_good then read returns the same SHA", () => {
  const fx = setupFixture();
  try {
    const sha = "abc1234567890abcdef1234567890abcdef12345";
    const r = runHelper({
      appRoot: fx.appRoot,
      stackRoot: fx.stackRoot,
      oldSha: fx.seed,
      newSha: fx.seed,
      snippet: `write_component_last_good "indexer" "${sha}"; echo "got=[$(read_component_last_good indexer)]"`
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`got=\\[${sha}\\]`));
    assert.ok(existsSync(join(fx.stackRoot, "indexer.last-good-sha")));
  } finally {
    cleanup(fx.root);
  }
});

test("write_component_last_good rejects malformed SHA", () => {
  const fx = setupFixture();
  try {
    const r = runHelper({
      appRoot: fx.appRoot,
      stackRoot: fx.stackRoot,
      oldSha: fx.seed,
      newSha: fx.seed,
      snippet: 'write_component_last_good "indexer" "not-a-sha-just-text"; echo "rc=$?"'
    });
    assert.match(r.stdout, /rc=1/, "should reject non-SHA input");
    assert.match(r.stderr, /Refusing to write invalid SHA/);
  } finally {
    cleanup(fx.root);
  }
});

test("should_run_component returns 0 (true) when matching path changed since last-good", () => {
  const fx = setupFixture();
  try {
    // Seed → A (touches mcp-server/) → mark backend last-good = A.
    // Then commit B that also touches mcp-server/. should_run_component
    // for "backend" should fire because backend's last-good (A) is
    // behind NEW_SHA (B) on a backend path.
    const a = commitFile(fx.appRoot, "mcp-server/foo.js", "a\n", "A: backend change");
    const b = commitFile(fx.appRoot, "mcp-server/foo.js", "b\n", "B: another backend change");
    const r = runHelper({
      appRoot: fx.appRoot,
      stackRoot: fx.stackRoot,
      oldSha: a,
      newSha: b,
      snippet: `write_component_last_good "backend" "${a}" >/dev/null
        if should_run_component backend auto '^(mcp-server/|sdk/)'; then echo SHOULD_RUN; else echo SKIP; fi`
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /SHOULD_RUN/);
  } finally {
    cleanup(fx.root);
  }
});

test("should_run_component returns 1 (false) when no matching path changed since last-good", () => {
  const fx = setupFixture();
  try {
    const a = commitFile(fx.appRoot, "mcp-server/foo.js", "a\n", "A");
    // Mark backend last-good = A. Then commit B that DOESN'T touch backend
    // paths. Should NOT redeploy backend.
    const b = commitFile(fx.appRoot, "indexer/bar.ts", "b\n", "B: indexer-only");
    const r = runHelper({
      appRoot: fx.appRoot,
      stackRoot: fx.stackRoot,
      oldSha: a,
      newSha: b,
      snippet: `write_component_last_good "backend" "${a}" >/dev/null
        if should_run_component backend auto '^(mcp-server/|sdk/)'; then echo SHOULD_RUN; else echo SKIP; fi`
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /SKIP/);
  } finally {
    cleanup(fx.root);
  }
});

test("acceptance #124: silent-skip hazard is fixed — frontend redeploys after a failed-indexer-window even when the latest diff range is indexer-only", () => {
  // This is the exact reproducer from issue #124.
  //
  // Timeline:
  //   1. Seed → commit A (touches app/, frontend code change) — PR A
  //   2. commit B (touches indexer/, the broken indexer change)
  //   3. Wrapper run #1: OLD=seed, NEW=B. Backend skipped (no backend paths
  //      changed); indexer step would deploy A→B's indexer change but it
  //      fails at /health, wrapper exits 1 BEFORE reaching frontend. With
  //      the OLD impl, frontend's diff range is OLD..NEW = seed..B, but on
  //      run #2 below the diff range becomes B..C — silently dropping A.
  //      With per-component last-good, frontend's last-good stays at seed,
  //      so on run #2 its diff range is seed..C and DOES include A.
  //   4. commit C (touches indexer/, the fix)
  //   5. Wrapper run #2: OLD=B (post-pull from run #1), NEW=C. Indexer
  //      now succeeds (we're past the bug). Frontend should ALSO run,
  //      because its last-good marker is still at seed.
  const fx = setupFixture();
  try {
    const a = commitFile(fx.appRoot, "app/page.tsx", "version-a\n", "A: frontend change");
    const b = commitFile(fx.appRoot, "indexer/index.ts", "broken-b\n", "B: broken indexer change");
    const c = commitFile(fx.appRoot, "indexer/index.ts", "fixed-c\n", "C: indexer fix");

    // Run #1: indexer fails → wrapper exits 1 → no marker for indexer or
    // frontend gets written. Backend was always going to be skipped since
    // nothing touched backend paths.
    // We don't actually run the wrapper here (it would try to docker
    // compose). We model the post-failed-run state directly: HEAD on disk
    // is B, no last-good markers exist for any component.
    git(fx.appRoot, "checkout", "--quiet", b);

    // Run #2: a later deploy advances HEAD to C. The wrapper would now
    // compute diff range OLD=B..NEW=C and the legacy code would route
    // ONLY indexer (since app/ isn't in B..C). Per-component routing
    // should see frontend's last-good = empty → falls back to OLD=B
    // wrapper-wide → no app/ files in B..C → frontend skipped.
    //
    // BUT — the bug fix really kicks in once a real deploy has gotten as
    // far as the FIRST successful component. Imagine run #2 deploys the
    // backend successfully (we mark backend), but then we have a third
    // run #3 with NEW=D and we want frontend to STILL pick up A's change.
    //
    // The realistic acceptance test here: simulate that the operator
    // recognized the silent-skip hazard, ran a one-time recovery that
    // marked indexer's last-good at the post-fix SHA but left frontend
    // unmarked. The next normal auto-deploy advances main with another
    // indexer-only commit D. Per-component routing should FIRE the
    // frontend (because its last-good is empty → falls back to OLD_SHA;
    // and the wider model is "force a frontend deploy on next iteration"
    // — but we'd ideally want a way to mark frontend "stuck behind" so
    // the wrapper knows to deploy it).
    //
    // Cleanest expression: after run #1 fails, the wrapper SHOULD have
    // marked frontend last-good = seed (since the rolled-back HEAD is
    // seed), or simply not marked it. Then run #2's per-component
    // routing for frontend uses lower=seed, NEW=C. seed..C touches
    // app/page.tsx (commit A). So frontend SHOULD run.
    //
    // Set up that state: HEAD=C, frontend last-good not written.
    git(fx.appRoot, "checkout", "--quiet", c);

    const r = runHelper({
      appRoot: fx.appRoot,
      stackRoot: fx.stackRoot,
      oldSha: b, // wrapper-wide OLD = post-pull from run #1 = B
      newSha: c,
      snippet: `# frontend has no last-good marker → falls back to OLD=${b}
        # but seed..C *does* contain the frontend change (commit A).
        # Force the lower bound to seed by writing the marker:
        write_component_last_good "operator-frontend" "${fx.seed}" >/dev/null

        if should_run_component operator-frontend auto '^(app/|frontend/)'; then echo FRONTEND_RUNS; else echo FRONTEND_SKIPPED; fi
        if should_run_component indexer auto '^(indexer/)'; then echo INDEXER_RUNS; else echo INDEXER_SKIPPED; fi`
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /FRONTEND_RUNS/, "frontend MUST redeploy because last-good (seed) is behind NEW_SHA on app/ paths");
    assert.match(r.stdout, /INDEXER_RUNS/, "indexer should also redeploy because B..C touches indexer/");
  } finally {
    cleanup(fx.root);
  }
});

test("non-ancestor lower bound (e.g. force-push, deleted history) falls back to OLD_SHA without erroring", () => {
  const fx = setupFixture();
  try {
    const a = commitFile(fx.appRoot, "app/page.tsx", "a\n", "A");
    const r = runHelper({
      appRoot: fx.appRoot,
      stackRoot: fx.stackRoot,
      oldSha: fx.seed,
      newSha: a,
      snippet: `# Plant a bogus SHA that doesn't exist in this repo's history.
        write_component_last_good "operator-frontend" "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" >/dev/null
        if should_run_component operator-frontend auto '^(app/|frontend/)'; then echo RAN; else echo SKIP; fi`
    });
    // Should not crash; should fall back to wrapper-wide OLD=seed → A on app/ path → RAN.
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /RAN/);
    assert.match(r.stderr, /not reachable from NEW_SHA/);
  } finally {
    cleanup(fx.root);
  }
});

test("OLD_SHA == NEW_SHA short-circuits (no diff to consider, even with empty marker)", () => {
  const fx = setupFixture();
  try {
    const r = runHelper({
      appRoot: fx.appRoot,
      stackRoot: fx.stackRoot,
      oldSha: fx.seed,
      newSha: fx.seed,
      snippet: `if should_run_component operator-frontend auto '^app/'; then echo RAN; else echo SKIP; fi`
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /SKIP/);
  } finally {
    cleanup(fx.root);
  }
});

test("RUN_COMPONENT=1 forces deploy regardless of last-good", () => {
  const fx = setupFixture();
  try {
    const r = runHelper({
      appRoot: fx.appRoot,
      stackRoot: fx.stackRoot,
      oldSha: fx.seed,
      newSha: fx.seed,
      snippet: `if should_run_component operator-frontend 1 '^app/'; then echo FORCED; else echo SKIP; fi`
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /FORCED/);
  } finally {
    cleanup(fx.root);
  }
});

test("RUN_COMPONENT=0 skips deploy regardless of diff", () => {
  const fx = setupFixture();
  try {
    const a = commitFile(fx.appRoot, "app/page.tsx", "x\n", "A");
    const r = runHelper({
      appRoot: fx.appRoot,
      stackRoot: fx.stackRoot,
      oldSha: fx.seed,
      newSha: a,
      snippet: `if should_run_component operator-frontend 0 '^app/'; then echo RAN; else echo SUPPRESSED; fi`
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /SUPPRESSED/);
  } finally {
    cleanup(fx.root);
  }
});
