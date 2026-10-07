import assert from "node:assert/strict";
import test from "node:test";
import { profileReadFailure } from "./profile-read-state.js";

test("only the named agent_not_found 404 means unlisted, never a fetch failure", () => {
  assert.equal(profileReadFailure(undefined), null);
  assert.equal(profileReadFailure({ status: 404, body: { error: "agent_not_found" } }).kind, "unlisted");
  for (const error of [new Error("offline"), { status: 503, body: { error: "agent_not_found" } }, { status: 404, body: {} }]) {
    assert.equal(profileReadFailure(error).kind, "unavailable");
  }
});
