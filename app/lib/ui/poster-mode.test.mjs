import assert from "node:assert/strict";
import test from "node:test";

import { posterModeCopy } from "./poster-mode.js";

test("open poster mode never renders allowlist enrollment copy", () => {
  const copy = posterModeCopy({
    mode: "open",
    allowlistEnrollment: "Posting requires operator enrollment."
  });

  assert.equal(copy.statement, "Posting is open.");
  assert.doesNotMatch(`${copy.statement} ${copy.detail}`, /enroll|allowlist/iu);
});

test("allowlist poster mode renders the live enrollment sentence", () => {
  const copy = posterModeCopy({
    mode: "allowlist",
    allowlistEnrollment: "Live enrollment is required."
  });

  assert.equal(copy.statement, "Live enrollment is required.");
  assert.match(copy.detail, /Non-enrolled drafts are refused/iu);
});

test("closed or unknown poster modes never borrow allowlist copy", () => {
  assert.equal(posterModeCopy({ mode: "closed" }).statement, "External posting is currently closed.");
  assert.equal(posterModeCopy({}).statement, "The live posting mode is unavailable.");
});
