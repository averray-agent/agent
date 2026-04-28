"use client";

import type { RunRow } from "./RunQueueTable";

/**
 * Plain-HTML semantic block for `/runs/detail`. Lists source,
 * category, state, reward, job ID, and (when available) the
 * upstream identifier in a definition-list shape so a browser
 * agent can scrape the row's identity without OCRing the screen.
 *
 * Intentionally text-heavy and visually quiet so it sits above the
 * full LoadedRunPanel without competing for attention. The pretty
 * panel still owns the visual story; this block exists for
 * agent-readiness (issue #77) and for accessibility readers.
 */
export interface RunSemanticBlockProps {
  row: RunRow;
}

export function RunSemanticBlock({ row }: RunSemanticBlockProps) {
  const fields = describeRow(row);
  return (
    <section
      aria-label="Run summary"
      className="rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper)] p-[0.85rem_1.05rem] shadow-[var(--shadow-card)]"
    >
      <h2
        className="mb-2 font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-muted)]"
        style={{ letterSpacing: "0.14em" }}
      >
        Run summary
      </h2>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 font-[family-name:var(--font-mono)] text-[12.5px] text-[var(--avy-ink)] sm:grid-cols-[auto_minmax(0,1fr)]">
        {fields.map((field) => (
          <div key={field.label} className="contents">
            <dt
              className="font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase text-[var(--avy-muted)]"
              style={{ letterSpacing: "0.12em" }}
            >
              {field.label}
            </dt>
            <dd
              className="m-0 min-w-0 break-words"
              data-field={field.id}
            >
              {field.value}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

interface Field {
  id: string;
  label: string;
  value: string;
}

function describeRow(row: RunRow): Field[] {
  const fields: Field[] = [
    { id: "job-id", label: "Job ID", value: row.id },
    { id: "title", label: "Title", value: row.title },
    { id: "source", label: "Source", value: describeSource(row) },
    { id: "category", label: "Category", value: row.jobMeta },
    { id: "state", label: "State", value: row.state },
    { id: "reward", label: "Reward", value: `${row.stake} DOT` },
    { id: "worker", label: "Worker", value: row.worker.label },
    { id: "window", label: "Claim window", value: row.age },
  ];
  if (row.lifecycle) {
    fields.push({
      id: "lifecycle",
      label: "Lifecycle",
      value: `${row.lifecycle.status} (${row.lifecycle.state})`,
    });
  }
  if (row.sessionId) {
    fields.push({ id: "session", label: "Session", value: row.sessionId });
  }
  return fields;
}

function describeSource(row: RunRow): string {
  switch (row.source?.type) {
    case "github_issue":
      return `GitHub · ${row.source.repo} #${row.source.issueNumber}`;
    case "wikipedia_article":
      return `Wikipedia · ${row.source.language}.wikipedia / "${row.source.pageTitle}" (rev ${row.source.revisionId})`;
    case "osv_advisory":
      return `OSV · ${row.source.ecosystem}/${row.source.packageName} · ${row.source.advisoryId}`;
    case "open_data_dataset": {
      const parts = [
        "Data.gov",
        row.source.agency,
        row.source.datasetTitle,
        row.source.resourceFormat,
      ].filter((p): p is string => typeof p === "string" && p.length > 0);
      return parts.join(" · ");
    }
    case "openapi_spec": {
      const parts = [
        "OpenAPI",
        row.source.provider,
        row.source.apiTitle,
        row.source.openapiVersion ? `OpenAPI ${row.source.openapiVersion}` : undefined,
        row.source.documentVersion ? `v${row.source.documentVersion}` : undefined,
      ].filter((p): p is string => typeof p === "string" && p.length > 0);
      return parts.join(" · ");
    }
    case "standards_spec": {
      const parts = [
        "Standards",
        row.source.provider.toUpperCase(),
        row.source.specTitle,
        row.source.expectedStatus,
      ].filter((p): p is string => typeof p === "string" && p.length > 0);
      return parts.join(" · ");
    }
    default:
      return "Native";
  }
}
