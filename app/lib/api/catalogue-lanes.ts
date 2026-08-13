export interface CatalogueLaneCardData {
  id: string;
  paused: boolean;
  hypothesis: string;
  stopCondition: string;
  spend24h: string;
  cap24h: string;
  jobsPosted24h: number;
  externalClaimantShare: string;
  externalClaimantCount: number;
  retainedExternalWorkers14d: number;
  costPerRetainedExternalWorker30d: string;
  costComplete: boolean;
  omittedSettlementCount: number;
}

export function buildCatalogueLaneCards(payload: unknown): CatalogueLaneCardData[] {
  const root = record(payload);
  const catalogueLanes = record(root?.catalogueLanes);
  if (!Array.isArray(catalogueLanes?.lanes)) return [];

  return catalogueLanes.lanes.flatMap((value) => {
    const lane = record(value);
    const exposure = record(lane?.exposure24h);
    const claimants = record(lane?.claimantShare24h);
    const cost = record(lane?.costPerRetainedExternalWorker30d);
    const id = text(lane?.id);
    const hypothesis = text(lane?.hypothesis);
    const stopCondition = text(lane?.stopCondition);
    if (!id || !hypothesis || !stopCondition || !exposure || !claimants || !cost) return [];

    const externalShareBps = nonNegativeInteger(claimants.externalShareBps);
    const retained = nonNegativeInteger(lane?.retainedExternalWorkers14d);
    const costUsdc = nullableText(cost.usdc);
    return [{
      id,
      paused: lane?.paused === true,
      hypothesis,
      stopCondition,
      spend24h: text(exposure.used, "0"),
      cap24h: text(exposure.cap, "0"),
      jobsPosted24h: nonNegativeInteger(lane?.jobsPosted24h),
      externalClaimantShare: `${(externalShareBps / 100).toFixed(externalShareBps % 100 === 0 ? 0 : 2)}%`,
      externalClaimantCount: nonNegativeInteger(claimants.externalClaimantCount),
      retainedExternalWorkers14d: retained,
      costPerRetainedExternalWorker30d: costUsdc === null
        ? `not computable · ${retained} retained`
        : `${costUsdc} USDC`,
      costComplete: cost.complete === true,
      omittedSettlementCount: nonNegativeInteger(cost.omittedSettlementCount)
    }];
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}
