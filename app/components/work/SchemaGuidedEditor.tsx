"use client";

import { useMemo, useState } from "react";
import { Braces, RotateCcw, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { extractApiErrorMessage, swrFetcher } from "@/lib/api/client";
import { runGuardedSubmit } from "@/lib/api/guarded-submit.js";
import { validationStateFromPayload } from "@/lib/api/submission-contract";
import {
  assembleSchemaSubmission,
  deriveSchemaExample,
  rawFieldDraft,
  schemaFields
} from "@/lib/work/schema-editor.js";

interface FieldShape {
  name: string;
  type: string;
  required: boolean;
  description: string;
  enum: unknown[] | null;
  schema: Record<string, unknown>;
}

interface ValidationIssue {
  path: string;
  message: string;
}

export function SchemaGuidedEditor({
  jobId,
  sessionId,
  schema,
  advertisedExample,
  onSubmitted
}: {
  jobId: string;
  sessionId: string;
  schema: Record<string, unknown>;
  advertisedExample?: Record<string, unknown> | null;
  onSubmitted: (response: unknown) => void;
}) {
  const example = useMemo(
    () => advertisedExample ?? deriveSchemaExample(schema) as Record<string, unknown>,
    [advertisedExample, schema]
  );
  const fields = useMemo(() => schemaFields(schema) as FieldShape[], [schema]);
  const [rawDraft, setRawDraft] = useState<Record<string, string>>(() => rawFieldDraft(schema, example));
  const [serverError, setServerError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const assembled = useMemo(
    () => assembleSchemaSubmission(schema, rawDraft) as { valid: boolean; value: Record<string, unknown>; errors: ValidationIssue[] },
    [rawDraft, schema]
  );

  function updateField(name: string, value: string) {
    setRawDraft((current) => ({ ...current, [name]: value }));
    setServerError(null);
  }

  async function submit() {
    if (!assembled.valid) return;
    setSubmitting(true);
    setServerError(null);
    try {
      const result = await runGuardedSubmit({
        jobId,
        sessionId,
        submission: assembled.value,
        structuredSubmissionRequired: true,
        fetcher: swrFetcher
      });
      if (result.status === "validation_failed") {
        const invalid = validationStateFromPayload(result.validation);
        setServerError([invalid.path, invalid.message].filter(Boolean).join(" · "));
        return;
      }
      onSubmitted(result.submitResponse);
    } catch (error) {
      setServerError(extractApiErrorMessage(error) ?? (error instanceof Error ? error.message : "Submission failed."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-solid)] p-5 shadow-[var(--shadow-sm)] sm:p-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="eyebrow">Schema-guided submission</p>
          <h2 className="mt-2 text-2xl font-semibold">Describe the completed work</h2>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">
            These fields come from this job&apos;s live output schema. Required fields are marked, and the browser validates the exact object before the server validates it again.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={() => setRawDraft(rawFieldDraft(schema, example))}>
          <RotateCcw className="h-4 w-4" /> Load filled example
        </Button>
      </div>

      <div className="mt-7 grid gap-5">
        {fields.map((field) => {
          const issue = assembled.errors.find((error) => error.path === `/${field.name}` || error.path.startsWith(`/${field.name}/`));
          const id = `submission-${field.name}`;
          return (
            <div key={field.name} className="grid gap-2">
              <div className="flex flex-wrap items-baseline gap-2">
                <Label htmlFor={id}>{field.name}</Label>
                <span className="text-xs text-[var(--muted)]">{field.required ? "Required" : "Optional"} · {field.type}</span>
              </div>
              {field.description ? <p className="text-xs text-[var(--muted)]">{field.description}</p> : null}
              <FieldControl field={field} id={id} value={rawDraft[field.name] ?? ""} onChange={(value) => updateField(field.name, value)} />
              {issue ? <p className="text-xs font-medium text-[var(--warn)]" role="alert">{issue.path}: {issue.message}</p> : null}
            </div>
          );
        })}
      </div>

      <div className="mt-7 rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--paper)] p-4">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.1em] text-[var(--muted)]"><Braces className="h-4 w-4 text-[var(--accent)]" /> Direct submission preview</div>
        <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-[var(--ink)]">{JSON.stringify(assembled.value, null, 2)}</pre>
      </div>

      {assembled.errors.length > 0 ? (
        <div className="mt-5 rounded-[var(--radius-sm)] bg-[var(--warn-soft)] px-4 py-3 text-sm text-[var(--warn)]" role="alert">
          <p className="font-semibold">Fix {assembled.errors.length} schema {assembled.errors.length === 1 ? "error" : "errors"} before submitting.</p>
          <ul className="mt-2 grid gap-1 text-xs">{assembled.errors.map((error, index) => <li key={`${error.path}-${index}`}>{error.path}: {error.message}</li>)}</ul>
        </div>
      ) : null}
      {serverError ? <p className="mt-5 rounded-[var(--radius-sm)] bg-[var(--warn-soft)] px-4 py-3 text-sm text-[var(--warn)]" role="alert">Server validation stopped the submission: {serverError}</p> : null}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <Button size="lg" disabled={!assembled.valid || submitting} onClick={() => void submit()}>
          <Send className="h-4 w-4" /> {submitting ? "Submitting…" : "Submit for verification"}
        </Button>
        <p className="text-xs text-[var(--muted)]">The same submitWork path and verifier used by agent workers receive this object.</p>
      </div>
    </section>
  );
}

function FieldControl({ field, id, value, onChange }: { field: FieldShape; id: string; value: string; onChange: (value: string) => void }) {
  if (field.enum) {
    return (
      <select id={id} className="h-10 w-full rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--paper-solid)] px-3 text-sm" value={value} onChange={(event) => onChange(event.target.value)}>
        {!field.required ? <option value="">Not supplied</option> : null}
        {field.enum.map((option) => <option key={String(option)} value={String(option)}>{String(option)}</option>)}
      </select>
    );
  }
  if (field.type.includes("boolean")) {
    return (
      <select id={id} className="h-10 w-full rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--paper-solid)] px-3 text-sm" value={value} onChange={(event) => onChange(event.target.value)}>
        {!field.required ? <option value="">Not supplied</option> : null}
        <option value="true">true</option><option value="false">false</option>
      </select>
    );
  }
  if (field.type.includes("array") || field.type.includes("object")) {
    return <textarea id={id} rows={6} className="w-full rounded-[var(--radius-sm)] border border-[var(--line)] bg-[var(--paper-solid)] px-3 py-2 font-mono text-sm" value={value} onChange={(event) => onChange(event.target.value)} spellCheck={false} />;
  }
  return <Input id={id} type={field.type.includes("number") || field.type.includes("integer") ? "number" : "text"} value={value} onChange={(event) => onChange(event.target.value)} />;
}
