import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { legalRevisionDate } from "../../marketing/src/lib/legal-revision-date.mjs";

test("legal date follows the publishing merge in UTC and survives later builds", (t) => {
  const root = mkdtempSync(join(tmpdir(), "legal-date-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let date = "2030-01-01T12:00:00Z";
  const git = (...args) => execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8", env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date,
      GIT_AUTHOR_NAME: "Legal test", GIT_COMMITTER_NAME: "Legal test",
      GIT_AUTHOR_EMAIL: "test@example.invalid", GIT_COMMITTER_EMAIL: "test@example.invalid" }
  }).trim();
  git("init", "-b", "main");
  mkdirSync(join(root, "marketing/src/pages"), { recursive: true });
  writeFileSync(join(root, "marketing/src/pages/privacy.astro"), "old privacy");
  git("add", "."); git("commit", "-m", "initial", "--no-gpg-sign");
  git("checkout", "-b", "terms");
  date = "2030-02-01T12:00:00Z";
  writeFileSync(join(root, "marketing/src/pages/terms.astro"), "approved text");
  git("add", "."); git("commit", "-m", "terms text", "--no-gpg-sign");
  git("checkout", "main");
  date = "2030-03-04T23:30:00-02:00";
  git("merge", "--no-ff", "terms", "-m", "publish terms", "--no-gpg-sign");
  assert.equal(legalRevisionDate({ root, env: {} }), "2030-03-05");
  date = "2030-06-01T12:00:00Z";
  writeFileSync(join(root, "unrelated.txt"), "later deploy");
  git("add", "."); git("commit", "-m", "unrelated", "--no-gpg-sign");
  assert.equal(legalRevisionDate({ root, env: {} }), "2030-03-05");
  // Squash is the production merge strategy; its commit date is the date shown.
  writeFileSync(join(root, "marketing/src/pages/terms.astro"), "revised text");
  git("add", "."); git("commit", "-m", "terms squash", "--no-gpg-sign");
  assert.equal(legalRevisionDate({ root, env: {} }), "2030-06-01");
  // A shallow boundary can masquerade as the last legal edit; fail instead.
  writeFileSync(join(root, ".git/shallow"), git("rev-parse", "HEAD") + "\n");
  assert.throws(() => legalRevisionDate({ root, env: {} }), /full Git history/);
});

test("legal date supports validated host metadata for a Git-free Docker build", () => {
  assert.equal(legalRevisionDate({ root: "/nonexistent", env: { VERIFY_LEGAL_REVISION_DATE: "2032-02-29" } }), "2032-02-29");
  for (const invalid of ["2031-02-29", "yesterday", "2032-2-29", "2032-02-29T00:00:00Z"]) {
    assert.throws(() => legalRevisionDate({ env: { VERIFY_LEGAL_REVISION_DATE: invalid } }));
  }
  const deploy = readFileSync(new URL("./deploy-production.sh", import.meta.url), "utf8");
  assert.match(deploy, /legal_revision_date=\$\(TZ=UTC git[^]*?--first-parent[^]*?marketing\/src\/pages\/terms\.astro marketing\/src\/pages\/privacy\.astro\)/u);
  assert.match(deploy, /-e VERIFY_LEGAL_REVISION_DATE="\$legal_revision_date"/u);
  const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(ci.slice(ci.indexOf("  public-site:"), ci.indexOf("  indexer:")), /fetch-depth: 0/u);
});
