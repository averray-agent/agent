import { cn } from "@/lib/utils/cn";

export type StageState = "done" | "current" | "pending";
/**
 * Optional severity overlay derived from the v2 timeline envelope
 * (PR #158). When the timeline carries a `warn`/`error` event tied
 * to a stage (e.g. verification rejected, claim disputed), the
 * builder sets `tone: "warn"` on that stage and the rail renders
 * the dot/label in the warn palette without changing the stage's
 * primary `state` (Submitted-but-warn still reads as Submitted-done,
 * just colored to flag the issue).
 */
export type StageTone = "ok" | "warn" | "error";

export interface LifecycleStage {
  index: number;
  label: string;
  meta: string;
  state: StageState;
  tone?: StageTone;
}

export interface LifecycleRailProps {
  runId: string;
  contextNote: React.ReactNode;
  stages: LifecycleStage[];
  next: { label: string; value: string; sub: string };
}

export function LifecycleRail({
  runId,
  contextNote,
  stages,
  next,
}: LifecycleRailProps) {
  return (
    <section
      aria-label="Session lifecycle"
      className="flex flex-col gap-3 rounded-[10px] border border-[var(--avy-line)] bg-[var(--avy-paper-solid)] px-4.5 py-3.5 pb-4"
    >
      <header className="flex items-baseline justify-between gap-2.5">
        <div
          className="font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]"
          style={{ letterSpacing: "0.14em" }}
        >
          Session lifecycle · {runId}
        </div>
        <div className="font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]">
          {contextNote}
        </div>
      </header>

      <div className="relative grid grid-cols-[repeat(5,1fr)_auto] items-stretch">
        <span
          aria-hidden="true"
          className="absolute left-[22px] right-[22px] top-[14px] h-0.5 z-0"
          style={{
            backgroundImage:
              "repeating-linear-gradient(to right, rgba(17,19,21,0.15) 0 4px, transparent 4px 8px)",
          }}
        />
        {stages.map((stage) => (
          <Stage key={stage.index} stage={stage} />
        ))}
        <div className="ml-3 flex flex-col items-end gap-1.5 border-l border-[var(--avy-line-soft)] pl-3 pr-0.5">
          <span
            className="font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase text-[var(--avy-muted)]"
            style={{ letterSpacing: "0.12em" }}
          >
            {next.label}
          </span>
          <span className="font-[family-name:var(--font-mono)] text-[12.5px] font-semibold text-[var(--avy-ink)]">
            {next.value}
          </span>
          <span className="font-[family-name:var(--font-mono)] text-[10.5px] text-[var(--avy-muted)]">
            {next.sub}
          </span>
        </div>
      </div>
    </section>
  );
}

function Stage({ stage }: { stage: LifecycleStage }) {
  return (
    <div className="relative z-[1] flex cursor-pointer flex-col items-center gap-1.5 px-1.5">
      <div
        className={cn(
          "grid h-7 w-7 place-items-center rounded-full border-2 bg-[var(--avy-paper-solid)] font-[family-name:var(--font-mono)] text-xs font-semibold transition-all",
          // Default tone — keep the existing accent palette.
          (!stage.tone || stage.tone === "ok") && [
            stage.state === "pending" &&
              "border-[color:rgba(17,19,21,0.18)] text-[var(--avy-muted)]",
            stage.state === "done" &&
              "border-[var(--avy-accent)] bg-[var(--avy-accent)] text-[#fffdf7]",
            stage.state === "current" &&
              "border-[var(--avy-accent)] text-[var(--avy-accent)] shadow-[0_0_0_5px_rgba(30,102,66,0.14)]",
          ],
          // Warn tone — amber dot regardless of state. Flags a
          // soft-rejection / dispute / verifier-flag against this
          // stage without changing whether the stage is "done".
          stage.tone === "warn" && [
            stage.state === "pending" &&
              "border-[color:rgba(167,97,34,0.4)] text-[var(--avy-warn)]",
            stage.state === "done" &&
              "border-[var(--avy-warn)] bg-[var(--avy-warn)] text-[#fffdf7]",
            stage.state === "current" &&
              "border-[var(--avy-warn)] text-[var(--avy-warn)] shadow-[0_0_0_5px_rgba(167,97,34,0.18)]",
          ],
          // Error tone — same warn shape but with a deeper red ring
          // when the backend marks a hard failure (verifier rejected,
          // session slashed, etc.).
          stage.tone === "error" && [
            stage.state === "pending" &&
              "border-[#a0322a]/60 text-[#a0322a]",
            stage.state === "done" &&
              "border-[#a0322a] bg-[#a0322a] text-[#fffdf7]",
            stage.state === "current" &&
              "border-[#a0322a] text-[#a0322a] shadow-[0_0_0_5px_rgba(160,50,42,0.18)]",
          ]
        )}
        style={{ letterSpacing: 0 }}
        title={
          stage.tone === "warn"
            ? "Warning recorded against this stage — see the timeline panel for the event"
            : stage.tone === "error"
              ? "Error recorded against this stage — see the timeline panel for the event"
              : undefined
        }
      >
        {stage.state === "done" ? (
          <span className="font-[family-name:var(--font-display)] text-sm font-extrabold">
            {stage.tone === "warn" || stage.tone === "error" ? "!" : "✓"}
          </span>
        ) : (
          stage.index
        )}
      </div>
      <div
        className={cn(
          "text-center font-[family-name:var(--font-display)] text-[10.5px] font-extrabold uppercase",
          stage.tone === "warn"
            ? "text-[var(--avy-warn)]"
            : stage.tone === "error"
              ? "text-[#a0322a]"
              : stage.state === "current"
                ? "text-[var(--avy-accent)]"
                : stage.state === "done"
                  ? "text-[var(--avy-ink)]"
                  : "text-[var(--avy-muted)]"
        )}
        style={{ letterSpacing: "0.1em" }}
      >
        {stage.label}
      </div>
      <div
        className={cn(
          "font-[family-name:var(--font-mono)] text-[10.5px]",
          stage.tone === "warn"
            ? "text-[var(--avy-warn)]"
            : stage.tone === "error"
              ? "text-[#a0322a]"
              : stage.state === "current"
                ? "text-[var(--avy-accent)]"
                : "text-[var(--avy-muted)]"
        )}
        style={{ letterSpacing: 0 }}
      >
        {stage.meta}
      </div>
    </div>
  );
}
