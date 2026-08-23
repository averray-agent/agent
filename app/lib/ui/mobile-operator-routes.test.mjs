import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  RESPONSIVE_OPERATOR_PATHS,
  activePostingStep,
  formatOperatorSessionExpiry,
  isGovernanceOperatorPath,
  receiptMatchesMobileQuery,
  updateMoreSheetState,
} from "./mobile-operator.js";

const read = (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("operator desktop gate is limited to governance while ratified routes remain mobile", () => {
  for (const path of ["/policies", "/capabilities/key", "/disputes", "/audit-log/entry"]) {
    assert.equal(isGovernanceOperatorPath(path), true, `${path} must remain gated below 768px`);
  }
  for (const path of RESPONSIVE_OPERATOR_PATHS) {
    assert.equal(isGovernanceOperatorPath(path), false, `${path} must reach its responsive layout`);
  }
});

test("More sheet has explicit open, close, navigation, sign-out, and disconnect transitions", () => {
  assert.equal(updateMoreSheetState(false, "open"), true);
  for (const event of ["close", "navigate", "sign_out", "disconnect"]) {
    assert.equal(updateMoreSheetState(true, event), false, `${event} must close the sheet`);
  }
  assert.equal(updateMoreSheetState(true, "unknown"), true);
});

test("session expiry labels accept SIWE ISO and WalletConnect epoch seconds without inventing a deadline", () => {
  const expiry = "2030-01-02T03:04:05.000Z";
  assert.equal(formatOperatorSessionExpiry(expiry), "2030-01-02T03:04:05Z");
  assert.equal(formatOperatorSessionExpiry(Date.parse(expiry) / 1_000), "2030-01-02T03:04:05Z");
  assert.equal(formatOperatorSessionExpiry(null), "Not reported");
  assert.equal(formatOperatorSessionExpiry("not-a-date"), "Not reported");
});

test("posting step is derived from the real wizard readiness state", () => {
  assert.equal(activePostingStep({ issueVerified: false, deliverableChosen: false, contentReady: false, rewardReady: false }), 1);
  assert.equal(activePostingStep({ issueVerified: true, deliverableChosen: false, contentReady: false, rewardReady: false }), 2);
  assert.equal(activePostingStep({ issueVerified: true, deliverableChosen: true, contentReady: true, rewardReady: false }), 3);
  assert.equal(activePostingStep({ issueVerified: true, deliverableChosen: true, contentReady: true, rewardReady: true }), 4);
});

test("mobile receipt search filters the live row projection", () => {
  const row = {
    id: "receipt-27",
    kind: "run",
    subject: "wiki-en-8017",
    subjectSub: "Citation repair",
    policy: "AV-2",
    signedAt: "14:22 UTC",
  };
  assert.equal(receiptMatchesMobileQuery(row, "citation"), true);
  assert.equal(receiptMatchesMobileQuery(row, "AV-2"), true);
  assert.equal(receiptMatchesMobileQuery(row, "missing"), false);
});

const ROUTE_BINDINGS = [
  {
    route: "overview",
    source: "app/(authed)/overview/page.tsx",
    anchor: "<MobileOverview",
    component: "components/overview/MobileOverview.tsx",
    semantics: [/Current verdict/u, /<RoomVitals/u, /Capabilities/u],
  },
  {
    route: "runs",
    source: "app/(authed)/runs/page.tsx",
    anchor: "<MobileRunsSurface",
    component: "components/runs/MobileRunsSurface.tsx",
    semantics: [/Filter runs/u, /<details/u, /data-mobile-layout="runs"/u],
  },
  {
    route: "receipts",
    source: "app/(authed)/receipts/page.tsx",
    anchor: "<MobileReceiptsList",
    component: "components/receipts/MobileReceiptsList.tsx",
    semantics: [/sticky top-0/u, /min-h-14/u, /receiptMatchesMobileQuery/u],
  },
  {
    route: "posting",
    source: "components/poster/NewBountyPanel.tsx",
    anchor: "<PostingStepper",
    component: "components/poster/PostingStepper.tsx",
    semantics: [/aria-current=\{active \? "step"/u, /disabled=\{step\.id > availableStep\}/u, /grid-cols-4/u, /md:flex-col/u],
  },
  {
    route: "agents",
    source: "app/(authed)/agents/page.tsx",
    anchor: "<MobileAgentCards",
    component: "components/agents/MobileAgentCards.tsx",
    semantics: [/<TierChip/u, /md:grid-cols-2/u, /data-mobile-layout="agents"/u],
  },
  {
    route: "treasury",
    source: "app/(authed)/treasury/page.tsx",
    anchor: "<MobileTreasury",
    component: "components/treasury/MobileTreasury.tsx",
    semantics: [/<BalanceSheetStrip/u, /<PolicyGateFooter/u, /data-mobile-layout="treasury"/u],
  },
];

for (const binding of ROUTE_BINDINGS) {
  test(`mutation gate: ${binding.route} loses its responsive layout by name`, async () => {
    const [source, component] = await Promise.all([read(binding.source), read(binding.component)]);
    const anchorOccurrences = source.split(binding.anchor).length - 1;
    assert.equal(anchorOccurrences, 1, `${binding.route}: anchorOccurrences must be exactly 1 before mutation`);
    assertRouteBinding(binding.route, source, binding.anchor);
    for (const semantic of binding.semantics) {
      assert.match(component, semantic, `${binding.route}: mobile component must implement ${semantic}`);
    }

    const mutated = source.replace(binding.anchor, "<RemovedMobileLayout");
    assert.equal(mutated === source, false, `${binding.route}: mutation must apply`);
    assert.equal(mutated.split(binding.anchor).length - 1, 0, `${binding.route}: anchor must be absent after mutation`);
    assert.throws(
      () => assertRouteBinding(binding.route, mutated, binding.anchor),
      new RegExp(`${binding.route} mobile layout missing`, "u"),
    );
  });
}

test("bottom bar and More sheet expose the complete route and session contract", async () => {
  const [navigation, routes] = await Promise.all([
    read("components/shell/OperatorMobileNavigation.tsx"),
    read("components/shell/OperatorRoutes.ts"),
  ]);
  for (const path of ["/overview", "/runs", "/receipts"]) {
    assert.match(navigation, new RegExp(`href: "${path}"`, "u"));
  }
  for (const group of ["Room", "Capital", "Governance"]) {
    assert.match(routes, new RegExp(`label: "${group}"`, "u"));
  }
  assert.match(navigation, /<Dialog\.Trigger/u);
  assert.match(navigation, /<Dialog\.Close/u);
  assert.match(navigation, /Averray sign-in expiry/u);
  assert.match(navigation, /Wallet signing expiry/u);
  assert.match(navigation, /<ChainTicker/u);
  assert.match(navigation, />\s*Sign out\s*</u);
  assert.match(navigation, />\s*Disconnect\s*</u);
  assert.match(navigation, /min-h-11/u);
});

test("receipt detail is full-screen on phones, 420px on tablets, and retains desktop width", async () => {
  const drawer = await read("components/shell/DetailDrawer.tsx");
  assert.match(drawer, /left-0 w-full/u);
  assert.match(drawer, /md:w-\[420px\]/u);
  assert.match(drawer, /min-\[1080px\]:w-\[520px\]/u);
});

test("breakpoint contract keeps the bottom bar through tablet and restores untouched desktop composition at 1080", async () => {
  const [layout, navigation, rail, runs, vitals, treasury, posting] = await Promise.all([
    read("app/(authed)/layout.tsx"),
    read("components/shell/OperatorMobileNavigation.tsx"),
    read("components/shell/OperatorRail.tsx"),
    read("app/(authed)/runs/page.tsx"),
    read("components/overview/RoomVitals.tsx"),
    read("components/treasury/BalanceSheetStrip.tsx"),
    read("components/poster/PostingStepper.tsx"),
  ]);
  assert.match(layout, /<OperatorRail/u);
  assert.match(rail, /hidden h-\[calc\(100vh-3rem\)\][\s\S]*min-\[1080px\]:flex/u);
  assert.match(navigation, /md:w-\[360px\]/u);
  assert.match(navigation, /min-\[1080px\]:hidden/u);
  assert.match(runs, /grid-cols-1 items-start[\s\S]*xl:grid-cols-/u);
  assert.match(vitals, /grid-cols-2 md:grid-cols-4/u);
  assert.match(treasury, /md:grid-cols-3/u);
  assert.match(posting, /grid-cols-4/u);
  assert.match(posting, /md:flex-col/u);
});

function assertRouteBinding(route, source, anchor) {
  assert.ok(source.includes(anchor), `${route} mobile layout missing`);
}
