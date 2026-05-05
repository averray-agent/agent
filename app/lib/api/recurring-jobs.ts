export type RecurringTemplateState = "scheduled" | "paused" | "exhausted" | "attention";

export interface RecurringReserveStatus {
  mode: "finite" | "unbounded" | "unknown";
  rewardAsset: string;
  rewardAmount: number;
  reserveAmount?: number;
  consumedAmount?: number;
  remainingAmount?: number;
  remainingRuns?: number;
  exhausted?: boolean;
}

export interface RecurringLastResult {
  status: string;
  at?: string;
  derivativeId?: string;
  message?: string;
}

export interface RecurringTemplateStatus {
  templateId: string;
  category: string;
  tier?: string;
  verifierMode?: string;
  rewardAmount: number;
  rewardAsset: string;
  scheduleLabel: string;
  paused: boolean;
  exhausted: boolean;
  state: RecurringTemplateState;
  nextFireAt?: string;
  lastFiredAt?: string;
  lastResult?: RecurringLastResult;
  derivativeCount: number;
  latestRunId?: string;
  reserve: RecurringReserveStatus;
}

export interface RecurringRuntimeSummary {
  count: number;
  enabled: boolean;
  running: boolean;
  templates: RecurringTemplateStatus[];
}

export type RecurringTemplateAction = "fire" | "pause" | "resume";

export type JsonFetcher = <T = unknown>(
  key: string | [string, RequestInit?]
) => Promise<T>;

export function buildRecurringRuntimeSummary(payload: unknown): RecurringRuntimeSummary {
  const root = asRecord(payload);
  const recurring = asRecord(root?.recurring);
  const scheduler = asRecord(root?.scheduler);
  const schedulerTemplates = new Map<string, Record<string, unknown>>();
  for (const entry of arrayOfRecords(scheduler?.templates)) {
    const id = text(entry.templateId);
    if (id) schedulerTemplates.set(id, entry);
  }

  const templates = arrayOfRecords(recurring?.templates)
    .map((template) => buildTemplate(template, schedulerTemplates.get(text(template.templateId))))
    .filter((template): template is RecurringTemplateStatus => Boolean(template))
    .sort(byOperatorPriority);

  return {
    count: nonNegInt(recurring?.count ?? templates.length),
    enabled: scheduler?.enabled === true,
    running: scheduler?.running === true,
    templates,
  };
}

export async function postRecurringTemplateAction(
  fetcher: JsonFetcher,
  templateId: string,
  action: RecurringTemplateAction
): Promise<unknown> {
  const path =
    action === "fire"
      ? "/admin/jobs/fire"
      : action === "pause"
        ? "/admin/jobs/pause"
        : "/admin/jobs/resume";
  return fetcher([
    path,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        templateId,
        idempotencyKey: `${action}-${templateId}-${new Date().toISOString()}`,
      }),
    },
  ]);
}

export async function refreshRecurringTemplateSurfaces(
  mutate: (key: string) => Promise<unknown>
): Promise<void> {
  await Promise.all([
    mutate("/admin/status"),
    mutate("/admin/jobs"),
    mutate("/jobs"),
  ]);
}

function buildTemplate(
  raw: Record<string, unknown>,
  runtime: Record<string, unknown> | undefined
): RecurringTemplateStatus | null {
  const templateId = text(raw.templateId);
  if (!templateId) return null;
  const reserve = reserveStatus(raw.reserve ?? runtime?.reserve);
  const lastResult = lastResultStatus(runtime?.lastResult ?? raw.lastResult);
  const paused = runtime?.paused === true || raw.paused === true;
  const exhausted =
    runtime?.exhausted === true ||
    raw.exhausted === true ||
    reserve.exhausted === true ||
    lastResult?.status === "reserve_exhausted";
  const state = stateFor({ paused, exhausted, lastResult });
  return {
    templateId,
    category: text(raw.category, "job"),
    tier: text(raw.tier),
    verifierMode: text(raw.verifierMode),
    rewardAmount: nonNegNumber(raw.rewardAmount),
    rewardAsset: text(raw.rewardAsset, reserve.rewardAsset || "DOT"),
    scheduleLabel: scheduleLabel(raw.schedule),
    paused,
    exhausted,
    state,
    nextFireAt: text(runtime?.nextFireAt ?? raw.nextFireAt),
    lastFiredAt: text(runtime?.lastFiredAt ?? raw.lastFiredAt),
    lastResult,
    derivativeCount: nonNegInt(raw.derivativeCount),
    latestRunId: text(asRecord(raw.latestRun)?.id ?? raw.lastDerivativeId),
    reserve,
  };
}

function stateFor(input: {
  paused: boolean;
  exhausted: boolean;
  lastResult?: RecurringLastResult;
}): RecurringTemplateState {
  if (input.exhausted) return "exhausted";
  if (input.paused) return "paused";
  if (input.lastResult?.status === "failed" || input.lastResult?.status === "invalid_schedule") {
    return "attention";
  }
  return "scheduled";
}

function reserveStatus(value: unknown): RecurringReserveStatus {
  const record = asRecord(value);
  if (!record) {
    return { mode: "unknown", rewardAsset: "DOT", rewardAmount: 0 };
  }
  const mode =
    record.mode === "finite" || record.mode === "unbounded" ? record.mode : "unknown";
  return {
    mode,
    rewardAsset: text(record.rewardAsset, "DOT"),
    rewardAmount: nonNegNumber(record.rewardAmount),
    reserveAmount: optionalNumber(record.reserveAmount),
    consumedAmount: optionalNumber(record.consumedAmount),
    remainingAmount: optionalNumber(record.remainingAmount),
    remainingRuns: optionalInt(record.remainingRuns),
    exhausted: record.exhausted === true,
  };
}

function lastResultStatus(value: unknown): RecurringLastResult | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const status = text(record.status);
  if (!status) return undefined;
  return {
    status,
    at: text(record.at),
    derivativeId: text(record.derivativeId),
    message: text(record.message),
  };
}

function scheduleLabel(value: unknown): string {
  const schedule = asRecord(value);
  const cron = text(schedule?.cron);
  const timezone = text(schedule?.timezone);
  if (cron && timezone) return `${cron} · ${timezone}`;
  return cron || timezone || "schedule missing";
}

function byOperatorPriority(
  left: RecurringTemplateStatus,
  right: RecurringTemplateStatus
): number {
  const priority: Record<RecurringTemplateState, number> = {
    exhausted: 0,
    attention: 1,
    paused: 2,
    scheduled: 3,
  };
  const stateDelta = priority[left.state] - priority[right.state];
  if (stateDelta !== 0) return stateDelta;
  return left.templateId.localeCompare(right.templateId);
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is Record<string, unknown> => Boolean(asRecord(entry)))
    : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function nonNegInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function nonNegNumber(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

function optionalNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function optionalInt(value: unknown): number | undefined {
  const parsed = optionalNumber(value);
  return parsed === undefined ? undefined : Math.floor(parsed);
}
