"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { labelForShareSurface } from "@/lib/share/read-only-share";
import { useApi } from "@/lib/api/hooks";

type ShareSurface = "agent" | "session" | "dispute" | "policy";

type ShareResponse = {
  status: "ok";
  share: {
    surface: ShareSurface;
    id: string;
    mode: "read_only";
    issuedAt: string;
    expiresAt: string;
  };
  resource: {
    kind: string;
    profile?: Record<string, unknown>;
    session?: Record<string, unknown>;
    timeline?: unknown[];
    dispute?: Record<string, unknown>;
    policy?: Record<string, unknown>;
  };
};

export default function SharePage() {
  return (
    <Suspense fallback={<ShareShell><StateCard title="Opening share URL" body="Preparing the read-only verifier." /></ShareShell>}>
      <ShareClient />
    </Suspense>
  );
}

function ShareClient() {
  const params = useSearchParams();
  const token = params.get("token")?.trim() ?? "";
  const request = useApi<ShareResponse>(token ? `/shares/${encodeURIComponent(token)}` : null, {
    shouldRetryOnError: false,
  });

  return (
    <ShareShell>
      {request.isLoading ? (
        <StateCard title="Verifying share URL" body="Checking signature, expiry, and resource availability." />
      ) : request.error ? (
        <StateCard
          tone="bad"
          title="Share URL unavailable"
          body={messageFromError(request.error)}
        />
      ) : request.data ? (
        <ShareSnapshot data={request.data} />
      ) : (
        <StateCard tone="bad" title="Share URL missing" body="No token was provided." />
      )}
    </ShareShell>
  );
}

function ShareShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-[var(--bg)] px-5 py-8 text-[var(--ink)]">
      <section className="mx-auto flex w-full max-w-[920px] flex-col gap-4">
        <header className="rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-solid)] p-5 shadow-[var(--shadow-sm)]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <div className="grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] bg-[var(--accent)] font-[family-name:var(--font-display)] text-sm font-bold text-white">
                A
              </div>
              <div>
                <p
                  className="m-0 font-[family-name:var(--font-display)] text-[11px] font-extrabold uppercase text-[var(--accent)]"
                  style={{ letterSpacing: "0.12em" }}
                >
                  Read-only snapshot
                </p>
                <h1 className="m-0 font-[family-name:var(--font-display)] text-2xl font-bold">
                  Averray shared evidence
                </h1>
              </div>
            </div>
            <span
              className="rounded-full border border-[var(--line)] bg-[rgba(30,102,66,0.08)] px-3 py-1 font-[family-name:var(--font-display)] text-[11px] font-extrabold uppercase text-[var(--accent)]"
              style={{ letterSpacing: "0.08em" }}
            >
              No operator auth
            </span>
          </div>
          <p className="m-0 mt-4 max-w-[70ch] text-sm leading-6 text-[var(--muted)]">
            This URL verifies a signed token, then renders one public snapshot. It cannot claim,
            submit, mutate policy, or expose operator credentials.
          </p>
        </header>
        {children}
      </section>
    </main>
  );
}

function ShareSnapshot({ data }: { data: ShareResponse }) {
  const { share, resource } = data;
  const subject = resource.profile ?? resource.session ?? resource.dispute ?? resource.policy ?? {};

  return (
    <>
      <section className="grid gap-3 rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-solid)] p-5 shadow-[var(--shadow-sm)] md:grid-cols-3">
        <Fact label="Surface" value={labelForShareSurface(share.surface)} />
        <Fact label="Identifier" value={share.id} />
        <Fact label="Expires" value={formatDateTime(share.expiresAt)} />
      </section>
      <section className="rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-solid)] p-5 shadow-[var(--shadow-sm)]">
        <h2 className="m-0 font-[family-name:var(--font-display)] text-lg font-bold">
          {labelForShareSurface(share.surface)}
        </h2>
        <p
          className="m-0 mt-1 font-[family-name:var(--font-mono)] text-xs text-[var(--muted)]"
          style={{ letterSpacing: 0 }}
        >
          issued {formatDateTime(share.issuedAt)} · mode {share.mode}
        </p>
        <SurfaceSummary surface={share.surface} resource={resource} />
        <JsonBlock value={subject} />
        {Array.isArray(resource.timeline) ? (
          <div className="mt-4">
            <h3
              className="m-0 font-[family-name:var(--font-display)] text-[12px] font-extrabold uppercase text-[var(--muted)]"
              style={{ letterSpacing: "0.1em" }}
            >
              Timeline
            </h3>
            <JsonBlock value={resource.timeline} compact />
          </div>
        ) : null}
      </section>
    </>
  );
}

function SurfaceSummary({
  surface,
  resource,
}: {
  surface: ShareSurface;
  resource: ShareResponse["resource"];
}) {
  const value = resource.profile ?? resource.session ?? resource.dispute ?? resource.policy ?? {};
  const summary =
    surface === "agent"
      ? [
          pick(value, "wallet", "address", "walletFull", "id"),
          pick(value, "score", "reputation", "tier"),
          pick(value, "state", "status"),
        ]
      : surface === "session"
        ? [
            pick(value, "id", "sessionId"),
            pick(value, "jobId"),
            pick(value, "status", "state"),
          ]
        : surface === "dispute"
          ? [
              pick(value, "id"),
              pick(value, "state", "status"),
              pick(value, "runRef", "sessionId"),
            ]
          : [
              pick(value, "tag", "id"),
              pick(value, "state", "status"),
              pick(value, "scope", "revision"),
            ];
  const facts = summary.filter((entry): entry is { label: string; value: string } => Boolean(entry));
  if (facts.length === 0) return null;
  return (
    <div className="mt-4 grid gap-2 md:grid-cols-3">
      {facts.map((fact) => (
        <Fact key={fact.label} label={fact.label} value={fact.value} />
      ))}
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-[8px] border border-[var(--line)] bg-[rgba(255,253,247,0.56)] px-3 py-2">
      <div
        className="font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--muted)]"
        style={{ letterSpacing: "0.1em" }}
      >
        {label}
      </div>
      <div
        className="mt-1 min-w-0 break-words font-[family-name:var(--font-mono)] text-[12px] text-[var(--ink)]"
        style={{ letterSpacing: 0 }}
      >
        {value}
      </div>
    </div>
  );
}

function JsonBlock({ value, compact = false }: { value: unknown; compact?: boolean }) {
  return (
    <pre
      className={`mt-4 max-h-[520px] overflow-auto rounded-[8px] border border-[var(--line)] bg-[rgba(17,19,21,0.035)] p-3 font-[family-name:var(--font-mono)] text-[11.5px] leading-5 text-[var(--ink)] ${compact ? "max-h-[260px]" : ""}`}
      style={{ letterSpacing: 0 }}
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function StateCard({
  title,
  body,
  tone = "neutral",
}: {
  title: string;
  body: string;
  tone?: "neutral" | "bad";
}) {
  return (
    <section className="rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-solid)] p-5 shadow-[var(--shadow-sm)]">
      <h2 className={`m-0 font-[family-name:var(--font-display)] text-lg font-bold ${tone === "bad" ? "text-[#8a2a2a]" : ""}`}>
        {title}
      </h2>
      <p className="m-0 mt-2 text-sm leading-6 text-[var(--muted)]">{body}</p>
    </section>
  );
}

function pick(value: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const raw = value[key];
    if (raw === undefined || raw === null || raw === "") continue;
    return { label: key, value: String(raw) };
  }
  return null;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function messageFromError(error: Error & { body?: unknown }) {
  const body = error.body;
  if (body && typeof body === "object" && "error" in body) {
    const raw = (body as { error?: unknown }).error;
    if (typeof raw === "string" && raw.trim()) return raw;
  }
  return error.message || "The token is invalid, expired, or the shared resource is unavailable.";
}
