import { OperatorRail } from "@/components/shell/OperatorRail";
import { PaperGridBackground } from "@/components/runs/PaperGridBackground";
import { LiveDataBridge } from "@/components/shell/LiveDataBridge";

export default function AuthedLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <LiveDataBridge />
      <PaperGridBackground />
      <div className="relative z-[1] mx-auto w-full max-w-[1440px] px-6 py-6">
        <div className="flex items-start gap-5">
          <OperatorRail />
          <main className="flex min-w-0 flex-1 flex-col gap-5">{children}</main>
        </div>
      </div>
    </>
  );
}
