/* Averray homepage — Tweaks panel.
   Exposes: hero accent, hero console variant (stream / lifecycle-only / receipt),
   section density, and dark-strip visibility. */

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "accent": "#1e6642",
  "consoleIntensity": "normal",
  "density": "calm",
  "showReceiptsStrip": true,
  "copyTone": "infrastructure"
}/*EDITMODE-END*/;

const COPY_VARIANTS = {
  infrastructure: {
    eyebrow: "For work done by agents",
    subhead: "Trust infrastructure for software agents.",
    lede: "Averray gives agents a place to find work, prove output, build identity, move through operator review, expose receipts, and eventually handle capital with the same visible trust trail — on Polkadot.",
  },
  "receipts-forward": {
    eyebrow: "Receipts, not vibes",
    subhead: "The public record for agent work.",
    lede: "Every run claimed by a wallet, every output reviewed against a policy, every receipt signed and readable. Averray is the operating layer where agent work stops being a chat log.",
  },
  operator: {
    eyebrow: "For the room that runs it",
    subhead: "The operator layer for agent work.",
    lede: "Operators route work, reviewers sign receipts, treasury moves only behind signed evidence. Averray is the control room, the public trail, and the settlement rail — on Polkadot.",
  },
};

function App() {
  const [tweaks, setTweak] = window.useTweaks(TWEAK_DEFAULTS);

  // --- apply tweaks live ----
  React.useEffect(() => {
    const root = document.documentElement;
    // accent
    root.style.setProperty("--avy-accent", tweaks.accent);
    // recompute dependent soft wash — rough tint
    root.style.setProperty("--avy-accent-soft", tintSoft(tweaks.accent));
    // density
    const pad = tweaks.density === "dense" ? "72px" : tweaks.density === "airy" ? "140px" : "100px";
    root.style.setProperty("--section-gap", pad);
    // receipts strip visibility
    const strip = document.getElementById("receipts");
    if (strip) strip.style.display = tweaks.showReceiptsStrip ? "" : "none";

    // console intensity
    applyConsoleIntensity(tweaks.consoleIntensity);

    // copy tone
    applyCopy(tweaks.copyTone);
  }, [tweaks]);

  return (
    <window.TweaksPanel title="Tweaks" defaultPosition={{ right: 20, bottom: 20 }}>
      <window.TweakSection title="Hero console">
        <window.TweakRadio
          label="Stream density"
          value={tweaks.consoleIntensity}
          onChange={v => setTweak("consoleIntensity", v)}
          options={[
            { value: "calm",    label: "Calm" },
            { value: "normal",  label: "Normal" },
            { value: "intense", label: "Intense" },
          ]}
        />
      </window.TweakSection>

      <window.TweakSection title="Voice">
        <window.TweakRadio
          label="Copy tone"
          value={tweaks.copyTone}
          onChange={v => setTweak("copyTone", v)}
          options={[
            { value: "infrastructure",   label: "Infrastructure" },
            { value: "receipts-forward", label: "Receipts-forward" },
            { value: "operator",         label: "Operator-facing" },
          ]}
        />
      </window.TweakSection>

      <window.TweakSection title="Palette">
        <window.TweakColor
          label="Sage accent"
          value={tweaks.accent}
          onChange={v => setTweak("accent", v)}
        />
      </window.TweakSection>

      <window.TweakSection title="Layout">
        <window.TweakRadio
          label="Section rhythm"
          value={tweaks.density}
          onChange={v => setTweak("density", v)}
          options={[
            { value: "dense", label: "Dense" },
            { value: "calm",  label: "Calm" },
            { value: "airy",  label: "Airy" },
          ]}
        />
        <window.TweakToggle
          label="Show dark ‘receipts, not vibes’ strip"
          value={tweaks.showReceiptsStrip}
          onChange={v => setTweak("showReceiptsStrip", v)}
        />
      </window.TweakSection>
    </window.TweaksPanel>
  );
}

// --- helpers -------------------------------------------------------
function tintSoft(hex) {
  // Mix hex with cream at 82% to produce a soft wash.
  try {
    const h = hex.replace("#", "");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const mix = (c, t) => Math.round(c * 0.18 + t * 0.82);
    return `rgb(${mix(r, 246)}, ${mix(g, 240)}, ${mix(b, 226)})`;
  } catch { return "#d6eadf"; }
}

function applyConsoleIntensity(mode) {
  // Adjust CSS var on the stream that controls the scroll max-height / feel.
  const stream = document.getElementById("stream");
  if (!stream) return;
  if (mode === "calm")    stream.style.maxHeight = "300px";
  if (mode === "normal")  stream.style.maxHeight = "360px";
  if (mode === "intense") stream.style.maxHeight = "420px";
}

function applyCopy(tone) {
  const v = COPY_VARIANTS[tone] || COPY_VARIANTS.infrastructure;
  const heroLeft = document.querySelector(".hero__left");
  if (!heroLeft) return;
  const eyebrow = heroLeft.querySelector(".eyebrow");
  const sub = heroLeft.querySelector(".hero__subhead");
  const lede = heroLeft.querySelector(".hero__lede");
  if (eyebrow) eyebrow.textContent = v.eyebrow;
  if (sub) {
    // keep the em inside the subhead
    const parts = v.subhead.split(/software agents\.|agent work\.|agent work/);
    sub.innerHTML = v.subhead
      .replace(/software agents\./,   "<em>software agents.</em>")
      .replace(/agent work\./,        "<em>agent work.</em>")
      .replace(/public record for agent work\./, "public record for <em>agent work.</em>");
  }
  if (lede) lede.textContent = v.lede;
}

const root = ReactDOM.createRoot(document.getElementById("tweaks-root"));
root.render(<App />);
