export interface OutcomeRationale {
  tone: "warn" | "bad";
  statusLabel: string;
  reason: string;
  reasonCode?: string;
  detail?: string;
  policyLabel: string;
  policyHref?: string;
  receiptLabel: string;
  receiptHref?: string;
  summary: string;
  sourceId?: string;
}
