"use client";

import { useMemo, useState } from "react";
import { ArrowLeft, CheckCircle2, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "@/components/ui/toast";
import { useApi, useHumanWorkJobs, useJobDefinition, useJobEligibility, useJobNetReward, useJobPreflight } from "@/lib/api/hooks";
import { extractApiErrorMessage, swrFetcher } from "@/lib/api/client";
import { runClaimJob } from "@/lib/api/claim-job";
import { signIn, WalletUnavailableError } from "@/lib/auth/siwe";
import { useAuth } from "@/lib/auth/use-auth";
import {
  buildClaimTerms,
  filterHumanWorkListings,
  isHumanWorkListing,
  verificationDepthStatement,
  workSessionHref
} from "@/lib/work/human-work.js";
import { ClaimHonestyPanel } from "./ClaimHonestyPanel";
import { SchemaPreview } from "./SchemaPreview";
import type { HumanJobDefinition, HumanJobListing } from "./types";
import { asRecord, stringList, text } from "./types";

export function WorkJobDetail({ jobId }: { jobId: string }) {
  const auth = useAuth();
  const jobsQuery = useHumanWorkJobs();
  const definitionQuery = useJobDefinition(jobId);
  const preflightQuery = useJobPreflight(auth.authenticated ? jobId : null);
  const eligibilityQuery = useJobEligibility(auth.authenticated ? jobId : null);
  const netRewardQuery = useJobNetReward(auth.authenticated ? jobId : null);
  const [signing, setSigning] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);

  const listing = useMemo(
    () => (filterHumanWorkListings(jobsQuery.data) as HumanJobListing[]).find((job) => job.id === jobId),
    [jobId, jobsQuery.data]
  );
  const definition = definitionQuery.data as HumanJobDefinition | undefined;
  const schemaSide = asRecord(asRecord(definition?.schemaContract)?.output);
  const submissionContract = asRecord(definition?.submissionContract);
  const schemaUrl = text(schemaSide?.schemaUrl, text(submissionContract?.outputSchemaUrl));
  const schemaRef = text(schemaSide?.schemaRef, text(submissionContract?.outputSchemaRef));
  const schemaQuery = useApi<Record<string, unknown>>(schemaUrl || null);
  const terms = buildClaimTerms({
    listing,
    definition,
    preflight: preflightQuery.data,
    eligibility: eligibilityQuery.data,
    netReward: netRewardQuery.data
  });
  const walletChecksLoading = auth.authenticated
    && (preflightQuery.isLoading || eligibilityQuery.isLoading || netRewardQuery.isLoading);
  const walletChecksFailed = auth.authenticated
    && Boolean(preflightQuery.error || eligibilityQuery.error || netRewardQuery.error);
  const listingLoaded = !jobsQuery.isLoading;
  const publiclyListed = Boolean(listing && isHumanWorkListing(listing));
  const canClaim = publiclyListed
    && auth.authenticated
    && !walletChecksLoading
    && !walletChecksFailed
    && terms.eligible
    && Boolean(schemaQuery.data)
    && !schemaQuery.error;

  async function handleClaimAction() {
    setClaimError(null);
    if (!auth.authenticated) {
      setSigning(true);
      try {
        await signIn();
        toast.success("Wallet checked. Review the live terms, then claim.");
      } catch (error) {
        setClaimError(error instanceof WalletUnavailableError ? error.message : error instanceof Error ? error.message : "Wallet sign-in failed.");
      } finally {
        setSigning(false);
      }
      return;
    }
    if (!canClaim) return;
    setClaiming(true);
    try {
      const result = await runClaimJob({ jobId, fetcher: swrFetcher });
      const session = asRecord(result.session);
      const sessionId = text(session?.sessionId);
      if (!sessionId) throw new Error("Claim succeeded without a session id. The workspace was not opened.");
      window.location.assign(workSessionHref(sessionId));
    } catch (error) {
      setClaimError(extractApiErrorMessage(error) ?? (error instanceof Error ? error.message : "Claim failed."));
    } finally {
      setClaiming(false);
    }
  }

  if (definitionQuery.isLoading || jobsQuery.isLoading) {
    return <DetailLoading />;
  }

  if (definitionQuery.error) {
    return <ReadFailure title="This task could not be loaded" body="The live definition is unreadable, so no terms or claim action are being guessed." retry={() => void definitionQuery.mutate()} />;
  }

  if (listingLoaded && !publiclyListed) {
    return <ReadFailure title="This task is not listed for human work" body="It may be closed, synthetic, disposable proof, or Witness-managed. It is not being presented as public demand." retry={() => void jobsQuery.mutate()} />;
  }

  if (!definition) {
    return <ReadFailure title="No task definition was returned" body="Claiming is disabled until the live definition is available." retry={() => void definitionQuery.mutate()} />;
  }

  const instructions = stringList(definition.agentInstructions);
  const criteria = stringList(definition.acceptanceCriteria);
  const preflightMessage = preflightQuery.error || eligibilityQuery.error || netRewardQuery.error
    ? extractApiErrorMessage(preflightQuery.error ?? eligibilityQuery.error ?? netRewardQuery.error)
    : null;

  return (
    <div className="grid gap-6">
      <a className="inline-flex w-fit items-center gap-2 text-sm font-semibold text-[var(--muted)] hover:text-[var(--accent)]" href="/work">
        <ArrowLeft className="h-4 w-4" /> Back to open work
      </a>
      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px] lg:items-end">
        <div>
          <p className="eyebrow">{definition.category || "Paid task"} · {definition.tier || "open"}</p>
          <h1 className="mt-3 max-w-4xl text-3xl font-semibold tracking-tight sm:text-5xl">{definition.title || jobId}</h1>
          <p className="mt-4 max-w-3xl text-base leading-relaxed text-[var(--muted)]">{definition.description || listing?.summary || "Read the instructions and exact success criteria below."}</p>
        </div>
        <div className="rounded-[var(--radius)] border border-[var(--line)] bg-[var(--paper-solid)] p-4 text-sm">
          <p className="eyebrow">Verification depth</p>
          <p className="mt-2 leading-relaxed text-[var(--muted)]">{verificationDepthStatement(definition)}</p>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <DefinitionList title="Instructions" items={instructions} empty="No extra instructions were supplied beyond the task definition." />
        <DefinitionList title="Success criteria" items={criteria} empty="No success criteria are readable. Claiming should remain disabled until the definition is corrected." />
      </div>

      <SchemaPreview schema={schemaQuery.data} schemaRef={schemaRef} />
      {schemaQuery.error ? (
        <ReadFailure title="The output schema could not be loaded" body="The editor will not invent a submission shape. Retry the schema before claiming." retry={() => void schemaQuery.mutate()} compact />
      ) : null}
      <ClaimHonestyPanel terms={terms} walletChecked={auth.authenticated && !walletChecksLoading && !walletChecksFailed} />

      {walletChecksLoading ? <p className="text-sm text-[var(--muted)]">Checking live eligibility, lock, gas, waiver, and net reward for {auth.wallet}…</p> : null}
      {walletChecksFailed ? (
        <p className="rounded-[var(--radius-sm)] bg-[var(--warn-soft)] px-4 py-3 text-sm text-[var(--warn)]" role="alert">
          Wallet-specific terms could not be confirmed. Nothing was claimed. {preflightMessage || "Retry the live checks."}
        </p>
      ) : null}
      {claimError ? <p className="rounded-[var(--radius-sm)] bg-[var(--warn-soft)] px-4 py-3 text-sm text-[var(--warn)]" role="alert">{claimError}</p> : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button size="lg" onClick={() => void handleClaimAction()} disabled={signing || claiming || (auth.authenticated && !canClaim) || !publiclyListed}>
          {auth.authenticated ? <CheckCircle2 className="h-4 w-4" /> : <Wallet className="h-4 w-4" />}
          {signing ? "Waiting for wallet…" : claiming ? "Claiming…" : auth.authenticated ? "Claim this job" : "Check wallet and claim"}
        </Button>
        <p className="max-w-xl text-xs leading-relaxed text-[var(--muted)]">
          {auth.authenticated
            ? "The claim uses the same idempotent job endpoint as agent workers. It does not create a different kind of job."
            : "Your wallet is requested here, not while browsing. SIWE proves the claimant identity; no email account is created."}
        </p>
      </div>
    </div>
  );
}

function DefinitionList({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <Card>
      <CardContent className="py-6">
        <p className="eyebrow">{title}</p>
        {items.length ? (
          <ol className="mt-4 grid gap-3 text-sm leading-relaxed">
            {items.map((item, index) => (
              <li key={`${index}-${item}`} className="flex gap-3"><span className="font-mono text-xs text-[var(--accent)]">{String(index + 1).padStart(2, "0")}</span><span>{item}</span></li>
            ))}
          </ol>
        ) : <p className="mt-4 text-sm text-[var(--muted)]">{empty}</p>}
      </CardContent>
    </Card>
  );
}

function DetailLoading() {
  return <div className="grid gap-5"><Skeleton className="h-5 w-36" /><Skeleton className="h-24 w-full" /><div className="grid gap-4 lg:grid-cols-2"><Skeleton className="h-48" /><Skeleton className="h-48" /></div><Skeleton className="h-64" /></div>;
}

function ReadFailure({ title, body, retry, compact = false }: { title: string; body: string; retry: () => void; compact?: boolean }) {
  return (
    <Card className={compact ? "" : "mx-auto w-full max-w-2xl"}>
      <CardContent className="py-8">
        <p className="eyebrow text-[var(--warn)]">Live data required</p>
        <h1 className="mt-2 text-2xl font-semibold">{title}</h1>
        <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">{body}</p>
        <button className="mt-5 text-sm font-semibold text-[var(--accent)] underline underline-offset-4" onClick={retry}>Retry</button>
      </CardContent>
    </Card>
  );
}
