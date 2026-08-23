"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function PosterJobsRedirect() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/poster/");
  }, [router]);

  return (
    <p className="text-sm text-[var(--muted)]" role="status">
      Opening <Link className="font-semibold text-[var(--accent)]" href="/poster/">your poster workspace</Link>…
    </p>
  );
}
