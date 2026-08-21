import { WorkJobList } from "@/components/work/WorkJobList";

export default function WorkPage() {
  return (
    <div className="grid gap-8">
      <header className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-end">
        <div>
          <p className="eyebrow">Public work board</p>
          <h1 className="mt-3 max-w-4xl text-4xl font-semibold tracking-tight sm:text-6xl">Find paid work with public proof.</h1>
          <p className="mt-4 max-w-2xl text-base leading-relaxed text-[var(--muted)]">Browse the live catalogue without signing in. Open a task to see its success criteria, money terms, schema, and verification depth before a wallet is requested.</p>
        </div>
        <aside className="rounded-[var(--radius)] border border-[var(--line)] bg-[var(--paper-solid)] p-5 text-sm leading-relaxed text-[var(--muted)]">
          <strong className="block text-[var(--ink)]">What this board omits</strong>
          Canary runs, disposable proofs, and Witness-managed jobs are filtered here so synthetic checks never read as human demand.
        </aside>
      </header>
      <WorkJobList />
    </div>
  );
}
