import type { FreshnessState } from "@/components/shell/DataFreshnessPill";
import type { TransparencyField, TransparencyFieldStatus, TransparencyPayload } from "./transparency-types";

export const TRANSPARENCY_STATUS_TO_FRESHNESS: Readonly<Record<TransparencyFieldStatus, FreshnessState>>;
export const TRANSPARENCY_STATUS_LABEL: Readonly<Record<TransparencyFieldStatus, string>>;

export function mapTransparencyStatus(status: TransparencyFieldStatus | string | undefined): FreshnessState;
export function presentTransparencyField(
  field: TransparencyField<unknown> | null | undefined,
  options?: { decimals?: number }
): { freshness: FreshnessState; statusLabel: string; display: string; missing: boolean; lastKnown: boolean };
export function transparencyPageFreshness(payload: TransparencyPayload | null | undefined): FreshnessState;
export function worstTransparencyFreshness(fields: Array<TransparencyField<unknown>>): FreshnessState;
export function transparencyFreshnessSentence(fields: Array<TransparencyField<unknown>>, label?: string): string;
export function transparencyCompositionSentence(composition: TransparencyPayload["flow"]["composition24h"]): string;
export function transparencyFlowUnreadSentence(usdcPaid: TransparencyPayload["flow"]["usdcPaid"]): string | null;
export function transparencyGenerationSummary(generation: TransparencyPayload["treasury"]["generation"]): string;
export function transparencyReadChanged(
  previous: Pick<TransparencyField<unknown>, "value" | "readAtMs" | "status"> | null | undefined,
  current: Pick<TransparencyField<unknown>, "value" | "readAtMs" | "status"> | null | undefined
): boolean;
export function aggregateDisclosure(field: TransparencyField<unknown> | null | undefined): string;
export function formatReadAt(readAtMs: number | null | undefined): string;
export function formatWindowMs(value: number | null | undefined): string;
export function extractProofAnchors(text: string | null | undefined): {
  urls: string[];
  addresses: string[];
  transactions: string[];
  routes: string[];
};
