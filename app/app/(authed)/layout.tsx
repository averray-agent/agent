import { OperatorRail } from "@/components/shell/OperatorRail";
import { PaperGridBackground } from "@/components/runs/PaperGridBackground";
import { LiveDataBridge } from "@/components/shell/LiveDataBridge";
import { AuthRefreshBridge } from "@/components/shell/AuthRefreshBridge";
import { AuthedGuard } from "@/components/shell/AuthedGuard";
import { DemoModeBanner } from "@/components/shell/DemoModeBanner";

export default function AuthedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Bridges placed OUTSIDE the guard:
  //   - DemoModeBanner — env-driven, safe + correct to mount on the
  //     sign-in placeholder so the truth-mode strip is visible even
  //     pre-sign-in when NEXT_PUBLIC_DEMO_MODE=true.
  //   - AuthRefreshBridge — the background JWT refresh manager. It
  //     no-ops without a session, and we want it ready to react the
  //     moment a session lands (so the guard sees `authenticated`
  //     flip without an extra render hop).
  //
  // LiveDataBridge moves INSIDE the guard (P3.7) — it opens an SSE
  // event stream that 401s without a session; mounting it outside
  // would burn auth-failed connections on every unauthed visit.
  //
  // The whole operator shell (rail + main column) lives inside
  // AuthedGuard so an unauthed visitor never sees the topbar,
  // navigation, or empty live cards that look like "platform has no
  // activity" — only a neutral "Checking sign-in… / Redirecting…"
  // placeholder before /sign-in takes over.
  return (
    <>
      <DemoModeBanner />
      <AuthRefreshBridge />
      <PaperGridBackground />
      <AuthedGuard>
        <LiveDataBridge />
        <div className="relative z-[1] mx-auto w-full max-w-[1440px] px-6 py-6">
          <div className="flex items-start gap-5">
            <OperatorRail />
            <main className="flex min-w-0 flex-1 flex-col gap-5">{children}</main>
          </div>
        </div>
      </AuthedGuard>
    </>
  );
}
