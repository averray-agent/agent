import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { controlLockedReason } from "./capability-copy.js";

test("capability refusals use human session copy instead of policy identifiers", () => {
  assert.equal(controlLockedReason("admin.capabilities.view"), "Grant feed locked for this session.");
  assert.equal(controlLockedReason("admin.capabilities.grant"), "Grant controls locked for this session.");
  assert.equal(controlLockedReason("admin.jobs.lifecycle"), "Lifecycle controls locked for this session.");
  assert.doesNotMatch(controlLockedReason("unknown"), /capability|admin:|jobs:/iu);
});

test("a permanently locked grant panel does not render grant-suggesting controls", async () => {
  const page = await readFile(
    new URL("../../app/(authed)/capabilities/page.tsx", import.meta.url),
    "utf8"
  );
  const lockedReturn = page.indexOf("if (!gate.allowed)");
  const grantForm = page.indexOf('label="Subject wallet (0x…)"');
  assert.ok(lockedReturn >= 0 && grantForm >= 0 && lockedReturn < grantForm);
  assert.match(page, /Grant controls locked for this session\./u);
  assert.match(page, /emptyHint=\{grantGate\.allowed/u, "read-only sessions must not be told to use a hidden grant form");
});
