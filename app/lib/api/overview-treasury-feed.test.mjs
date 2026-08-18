import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const overviewPath = new URL("../../app/(authed)/overview/page.tsx", import.meta.url);

test("overview capital and posture use the live treasury strategy feed", async () => {
  const source = await readFile(overviewPath, "utf8");

  assert.match(source, /const treasurySummary = useTreasurySummary\(\)/u);
  assert.doesNotMatch(source, /useStrategyPositions/u);
  assert.match(
    source,
    /!treasuryFeedAvailable\(treasurySummary\.data, "strategyLanes"\)/u,
    "a 200 summary with an unavailable lane feed must not be treated as live"
  );
  assert.match(source, /buildRoomVitals\([\s\S]*?treasurySummary\.data,[\s\S]*?strategyPresence/u);
});
