import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "../..");
const read = (path) => readFileSync(resolve(appRoot, path), "utf8");

test("locked policy, audit, and capability feeds are threaded into their panels", () => {
  const policiesPage = read("app/(authed)/policies/page.tsx");
  const auditPage = read("app/(authed)/audit-log/page.tsx");
  const capabilitiesPage = read("app/(authed)/capabilities/page.tsx");
  const policyStrip = read("components/policies/PoliciesAggregateStrip.tsx");
  const auditStrip = read("components/audit/AuditAggregateStrip.tsx");

  assert.match(policiesPage, /policiesPresence\s*=\s*feedPresence\(policiesRequest\)/u);
  assert.match(policiesPage, /presence=\{policiesPresence\}/u);
  assert.match(policyStrip, /policy feed locked for this session \(no operator role\)/u);
  assert.match(auditPage, /auditPresence\s*=\s*feedPresence\(auditRequest\)/u);
  assert.match(auditStrip, /audit feed locked for this session \(no operator role\)/u);
  assert.match(capabilitiesPage, /grantsPresence\s*=\s*feedPresence\(grantsRequest\)/u);
  assert.match(capabilitiesPage, /Grant feed locked for this session/u);
});

test("dispute surfaces use emitted assets, real resolution timestamps, and honest identities", () => {
  const components = [
    "components/disputes/DisputesAggregateStrip.tsx",
    "components/disputes/DisputesTable.tsx",
    "components/disputes/DisputeDrawerBody.tsx",
    "components/disputes/StakeHoldPanel.tsx",
    "components/disputes/DisputesLegend.tsx",
    "components/disputes/DisputesTopbar.tsx",
  ].map(read).join("\n");
  const adapter = read("lib/api/dispute-adapters.ts");

  assert.doesNotMatch(components, /["'`] DOT/u);
  assert.doesNotMatch(components, /verifier-2/u);
  assert.doesNotMatch(components, /mostly policy-violation/u);
  assert.match(components, /d\.resolvedAt/u);
  assert.match(components, /no resolutions in 30d/u);
  assert.match(adapter, /ZERO_ADDRESS/u);
  assert.match(adapter, /identity not yet emitted/u);
  assert.match(adapter, /assetSymbol\(record\)/u);
});

test("governance topbar controls are wired or removed", () => {
  const disputes = read("components/disputes/DisputesTopbar.tsx");
  const policies = read("components/policies/PoliciesTopbar.tsx");
  const audit = read("components/audit/AuditTopbar.tsx");
  const drawer = read("components/disputes/DisputeDrawerBody.tsx");

  assert.match(disputes, /onClick=\{onOpenQueue\}/u);
  assert.doesNotMatch(`${disputes}\n${drawer}`, /Escalate to/u);
  assert.match(policies, /onClick=\{onExportPolicyBundle\}/u);
  assert.doesNotMatch(policies, /Propose new policy/u);
  assert.match(audit, /onClick=\{onExportCsv\}/u);
  assert.match(audit, /onClick=\{onVerifyManifest\}/u);
});
