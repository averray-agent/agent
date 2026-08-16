import assert from "node:assert/strict";
import test from "node:test";

import { evaluateCandidatePolicy } from "../src/candidate-patch.mjs";

test("candidate path, protected path, file-count, and symlink policy are named", () => {
  const contract = {
    candidate: {
      allowed_paths: ["src/**", "package.json"],
      protected_paths: ["package.json"],
      maximum_changed_files: 2
    }
  };
  const patch = {
    changedPaths: ["src/value.js", "package.json", "outside.txt"],
    files: [
      { path: "src/value.js", mode: "symlink" },
      { path: "package.json", mode: null },
      { path: "outside.txt", mode: null }
    ]
  };
  assert.deepEqual(
    evaluateCandidatePolicy(contract, patch).map((entry) => entry.detection),
    [
      "maximum_changed_files_exceeded",
      "protected_path_modified",
      "path_not_allowed",
      "symlink_added"
    ]
  );
});
