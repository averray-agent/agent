/**
 * Subtle warm paper-grid backdrop from the Runs handoff.
 *
 * Lives behind the workspace (z-index: 0). The (authed) layout's children
 * sit at z-index: 1 so the grid is visible through gutters but not behind
 * card content.
 */
export function PaperGridBackground() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-0"
      style={{
        backgroundImage: [
          "radial-gradient(ellipse 70% 50% at 12% -10%, rgba(241, 216, 184, 0.35), transparent 60%)",
          "linear-gradient(to right, rgba(17,19,21,0.03) 1px, transparent 1px)",
          "linear-gradient(to bottom, rgba(17,19,21,0.03) 1px, transparent 1px)",
        ].join(", "),
        backgroundSize: "auto, 3.2rem 3.2rem, 3.2rem 3.2rem",
      }}
    />
  );
}
