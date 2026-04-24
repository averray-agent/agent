/* global React */
const { useState, useMemo, useEffect } = React;

// ---------- Utility components ----------

function SeverityPill({ severity }) {
  const map = {
    "advisory":  { bg: "#ebe7da", fg: "#756d58", label: "Advisory" },
    "gating":    { bg: "var(--avy-accent-soft)", fg: "var(--avy-accent)", label: "Gating" },
    "hard-stop": { bg: "#f3d2c9", fg: "#8c2a17", label: "Hard-stop" },
  };
  const s = map[severity];
  return (
    <span className="sev-pill" style={{ background: s.bg, color: s.fg }}>
      {s.label}
    </span>
  );
}

function StatePill({ state }) {
  const map = {
    Active:   { cls: "pill pill--ok",      dot: true  },
    Pending:  { cls: "pill pill--warn pulse", dot: true  },
    Draft:    { cls: "pill pill--neutral", dot: false },
    Retired:  { cls: "pill pill--retired", dot: false },
  };
  const s = map[state];
  return (
    <span className={s.cls}>
      {s.dot && <span className="pill-dot"></span>}
      {state}
    </span>
  );
}

function ScopePill({ label }) {
  return <span className="scope-pill">{label}</span>;
}

function SignerAvatar({ k, size = 22, pending, signed }) {
  const s = SIGNERS[k];
  if (!s) return null;
  const ring = pending ? "rgba(167,97,34,0.55)" : signed ? "rgba(30,102,66,0.55)" : "rgba(17,19,21,0.18)";
  return (
    <span
      className="avatar"
      title={`${s.role} · ${s.addr}`}
      style={{
        width: size, height: size,
        background: `oklch(78% 0.08 ${s.hue})`,
        boxShadow: `0 0 0 1.5px ${ring}, inset 0 0 0 1px rgba(255,255,255,0.4)`,
      }}
    >{s.initials}</span>
  );
}

function SignerAvatars({ keys, approvals }) {
  const byKey = useMemo(() => {
    const m = {};
    (approvals || []).forEach(a => { m[a.key] = a.state; });
    return m;
  }, [approvals]);
  return (
    <span className="avatar-row">
      {keys.map(k => (
        <SignerAvatar
          key={k} k={k}
          signed={byKey[k] === "signed"}
          pending={byKey[k] === "pending"}
        />
      ))}
    </span>
  );
}

// ---------- Diff viewer ----------
// unified diff between two versions (active vs selected)
function computeDiff(prevText, nextText) {
  const a = prevText.split("\n");
  const b = nextText.split("\n");
  // LCS
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i+1][j+1] + 1 : Math.max(dp[i+1][j], dp[i][j+1]);
  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push({ kind: " ", text: a[i] }); i++; j++; }
    else if (dp[i+1][j] >= dp[i][j+1]) { out.push({ kind: "-", text: a[i] }); i++; }
    else { out.push({ kind: "+", text: b[j] }); j++; }
  }
  while (i < m) out.push({ kind: "-", text: a[i++] });
  while (j < n) out.push({ kind: "+", text: b[j++] });
  return out;
}

function DiffView({ prev, next, prevLabel, nextLabel }) {
  const lines = useMemo(() => computeDiff(prev, next), [prev, next]);
  return (
    <div className="diff">
      <div className="diff__head">
        <span className="diff__side diff__side--minus">
          <span className="k">−</span>{prevLabel}
        </span>
        <span className="diff__side diff__side--plus">
          <span className="k">+</span>{nextLabel}
        </span>
      </div>
      <div className="diff__body">
        {lines.map((ln, i) => (
          <div key={i} className={`diff__ln diff__ln--${ln.kind === "+" ? "add" : ln.kind === "-" ? "rem" : "ctx"}`}>
            <span className="diff__mark">{ln.kind}</span>
            <span className="diff__txt">{ln.text || " "}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------- Approval chain ----------
function ApprovalChain({ approvals }) {
  return (
    <div className="chain">
      {approvals.map((a, i) => (
        <div key={i} className={`chain__row chain__row--${a.state}`}>
          <div className="chain__left">
            <SignerAvatar k={a.key} size={28}
              signed={a.state === "signed"} pending={a.state === "pending"} />
            <div className="chain__who">
              <span className="chain__role">{a.role}</span>
              <span className="chain__addr">{a.addr}</span>
            </div>
          </div>
          <div className="chain__right">
            {a.state === "signed" && (
              <>
                <span className="chain__state chain__state--ok">✓ Signed</span>
                <span className="chain__ts">{a.at}</span>
                <span className="chain__sig">{a.sig}</span>
              </>
            )}
            {a.state === "pending" && (
              <>
                <span className="chain__state chain__state--pending">
                  <span className="pending-dot"></span>… Pending
                </span>
                <span className="chain__ts">awaiting signature</span>
                <span className="chain__sig">—</span>
              </>
            )}
            {a.state === "declined" && (
              <>
                <span className="chain__state chain__state--declined">✕ Declined</span>
                <span className="chain__ts">{a.at}</span>
                <span className="chain__sig">—</span>
              </>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- Propose-change form ----------
function ProposeForm({ policy, onCancel }) {
  const activeRule = policy.rule[`v${policy.revision}`];
  const [body, setBody] = useState(activeRule);
  const [summary, setSummary] = useState("");
  const [selectedSigners, setSelectedSigners] = useState([]);
  const [effDate, setEffDate] = useState("2026-05-01");

  const toggle = (k) => setSelectedSigners(s =>
    s.includes(k) ? s.filter(x => x !== k) : [...s, k]);

  const enough = selectedSigners.length >= policy.signersReq && summary.trim().length > 3;

  return (
    <div className="propose">
      <div className="propose__head">
        <span className="eyebrow eyebrow--sage">Propose change</span>
        <span className="propose__hint">
          Next revision → <span className="mono">v{policy.revision + 1}</span>
          {" · requires "}<b>{policy.signersReq} of {policy.signersTotal}</b>{" signers"}
        </span>
      </div>

      <label className="propose__field">
        <span className="propose__label">Proposed rule body</span>
        <textarea
          className="propose__rule"
          spellCheck="false"
          value={body}
          onChange={e => setBody(e.target.value)}
        />
        <span className="propose__note mono">
          bounded DSL · schema-validated by {policy.handler.split("/").pop()}
        </span>
      </label>

      <label className="propose__field">
        <span className="propose__label">Change summary</span>
        <input
          className="propose__input"
          placeholder="One line — what changed and why."
          value={summary}
          onChange={e => setSummary(e.target.value)}
        />
      </label>

      <div className="propose__row">
        <div className="propose__field propose__field--wide">
          <span className="propose__label">Signers</span>
          <div className="propose__signers">
            {policy.signerKeys.map(k => {
              const s = SIGNERS[k];
              const on = selectedSigners.includes(k);
              return (
                <label key={k} className={`signer-chip ${on ? "is-on" : ""}`}>
                  <input type="checkbox" checked={on} onChange={() => toggle(k)} />
                  <SignerAvatar k={k} size={20} />
                  <span className="signer-chip__role">{s.role}</span>
                  <span className="signer-chip__addr">{s.addr}</span>
                </label>
              );
            })}
          </div>
        </div>

        <div className="propose__field">
          <span className="propose__label">Effective date</span>
          <input
            type="date"
            className="propose__input"
            value={effDate}
            onChange={e => setEffDate(e.target.value)}
          />
        </div>
      </div>

      <div className="propose__foot">
        <span className="propose__readiness mono">
          {selectedSigners.length} of {policy.signersReq} required signers selected
        </span>
        <div className="propose__actions">
          <button className="btn btn--ghost" onClick={onCancel}>Cancel</button>
          <button
            className="btn btn--primary"
            disabled={!enough}
            title={enough ? "" : "Select enough signers and write a summary"}
          >
            Sign & propose
          </button>
        </div>
      </div>

      <p className="propose__caveat">
        A proposal becomes active only after every required signer attests.
        This UI does not apply rules directly — it queues a revision for the approval chain.
      </p>
    </div>
  );
}

// ---------- Detail drawer ----------
function DetailDrawer({ policy, onClose }) {
  const [selectedRev, setSelectedRev] = useState(policy.revision);
  const [mode, setMode] = useState("detail"); // detail | propose
  const [diffOpen, setDiffOpen] = useState(false);

  useEffect(() => {
    setSelectedRev(policy.revision);
    setMode("detail");
    setDiffOpen(false);
  }, [policy.id]);

  const activeRule = policy.rule[`v${policy.revision}`];
  const selectedRule = policy.rule[`v${selectedRev}`];

  return (
    <div className="drawer" role="dialog" aria-label={`Policy ${policy.tag}`}>
      <div className="drawer__scrim" onClick={onClose}></div>
      <aside className="drawer__panel">
        <header className="drawer__head">
          <div className="drawer__head-l">
            <span className="eyebrow eyebrow--sage">Policy</span>
            <div className="drawer__title-row">
              <span className="mono drawer__tag">{policy.tag}</span>
              <SeverityPill severity={policy.severity} />
              <span className="drawer__rev mono">rev {policy.revision}</span>
            </div>
          </div>
          <div className="drawer__head-r">
            <StatePill state={policy.state} />
            <button className="drawer__x" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </header>

        <div className="drawer__body">
          {mode === "detail" && (
            <>
              {/* Scope block */}
              <section className="drawer__sec">
                <h4 className="drawer__sec-title">Scope</h4>
                <div className="scope-grid">
                  <div className="scope-cell">
                    <span className="scope-cell__label">Gates</span>
                    <span className="scope-cell__val">{policy.gates}</span>
                  </div>
                  <div className="scope-cell">
                    <span className="scope-cell__label">Rooms</span>
                    <span className="scope-cell__val mono">
                      {policy.rooms.join("  ·  ")}
                    </span>
                  </div>
                  <div className="scope-cell">
                    <span className="scope-cell__label">Verifier handler</span>
                    <span className="scope-cell__val mono">{policy.handler}</span>
                  </div>
                </div>
              </section>

              {/* Current rule card */}
              <section className="drawer__sec">
                <h4 className="drawer__sec-title">
                  Current rule
                  <span className="drawer__sec-meta mono">v{policy.revision} · active</span>
                </h4>
                <pre className="rule-block">
{activeRule.split("\n").map((line, i) => (
  <div key={i} className="rule-line">
    <span className="rule-gutter">{String(i + 1).padStart(2, "0")}</span>
    <span className="rule-text">{syntaxTint(line)}</span>
  </div>
))}
                </pre>
              </section>

              {/* Approval chain */}
              <section className="drawer__sec">
                <h4 className="drawer__sec-title">
                  Approval chain
                  <span className="drawer__sec-meta mono">
                    rev v{policy.revision} · {policy.approvals.filter(a=>a.state==="signed").length}/{policy.signersTotal} signed
                  </span>
                </h4>
                <ApprovalChain approvals={policy.approvals} />
              </section>

              {/* Revision history */}
              <section className="drawer__sec">
                <h4 className="drawer__sec-title">
                  Revision history
                  <span className="drawer__sec-meta mono">{policy.history.length} revisions</span>
                </h4>
                <ol className="rev-list">
                  {policy.history.map(h => {
                    const isSelected = h.rev === selectedRev;
                    const isActive = h.active;
                    return (
                      <li key={h.rev} className={`rev ${isActive ? "is-active" : ""} ${isSelected ? "is-selected" : ""}`}>
                        <span className="rev__dot"></span>
                        <div className="rev__body">
                          <div className="rev__line1">
                            <span className="mono rev__num">v{h.rev}</span>
                            {isActive && <span className="rev__tag rev__tag--active">active</span>}
                            <span className="rev__author">
                              <SignerAvatar k={h.author} size={16} />
                              <span className="mono">{SIGNERS[h.author].addr.slice(0,6)}…</span>
                            </span>
                            <span className="rev__date mono">{h.at}</span>
                          </div>
                          <div className="rev__summary">{h.summary}</div>
                          {h.rev !== policy.revision && (
                            <button
                              className="rev__diff"
                              onClick={() => { setSelectedRev(h.rev); setDiffOpen(true); }}
                            >
                              view diff →
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </section>

              {/* Diff viewer */}
              {diffOpen && selectedRev !== policy.revision && selectedRule && (
                <section className="drawer__sec">
                  <h4 className="drawer__sec-title">
                    Diff · v{selectedRev} → v{policy.revision}
                    <button className="drawer__sec-x" onClick={() => setDiffOpen(false)}>close</button>
                  </h4>
                  <DiffView
                    prev={selectedRule}
                    next={activeRule}
                    prevLabel={`v${selectedRev}`}
                    nextLabel={`v${policy.revision} (active)`}
                  />
                </section>
              )}

              {/* Attached jobs */}
              <section className="drawer__sec">
                <h4 className="drawer__sec-title">
                  Attached jobs
                  <span className="drawer__sec-meta mono">
                    {policy.attachedJobs.length} active · /runs
                  </span>
                </h4>
                {policy.attachedJobs.length === 0 ? (
                  <p className="drawer__empty">No active jobs currently guarded by this policy.</p>
                ) : (
                  <ul className="jobs">
                    {policy.attachedJobs.map(j => (
                      <li key={j.id} className="job">
                        <span className="mono job__id">{j.id}</span>
                        <span className="job__title">{j.title}</span>
                        <span className="mono job__at">{j.at}</span>
                        <span className="job__link">/runs →</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Propose CTA */}
              {policy.state !== "Retired" && (
                <div className="drawer__cta">
                  <button className="btn btn--primary btn--lg" onClick={() => setMode("propose")}>
                    ＋ Propose change
                  </button>
                  <span className="drawer__cta-note">
                    Drafts a <span className="mono">v{policy.revision + 1}</span> revision and opens the approval chain. No instant apply.
                  </span>
                </div>
              )}
            </>
          )}

          {mode === "propose" && (
            <ProposeForm policy={policy} onCancel={() => setMode("detail")} />
          )}
        </div>
      </aside>
    </div>
  );
}

// Tint JSON-like lines with accent colors (read-only display).
function syntaxTint(line) {
  const parts = [];
  // comment
  if (line.trim().startsWith("//") || line.trim().startsWith("#")) {
    return <span style={{ color: "#9bd7b5" }}>{line}</span>;
  }
  // key: value pattern
  const re = /("[^"]+")(\s*:\s*)("[^"]*"|\d+(?:\.\d+)?|true|false|null|\[[^\]]*\])?/g;
  let last = 0, m;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) parts.push(line.slice(last, m.index));
    parts.push(<span key={`k${m.index}`} style={{ color: "#f4c989" }}>{m[1]}</span>);
    parts.push(m[2]);
    if (m[3]) {
      const v = m[3];
      const col = /^".*"$/.test(v) ? "#9bd7b5"
                : /^(true|false|null)$/.test(v) ? "#e38a8a"
                : /^\[/.test(v) ? "#d2c1f0"
                : "#b5d9ff";
      parts.push(<span key={`v${m.index}`} style={{ color: col }}>{v}</span>);
    }
    last = m.index + m[0].length;
  }
  if (last < line.length) parts.push(line.slice(last));
  return parts.length ? parts : line;
}

Object.assign(window, {
  SeverityPill, StatePill, ScopePill, SignerAvatar, SignerAvatars,
  DetailDrawer, DiffView, ApprovalChain, ProposeForm, computeDiff, syntaxTint,
});
