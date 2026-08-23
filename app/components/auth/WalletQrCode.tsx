"use client";

import { useEffect, useRef, useState } from "react";

export function WalletQrCode({ value }: { value: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    setFailed(false);
    void import("qrcode")
      .then(({ toCanvas }) => {
        if (!active || !canvasRef.current) return;
        return toCanvas(canvasRef.current, value, {
          width: 224,
          margin: 2,
          color: { dark: "#111315", light: "#fffdf7" },
          errorCorrectionLevel: "M",
        });
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [value]);

  return failed ? (
    <p className="max-w-56 break-all rounded-[var(--radius)] bg-[var(--paper)] p-3 font-mono text-[10px] text-[var(--muted)]">
      QR rendering failed. Cancel this pairing and generate a new code. Nothing was signed.
    </p>
  ) : (
    <canvas
      ref={canvasRef}
      className="h-56 w-56 rounded-[var(--radius)] border border-[var(--line)] bg-[var(--paper-solid)] p-1"
      aria-label="WalletConnect pairing QR code"
    />
  );
}
