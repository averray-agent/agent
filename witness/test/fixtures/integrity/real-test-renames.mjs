// Exact declaration lines from the two false-positive hunks recorded by #1152.
// Keep these as evidence fixtures: they are legitimate merged PR diffs, not
// detector-friendly synthetic examples.
export const REAL_TEST_RENAMES = Object.freeze([
  Object.freeze({
    name: "agent#1109",
    path: "scripts/ops/check-hosted-stack.test.mjs",
    removed: Object.freeze([
      'test("hosted smoke walks through the authenticated earnings account and complete withdrawal template", async () => {'
    ]),
    added: Object.freeze([
      'test("hosted smoke asserts the earnings account door is mounted and answers auth-first", async () => {',
      'test("hosted smoke rejects an earnings door that serves account data without auth", async () => {'
    ])
  }),
  Object.freeze({
    name: "reference-agent#813",
    path: "packages/monitor-ui/src/components/ops/ArrivalsPanel.test.tsx",
    removed: Object.freeze([
      'describe("ArrivalsPanel", () => {',
      '  test("every funnel figure is the external count, never the total", () => {',
      '  test("our own traffic is shown apart from the external figure", () => {',
      '  test("shows declared, anonymous and ours, and the furthest an OUTSIDER reached", () => {',
      '  test("a funnel only our own probes walked reads as no outside interest", () => {',
      '  test("pre-split history is named, not folded into either column", () => {',
      '  test("an unreadable feed says unreachable and renders no zero funnel", () => {',
      '  test("an older product-health payload is also a named non-reading", () => {',
      '  test("a pre-cut-over snapshot renders MCP normally and makes no HTTP zero claim", () => {',
      'describe("ArrivalsPanel — independent HTTP front door", () => {',
      '  test("shows the measured HTTP series beside MCP without a combined headline", () => {',
      '  test("promotes SIWE wallet attribution rather than the inferred IP count", () => {',
      '  test("renders the producer\'s cut-over note verbatim and names recovered blindness", () => {',
      '  test("keeps the existing furthest-stage reading on the MCP distinct shape", () => {',
      'describe("ArrivalsPanel — traffic that can be claimed by neither side", () => {',
      '  test("is shown beside the external figure, never inside it", () => {',
      '  test("is not mislabelled as history that predates the split", () => {',
      '  test("real pre-split history is still named, and counts only itself", () => {',
      '  test("the furthest an outsider reached is not borrowed from an unclaimable client", () => {',
      '  test("the panel explains why the external figure is narrower than it was", () => {',
      '  test("a platform that does not report the bucket renders as it always did", () => {',
      '  test("a reported zero still counts as a reading", () => {'
    ]),
    added: Object.freeze([
      'describe("ArrivalsPanel — verdict first", () => {',
      '  test("renders the historical furthest-ever payout burst from feed data", () => {',
      '  test("posted work flips from NEVER when the producer reports the first external job", () => {',
      '  test("pure canary and acceptance traffic never becomes outsider work", () => {',
      '  test("labels non-monotonic call rows and puts a window badge on every figure", () => {',
      '  test("keeps unknown apart and renders the producer cut-over note verbatim", () => {',
      '  test("an older producer is a named missing verdict, never a reconstructed zero", () => {',
      '  test("render code contains no historical design-handback literals", () => {'
    ])
  })
]);

export function declarationPatch(path, removedLines, addedLines) {
  return {
    changedPaths: [path],
    files: [{
      path,
      previousPath: path,
      isNew: false,
      isDeleted: false,
      isRenamed: false,
      removedLines,
      addedLines
    }]
  };
}
