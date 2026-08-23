"use client";

import { useState } from "react";
import { ArrowLeft, Clock3 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useBoundedApi, useJobDefinition, useSession } from "@/lib/api/hooks";
import { extractApiErrorMessage } from "@/lib/api/client";
import { useAuth } from "@/lib/auth/use-auth";
import { WalletSignInFlow } from "@/components/auth/WalletSignInFlow";
import { isTerminalSessionStatus, verificationDepthStatement } from "@/lib/work/human-work.js";
import { SchemaGuidedEditor } from "./SchemaGuidedEditor";
import { VerificationWatchPanel } from "./VerificationWatchPanel";
import type { HumanJobDefinition, WorkSessionRecord } from "./types";
import { asRecord, stringList, text } from "./types";

export function WorkSessionWorkspace({ sessionId }: { sessionId: string }) {
  const auth = useAuth();
  const [submittedSession, setSubmittedSession] = useState<WorkSessionRecord | null>(null);
  const sessionQuery = useSession(auth.authenticated ? sessionId : null);
  const loadedSession = sessionQuery.data as WorkSessionRecord | undefined;
  const session = submittedSession ?? loadedSession;
  const jobId = text(session?.jobId);
  const definitionQuery = useJobDefinition(jobId || null);
  const definition = definitionQuery.data as HumanJobDefinition | undefined;
  const schemaSide = asRecord(asRecord(definition?.schemaContract)?.output);
  const submissionContract = asRecord(definition?.submissionContract);
  const schemaUrl = text(schemaSide?.schemaUrl, text(submissionContract?.outputSchemaUrl));
  const schemaQuery = useBoundedApi<Record<string, unknown>>(schemaUrl || null);
  const example = asRecord(asRecord(submissionContract?.submitPayloadExample)?.submission);

  if (!auth.authenticated) {
    return (
      <Card className="mx-auto w-full max-w-2xl">
        <CardContent className="py-10">
          <Badge tone="muted">Claimant workspace</Badge>
          <h1 className="mt-4 text-3xl font-semibold">Sign in to open this claimed session.</h1>
          <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">The session endpoint is wallet-owned. SIWE proves you are its claimant; no email account or second identity is used.</p>
          <div className="mt-6"><WalletSignInFlow compact onSignedIn={() => undefined} /></div>
        </CardContent>
      </Card>
    );
  }

  if (sessionQuery.isLoading) return <WorkspaceLoading />;

  if (sessionQuery.error) {
    return (
      <ReadFailure
        title="This session could not be opened"
        body={extractApiErrorMessage(sessionQuery.error) || "It may belong to another wallet, have expired, or be temporarily unreadable. No status is being guessed."}
        retry={() => void sessionQuery.mutate()}
      />
    );
  }

  if (!session) {
    return <ReadFailure title="No session was returned" body="The workspace cannot submit or show a result without a live session record." retry={() => void sessionQuery.mutate()} />;
  }

  const status = session.status ?? session.state ?? "unknown";
  const instructions = stringList(definition?.agentInstructions);
  const criteria = stringList(definition?.acceptanceCriteria);
  const awaitingDefinition = Boolean(jobId) && definitionQuery.isLoading;
  const canEdit = status === "claimed" && Boolean(definition) && Boolean(schemaQuery.data);

  return (
    <div className="grid gap-6">
      <a className="inline-flex w-fit items-center gap-2 text-sm font-semibold text-[var(--muted)] hover:text-[var(--accent)]" href={jobId ? `/work/${encodeURIComponent(jobId)}` : "/work"}>
        <ArrowLeft className="h-4 w-4" /> {jobId ? "Back to task terms" : "Back to open work"}
      </a>
      <section className="flex flex-col justify-between gap-5 rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-solid)] p-6 shadow-[var(--shadow-sm)] sm:flex-row sm:items-start">
        <div>
          <p className="eyebrow">Claimed session</p>
          <h1 className="mt-2 text-3xl font-semibold">{definition?.title || jobId || sessionId}</h1>
          <p className="mt-3 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">{definition ? verificationDepthStatement(definition) : "Loading the task definition and its verifier statement."}</p>
        </div>
        <div className="flex flex-col items-start gap-2 sm:items-end">
          <Badge tone={isTerminalSessionStatus(status) ? (status === "resolved" ? "success" : "warn") : "accent"}>{status.replace(/_/gu, " ")}</Badge>
          {session.claimExpiresAt ? <span className="flex items-center gap-2 text-xs text-[var(--muted)]"><Clock3 className="h-3.5 w-3.5" />Claim expires {new Date(session.claimExpiresAt).toLocaleString()}</span> : null}
        </div>
      </section>

      {awaitingDefinition ? <Skeleton className="h-44 w-full" /> : definitionQuery.error ? (
        <ReadFailure title="The claimed task definition is unreadable" body="The editor is disabled rather than guessing instructions or a schema." retry={() => void definitionQuery.mutate()} />
      ) : definition ? (
        <div className="grid gap-4 lg:grid-cols-2">
          <JobNotes title="Instructions" items={instructions} />
          <JobNotes title="Success criteria" items={criteria} />
        </div>
      ) : null}

      {status === "claimed" ? (
        schemaQuery.isLoading ? <Skeleton className="h-96 w-full" /> : schemaQuery.error ? (
          <ReadFailure title="The output schema could not be loaded" body="Nothing can be submitted until the real schema is available." retry={() => void schemaQuery.mutate()} />
        ) : canEdit && schemaQuery.data && jobId ? (
          <SchemaGuidedEditor
            key={schemaUrl}
            jobId={jobId}
            sessionId={sessionId}
            schema={schemaQuery.data}
            advertisedExample={example}
            onSubmitted={(response) => {
              const record = asRecord(response);
              setSubmittedSession({
                ...session,
                ...(record ?? {}),
                sessionId,
                status: text(record?.status, "submitted")
              } as WorkSessionRecord);
            }}
          />
        ) : (
          <ReadFailure title="The submission editor is not ready" body="The claimed job, definition, and schema must agree before submit is enabled." retry={() => { void definitionQuery.mutate(); void schemaQuery.mutate(); }} />
        )
      ) : (
        <VerificationWatchPanel sessionId={sessionId} initialSession={session} definition={definition} />
      )}
    </div>
  );
}

function JobNotes({ title, items }: { title: string; items: string[] }) {
  return (
    <Card><CardContent className="py-6"><p className="eyebrow">{title}</p>{items.length ? <ul className="mt-4 grid gap-2 text-sm leading-relaxed">{items.map((item, index) => <li className="flex gap-3" key={`${index}-${item}`}><span className="font-mono text-xs text-[var(--accent)]">{String(index + 1).padStart(2, "0")}</span>{item}</li>)}</ul> : <p className="mt-4 text-sm text-[var(--muted)]">No additional {title.toLowerCase()} were supplied.</p>}</CardContent></Card>
  );
}

function WorkspaceLoading() {
  return <div className="grid gap-5"><Skeleton className="h-5 w-32" /><Skeleton className="h-44" /><Skeleton className="h-96" /></div>;
}

function ReadFailure({ title, body, retry }: { title: string; body: string; retry: () => void }) {
  return (
    <Card><CardContent className="py-8"><p className="eyebrow text-[var(--warn)]">Live data required</p><h2 className="mt-2 text-2xl font-semibold">{title}</h2><p className="mt-3 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">{body}</p><button className="mt-5 text-sm font-semibold text-[var(--accent)] underline underline-offset-4" onClick={retry}>Retry</button></CardContent></Card>
  );
}
