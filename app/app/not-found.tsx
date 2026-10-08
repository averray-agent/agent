import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-5 px-6">
      <p className="eyebrow">Averray · 404</p>
      <h1 className="text-4xl font-semibold">This page is not here.</h1>
      <p className="text-[var(--muted)]">The address may have changed. Your work and account are not changed by this missing page.</p>
      <nav aria-label="Recovery links" className="flex flex-wrap gap-5 underline">
        <Link href="/work/">Browse work</Link>
        <Link href="/">Open Averray</Link>
        <a href="https://averray.com/">Public site</a>
      </nav>
    </main>
  );
}
