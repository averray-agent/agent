import { cn } from "@/lib/utils/cn";

const STEPS = [
  { id: 1, short: "Issue", label: "Anchor" },
  { id: 2, short: "Work", label: "Deliverable" },
  { id: 3, short: "Reward", label: "Economics" },
  { id: 4, short: "Review", label: "Publish" },
] as const;

export function PostingStepper({
  currentStep,
  availableStep,
  onStepChange,
}: {
  currentStep: number;
  availableStep: number;
  onStepChange: (step: number) => void;
}) {
  return (
    <nav className="min-[1080px]:hidden" aria-label="New bounty progress" data-mobile-layout="posting">
      <ol className="grid grid-cols-4 gap-1 md:flex md:flex-col md:gap-2">
        {STEPS.map((step) => {
          const active = step.id === currentStep;
          const complete = step.id < currentStep;
          const selectStep = () => onStepChange(step.id);
          return (
            <li key={step.id} className="min-w-0 md:w-full">
              <button
                type="button"
                onClick={selectStep}
                disabled={step.id > availableStep}
                aria-current={active ? "step" : undefined}
                className={cn(
                  "flex min-h-11 w-full flex-col justify-center rounded-[10px] border px-2 py-1.5 text-center md:min-h-14 md:flex-row md:items-center md:justify-start md:gap-2 md:text-left",
                  active && "border-[var(--avy-accent)] bg-[var(--avy-accent-soft)] text-[var(--avy-accent)]",
                  complete && "border-[color:rgba(30,102,66,0.2)] bg-[var(--avy-paper-solid)] text-[var(--avy-accent)]",
                  !active && !complete && "border-[var(--avy-line)] bg-[var(--avy-paper)] text-[var(--avy-muted)]",
                  step.id > availableStep && "cursor-not-allowed opacity-60",
                )}
              >
                <span className="font-[family-name:var(--font-mono)] text-[10px] font-semibold">{complete ? "✓" : step.id}</span>
                <span className="truncate font-[family-name:var(--font-display)] text-[10px] font-extrabold uppercase tracking-[0.04em]">
                  <span className="md:hidden">{step.short}</span>
                  <span className="hidden md:inline">{step.label}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
