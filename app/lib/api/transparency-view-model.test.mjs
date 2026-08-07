import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  aggregateDisclosure,
  extractProofAnchors,
  mapTransparencyStatus,
  presentTransparencyField,
  transparencyCompositionSentence,
  transparencyFreshnessSentence,
  transparencyPageFreshness,
  transparencyReadChanged,
} from "./transparency-view-model.js";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(here, "..", "..");
const panelPath = resolve(appRoot, "components", "transparency", "TransparencyPanel.tsx");
const pagePath = resolve(appRoot, "app", "(authed)", "transparency", "page.tsx");
const railPath = resolve(appRoot, "components", "shell", "OperatorRail.tsx");
const panel = readFileSync(panelPath, "utf8");
const page = readFileSync(pagePath, "utf8");
const rail = readFileSync(railPath, "utf8");

function field(status, value, unit = "USDC") {
  return {
    value,
    unit,
    status,
    readAtMs: 1_786_000_000_000,
    source: "test source",
    proof: "https://rpc.example.test/ 0x590EbE304E0C7672e2abF3161177D2B94a2aC3fC",
  };
}

test("status seam maps backend fresh/stale/unknown to the existing app vocabulary", () => {
  assert.equal(mapTransparencyStatus("fresh"), "live");
  assert.equal(mapTransparencyStatus("stale"), "partial");
  assert.equal(mapTransparencyStatus("unknown"), "fallback");
  assert.equal(mapTransparencyStatus("future-status"), "fallback");
});

for (const section of ["flow", "escrow", "treasury"]) {
  test(`${section} render model covers live, partial, and fallback without inventing a value`, () => {
    assert.deepEqual(presentTransparencyField(field("fresh", "0.878804")), {
      freshness: "live",
      statusLabel: "Live",
      display: "0.878804",
      missing: false,
      lastKnown: false,
    });
    assert.deepEqual(presentTransparencyField(field("stale", "10")), {
      freshness: "partial",
      statusLabel: "Stale",
      display: "10.000000",
      missing: false,
      lastKnown: true,
    });
    const unknown = presentTransparencyField(field("unknown", null));
    assert.equal(unknown.freshness, "fallback");
    assert.equal(unknown.display, "no read");
    assert.equal(unknown.missing, true);
    assert.notEqual(unknown.display, "0");
  });
}

test("aggregate unknown state is rendered as an explicit lower bound, never a complete total", () => {
  const aggregate = field("unknown", null);
  assert.match(aggregateDisclosure(aggregate), /lower bound/u);
  assert.match(aggregateDisclosure(aggregate), /complete total has no read/u);
  assert.equal(presentTransparencyField(aggregate).display, "no read");
});

test("page freshness compares only backend statuses and never re-derives from readAtMs", () => {
  const fresh = field("fresh", 1, "jobs");
  const stale = { ...field("stale", 1, "jobs"), readAtMs: Date.now() };
  const unknown = { ...field("unknown", null, "jobs"), readAtMs: Date.now() };
  assert.equal(transparencyPageFreshness({ flow: { fresh } }), "live");
  assert.equal(transparencyPageFreshness({ flow: { fresh, stale } }), "partial");
  assert.equal(transparencyPageFreshness({ flow: { fresh, stale, unknown } }), "fallback");
});

test("proof renderer finds checkable endpoint and address anchors", () => {
  const anchors = extractProofAnchors(
    "eth_call balanceOf @ https://rpc.hydradx.cloud/ contract 0x2ec4884088d84e5c2970a034732e5209b0acfa93"
  );
  assert.deepEqual(anchors.urls, ["https://rpc.hydradx.cloud/"]);
  assert.deepEqual(anchors.addresses, ["0x2ec4884088d84e5c2970a034732e5209b0acfa93"]);
});

test("production component applies the truth corrections and event-measured position economics", () => {
  assert.match(panel, /Hydration asset-22 operating float/u);
  assert.match(panel, /On-chain USDC available for venue operations; non-custodial/u);
  assert.match(panel, /aUSDC position; redeemable at par, with growth in the balance/u);
  assert.match(panel, /Position economics · measured from the deposit event/u);
  assert.match(panel, /Observed balances and subtractions only\. No rate, APY, annualisation, or projection\./u);
  assert.match(panel, /Observed growth/u);
  assert.match(panel, /Friction paid/u);
  assert.match(panel, /Net vs committed/u);
  assert.doesNotMatch(panel, /signed venue attestation|signature 0x|USDC\/aUSDC|× rate/iu);
});

test("freshness is summarized per section and only exception lines retain badges", () => {
  assert.match(panel, /transparencyFreshnessSentence\(baseLines\)/u);
  assert.match(panel, /function ExceptionStatusPill/u);
  assert.match(panel, /field\.status === "fresh" \? null/u);
  assert.match(panel, /Hide verification/u);
});

test("one section disclosure retains every field's provenance and proof affordances", () => {
  assert.match(panel, /showProofs \? <SectionProofLedger proofs=\{proofs\} \/> : null/u);
  assert.match(panel, /function SectionProofLedger/u);
  assert.match(panel, /<b className="font-semibold text-\[var\(--avy-ink\)\]">Read<\/b>/u);
  assert.match(panel, /field\.source/u);
  assert.match(panel, /field\.proof/u);
  assert.doesNotMatch(panel, /Dialog/u);
});

test("NO READ tiles render a reason and never hand an unknown field to the value renderer", () => {
  assert.match(panel, /view\.missing \? <MissingReadReason[^>]*\/> : <FieldValue field=\{field\}/u);
  assert.match(panel, /if \(view\.missing\) return null;/u);
  assert.match(panel, /Backend could not read this value\./u);
});

test("derived freshness sentence changes when one line becomes stale", () => {
  const fields = [field("fresh", "1"), field("fresh", "2"), field("fresh", "3")];
  assert.equal(
    transparencyFreshnessSentence(fields),
    "Three chain-read lines, all read within their freshness window."
  );
  assert.equal(
    transparencyFreshnessSentence([fields[0], { ...fields[1], status: "stale" }, fields[2]]),
    "Three chain-read lines: 2 fresh · 1 stale."
  );
});

test("composition is one honest line and names platform-owned volume", () => {
  const composition = {
    platformVerificationRuns: field("fresh", 7, "jobs"),
    ingested: field("fresh", 0, "jobs"),
    external: field("fresh", 0, "jobs"),
    unclassified: field("fresh", 0, "jobs"),
  };
  assert.equal(
    transparencyCompositionSentence(composition),
    "7 platform verification runs · 0 ingested · 0 external · 0 unclassified — all volume is our own loop."
  );
});

test("growth is six-decimal read data and highlight eligibility requires a changed read", () => {
  const initial = field("fresh", "0.000596");
  assert.equal(presentTransparencyField(initial, { decimals: 6 }).display, "0.000596");
  assert.equal(transparencyReadChanged(initial, initial), false);
  assert.equal(transparencyReadChanged(initial, { ...initial, readAtMs: initial.readAtMs + 1 }), false);
  assert.equal(transparencyReadChanged(initial, { ...initial, value: "0.000597", readAtMs: initial.readAtMs + 1 }), true);
  assert.match(panel, /data-growth-read-value=\{field\.value \?\? "unknown"\}/u);
  assert.doesNotMatch(panel, /setInterval\([^)]*growth|requestAnimationFrame|interpolat/iu);
});

test("growth is always rendered beside friction with an explicit unknown net path", () => {
  const growthIndex = panel.indexOf("Observed growth");
  const frictionIndex = panel.indexOf("Friction paid");
  const netIndex = panel.indexOf("Net vs committed");
  assert.ok(growthIndex > -1 && frictionIndex > growthIndex && netIndex > frictionIndex);
  assert.match(panel, /Friction has no read, so net versus committed cannot be computed\./u);
});

test("treasury renders before flow and escrow", () => {
  const treasury = panel.indexOf("<TreasurySection data={data} />");
  const flow = panel.indexOf("<FlowSection data={data} />");
  const escrow = panel.indexOf("<EscrowSection data={data} />");
  assert.ok(treasury > -1 && treasury < flow && flow < escrow);
});

test("page uses one authenticated /transparency read and the shared status/proof components", () => {
  assert.match(page, /useTransparency\(\)/u);
  assert.match(panel, /DataFreshnessPill/u);
  assert.match(panel, /ExplorerLink/u);
  assert.match(panel, /No last-known or placeholder values are being substituted/u);
});

test("Transparency is in the Capital rail beside Treasury", () => {
  assert.match(rail, /href: "\/treasury", label: "Treasury"[\s\S]*href: "\/transparency", label: "Transparency"/u);
});

test("no Claude Design sample constant reaches the production bundle", () => {
  const production = [
    panel,
    page,
    readFileSync(resolve(here, "transparency-view-model.js"), "utf8"),
    readFileSync(resolve(here, "transparency-types.ts"), "utf8"),
  ].join("\n");
  const sampleConstants = [
    "8,412" + ".50",
    "52,908" + ".75",
    "1,204,336" + ".18",
    "128,400" + ".22",
    "99,955" + ".20",
    "12,240" + ".00",
    "16,595" + ".42",
    "0x8F3c74B01D5eA2f6c091Ee3b7A4dC55f9a1b21A9",
  ];
  for (const sample of sampleConstants) {
    assert.equal(production.includes(sample), false, `sample constant leaked: ${sample}`);
  }
});
