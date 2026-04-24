import Link from "next/link";

export default function RootIndex() {
  return (
    <main className="grid min-h-screen place-items-center bg-[var(--bg)] px-6 py-12">
      <meta httpEquiv="refresh" content="0; url=/overview" />
      <section className="w-full max-w-[420px] rounded-[var(--radius-lg)] border border-[var(--line)] bg-[var(--paper-solid)] p-8 shadow-[var(--shadow-sm)]">
        <div className="flex items-center gap-2">
          <div className="grid h-8 w-8 place-items-center rounded-[var(--radius-sm)] bg-[var(--accent)] font-[family-name:var(--font-display)] text-sm font-bold text-white">
            A
          </div>
          <strong className="font-[family-name:var(--font-display)] text-lg">
            Averray
          </strong>
        </div>
        <p className="mt-6 text-sm text-[var(--muted)]">
          Opening the operator control room.
        </p>
        <Link
          className="mt-5 inline-flex h-9 items-center justify-center rounded-[var(--radius)] bg-[var(--accent)] px-3 text-xs font-semibold text-white"
          href="/overview"
        >
          Continue
        </Link>
      </section>
    </main>
  );
}
