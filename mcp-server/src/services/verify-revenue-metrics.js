import { formatUnits } from "ethers";

import { OvernightLedgerService } from "./overnight-ledger.js";

const DECISIVE = new Set(["approved", "rejected"]);
const BASE = "eip155:8453";
const TX_HASH = /^0x[a-fA-F0-9]{64}$/u;
const READ_LIMIT = 10_000;
const MAX_PAGES = 100;

/** Read only the existing confirmed-capture records, never jobs, fees or balances. */
export function summarizeVerifyCaptures(runs) {
  const seen = new Set();
  const totals = { approved: { count: 0, amountRaw: 0n }, rejected: { count: 0, amountRaw: 0n } };
  for (const run of runs) {
    const outcome = run?.verdict?.outcome;
    const billing = run?.billing;
    if (!String(run?.runId ?? "").startsWith("verify-") || run?.status !== "complete" || !DECISIVE.has(outcome)
      || billing?.status !== "captured" || billing.network !== BASE || billing.asset !== "USDC"
      || !TX_HASH.test(billing.transactionHash ?? "") || !/^\d+$/u.test(String(billing.amountRaw ?? ""))) continue;
    const key = billing.transactionHash.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    totals[outcome].count += 1;
    totals[outcome].amountRaw += BigInt(billing.amountRaw);
  }
  return totals;
}

/** No new persistence. A cold scrape reconstructs totals from existing rows. */
export function createVerifyRevenueMetrics({ stateStore, now = Date.now, ttlMs = 30_000 } = {}) {
  const ledger = new OvernightLedgerService({ stateStore });
  let held;
  let refreshedAt = 0;
  let inFlight;
  async function refresh() {
    const [verify, hub] = await Promise.allSettled([
      readCaptures(stateStore),
      ledger.getSponsoredOutflows()
    ]);
    const lines = [];
    sample(lines, "averray_financial_metrics_available", "Retained financial source read succeeded, not proof of historical completeness.", "gauge", [
      ['source="verify"', verify.status === "fulfilled" ? 1 : 0],
      ['source="hub"', hub.status === "fulfilled" ? 1 : 0]
    ]);
    if (verify.status === "fulfilled") {
      sample(lines, "averray_verify_billed_usdc_total", "Confirmed Base USDC Verify captures in persisted run records; not all payTo inflows or Hub fees.", "counter",
        Object.entries(verify.value).map(([outcome, row]) => [`network="${BASE}",outcome="${outcome}"`, formatUnits(row.amountRaw, 6)]));
      sample(lines, "averray_verify_billed_runs_total", "Decisive Verify runs with a persisted confirmed Base capture transaction, deduplicated by transaction.", "counter",
        Object.entries(verify.value).map(([outcome, row]) => [`network="${BASE}",outcome="${outcome}"`, row.count]));
    }
    if (hub.status === "fulfilled") {
      sample(lines, "averray_hub_claim_subsidy_estimate_usdc", "Sum of retained session onboarding subsidy estimates, not measured USDC transfers. Can fall with retention.", "gauge", [["", formatUnits(hub.value.claimSubsidyEstimateRaw, 6)]]);
      sample(lines, "averray_hub_first_withdrawal_grants_dot", "DOT amounts in retained first-withdrawal grant events, excluding transfer gas fees. Can fall with retention.", "gauge", [["", formatUnits(hub.value.firstWithdrawalGrantRaw, 18)]]);
      sample(lines, "averray_hub_first_withdrawal_grants", "Distinct first-withdrawal grants in retained events.", "gauge", [["", hub.value.firstWithdrawalGrantCount]]);
      sample(lines, "averray_hub_outflow_read_bounded", "Read reached a retained-store bound or event gap; historical completeness is not implied by zero.", "gauge", [["", Number(hub.value.bounded)]]);
    }
    sample(lines, "averray_hub_operator_transaction_fees_available", "Zero: transaction gas costs are not persisted by these source ledgers; do not treat missing operator fees as zero expense.", "gauge", [["", 0]]);
    sample(lines, "averray_financial_metrics_as_of_seconds", "Time these retained-source readings were assembled.", "gauge", [["", Math.floor(now() / 1_000)]]);
    held = `${lines.join("\n")}\n`;
    refreshedAt = now();
    return held;
  }
  return async () => {
    if (held && now() - refreshedAt < ttlMs) return held;
    if (!inFlight) inFlight = refresh().finally(() => { inFlight = undefined; });
    return inFlight;
  };
}

async function readCaptures(stateStore) {
  if (!stateStore?.scanVerificationRuns) throw new Error("Verification capture records unavailable");
  let cursor = "0";
  const runs = new Map();
  for (let pageCount = 0; pageCount < MAX_PAGES; pageCount += 1) {
    const page = await stateStore.scanVerificationRuns({ cursor, limit: 200 });
    for (const run of page.runs) runs.set(run.runId, run);
    if (runs.size > READ_LIMIT) throw new Error("Verification metrics read limit reached");
    cursor = String(page.nextCursor);
    if (cursor === "0") return summarizeVerifyCaptures([...runs.values()]);
  }
  throw new Error("Verification metrics page limit reached");
}

function sample(lines, name, help, type, values) {
  lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  for (const [labels, value] of values) lines.push(`${name}${labels ? `{${labels}}` : ""} ${value}`);
}
