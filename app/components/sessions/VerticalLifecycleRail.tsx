import { cn } from "@/lib/utils/cn";
import type { SessionLifecycleStage } from "./types";

/**
 * Vertical take on the Runs LifecycleRail — stacked stages with a
 * connector line down the left. Stages are tinted per state:
 *   - done: sage filled dot with ✓
 *   - current: outlined sage with pulse ring
 *   - pending: muted outline
 * Tone overrides on done/current (warn/bad) let us render disputed
 * and slashed sessions without adding new stage types.
 */
export function VerticalLifecycleRail({
  stages,
}: {
  stages: SessionLifecycleStage[];
}) {
  return (
    <ol className="relative m-0 flex flex-col gap-2.5 p-0">
      <span
        aria-hidden="true"
        className="absolute left-[10px] top-1.5 h-[calc(100%-1rem)] w-px bg-[var(--avy-line-soft)]"
      />
      {stages.map((stage, i) => (
        <li
          key={i}
          className="relative z-[1] grid items-start gap-3 pl-0"
          style={{ gridTemplateColumns: "22px 1fr" }}
        >
          <Dot stage={stage} />
          <div>
            <div
              className={cn(
                "font-[family-name:var(--font-display)] text-[11.5px] font-extrabold uppercase",
                stage.state === "done" && stage.tone !== "warn" && stage.tone !== "bad" && "text-[var(--avy-ink)]",
                stage.state === "current" && "text-[var(--avy-accent)]",
                stage.state === "pending" && "text-[var(--avy-muted)]",
                stage.tone === "warn" && "text-[var(--avy-warn)]",
                stage.tone === "bad" && "text-[#8c2a17]"
              )}
              style={{ letterSpacing: "0.1em" }}
            >
              {stage.label}
            </div>
            <div
              className="mt-0.5 font-[family-name:var(--font-mono)] text-[11.5px] text-[var(--avy-muted)]"
              style={{ letterSpacing: 0 }}
            >
              {stage.meta}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function Dot({ stage }: { stage: SessionLifecycleStage }) {
  const base = "grid h-[22px] w-[22px] place-items-center rounded-full";
  if (stage.state === "done") {
    return (
      <span
        className={cn(
          base,
          "border-[2px] text-[11px] font-bold",
          stage.tone === "warn" &&
            "border-[var(--avy-warn)] bg-[var(--avy-warn)] text-[#fffdf7]",
          stage.tone === "bad" &&
            "border-[#8c2a17] bg-[#8c2a17] text-[#fffdf7]",
          !stage.tone &&
            "border-[var(--avy-accent)] bg-[var(--avy-accent)] text-[#fffdf7]"
        )}
      >
        ✓
      </span>
    );
  }
  if (stage.state === "current") {
    return (
      <span
        className={cn(
          base,
          "border-[2px] border-[var(--avy-accent)] bg-[var(--avy-paper-solid)] text-[var(--avy-accent)] shadow-[0_0_0_4px_rgba(30,102,66,0.14)]"
        )}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-[var(--avy-accent)] [animation:pulse_1.4s_ease-in-out_infinite]" />
      </span>
    );
  }
  return (
    <span
      className={cn(
        base,
        "border-[2px] border-[color:rgba(17,19,21,0.18)] bg-[var(--avy-paper-solid)]"
      )}
    />
  );
}
