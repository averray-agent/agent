import assert from "node:assert/strict";
import test from "node:test";
import {
  buildShareHref,
  labelForShareSurface,
  SHARE_SURFACES
} from "./read-only-share.js";

test("buildShareHref turns a returned appPath into an absolute browser URL", () => {
  assert.equal(
    buildShareHref("/share?token=token.payload", "https://app.averray.com/"),
    "https://app.averray.com/share?token=token.payload"
  );
});

test("buildShareHref rejects non-share paths", () => {
  assert.equal(buildShareHref("/overview", "https://app.averray.com"), null);
  assert.equal(buildShareHref("https://evil.example/share/token", "https://app.averray.com"), null);
});

test("labelForShareSurface names the C2 shareable surfaces", () => {
  assert.equal(labelForShareSurface(SHARE_SURFACES.agent), "Agent profile");
  assert.equal(labelForShareSurface(SHARE_SURFACES.session), "Session audit trail");
  assert.equal(labelForShareSurface(SHARE_SURFACES.dispute), "Dispute snapshot");
  assert.equal(labelForShareSurface(SHARE_SURFACES.policy), "Policy snapshot");
});
