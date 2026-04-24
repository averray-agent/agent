/* global React, policies, SIGNERS, AGG_ACTIVE, AGG_PENDING, AGG_RETIRED, AGG_REVISIONS_30D, SPARK_30D,
          SeverityPill, StatePill, ScopePill, SignerAvatars, DetailDrawer */
const { useState, useMemo, useEffect, useRef } = React;

// ---------- Topbar clock + block counter ----------
function LiveClock() {
  const [now, setNow] = useState(() => new Date());
  const [block, setBlock] = useState(28_419_304);
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    const b = setInterval(() => setBlock(n => n + 1), 6000); // ~6s block time
    return () => { clearInterval(t); clearInterval(b); };
  }, []);
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  const ss = String(now.getUTCSeconds()).padStart(2, "0");
  return (
    <span className="live">
      <span className="live__dot"></span>
      <span className="mono live__time">{hh}:{mm}:{ss} UTC</span>
      <span className="live__sep">·</span>
      <span className="mono live__block">#{block.toLocaleString()}</span>
    </span>
  );
}

// ---------- Aggregate cards ----------
function Sparkline({ data, w = 120, h = 32 }) {
  const max = Math.max(...data, 1);
  const step = w / (data.length - 1);
  const pts = data.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 4) - 2).toFixed(1)}`).join(" ");
  return (
    <svg className="spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <polyline fill="none" stroke="var(--avy-accent)" strokeWidth="1.5" points={pts} />
      <circle cx={(data.length - 1) * step} cy={h - (data[data.length-1] / max) * (h - 4) - 2}
              r="2.5" fill="var(--avy-accent)" />
    </svg>
  );
}

function AggregateStrip() {
  return (
    <div className="agg">
      <div className="agg__card">
        <span className="eyebrow eyebrow--sage">Active policies</span>
        <span className="agg__val">{AGG_ACTIVE}</span>
        <span className="agg__meta mono">gating · hard-stop · advisory</span>
      </div>
      <div className={`agg__card ${AGG_PENDING > 0 ? "is-warn" : ""}`}>
        <span className="eyebrow eyebrow--amber">Pending proposals</span>
        <span className="agg__val">
          {AGG_PENDING}
          {AGG_PENDING > 0 && <span className="agg__pulse"></span>}
        </span>
        <span className="agg__meta mono">
          {AGG_PENDING > 0 ? "awaiting signers · your queue" : "queue clear"}
        </span>
      </div>
      <div className="agg__card">
        <span className="eyebrow eyebrow--sage">Revisions · 30d</span>
        <div className="agg__row">
          <span className="agg__val">{AGG_REVISIONS_30D}</span>
          <Sparkline data={SPARK_30D} />
        </div>
        <span className="agg__meta mono">policy churn · last 30 days</span>
      </div>
      <div className="agg__card">
        <span className="eyebrow eyebrow--sage">Signer quorum</span>
        <div className="agg__quorum">
          <span className="agg__val">2 of 3</span>
          <span className="tier-chip">default</span>
        </div>
        <span className="agg__meta mono">co-sign/quorum-2-of-3@v2</span>
      </div>
    </div>
  );
}

// ---------- Filter rail ----------
const SCOPES     = ["all", "claim", "settle", "xcm", "badge", "co-sign", "worker", "treasury"];
const STATUSES   = ["all", "active", "draft", "pending-signers", "retired"];
const SEVERITIES = ["all", "advisory", "gating", "hard-stop"];

function FilterRail({ filters, setFilters }) {
  const searchRef = useRef(null);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "/" && document.activeElement !== searchRef.current) {
        e.preventDefault();
        searchRef.current?.focus();
      }
      if (e.key === "Escape" && document.activeElement === searchRef.current) {
        searchRef.current.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const chip = (group, val, label) => (
    <button
      key={val}
      className={`chip ${filters[group] === val ? "is-on" : ""}`}
      onClick={() => setFilters(f => ({ ...f, [group]: val }))}
    >
      {label || val}
    </button>
  );

  return (
    <div className="filters">
      <div className="filters__row">
        <span className="filters__label">Scope</span>
        <div className="chip-group">{SCOPES.map(s => chip("scope", s))}</div>
      </div>
      <div className="filters__row">
        <span className="filters__label">Status</span>
        <div className="chip-group">{STATUSES.map(s => chip("status", s))}</div>
      </div>
      <div className="filters__row">
        <span className="filters__label">Severity</span>
        <div className="chip-group">{SEVERITIES.map(s => chip("severity", s))}</div>
      </div>
      <div className="filters__row filters__row--search">
        <div className="search-input">
          <span className="search-input__glyph">⌕</span>
          <input
            ref={searchRef}
            className="search-input__field"
            placeholder="Filter by tag, scope, signer, revision…"
            value={filters.q}
            onChange={e => setFilters(f => ({ ...f, q: e.target.value }))}
          />
          <span className="search-input__kbd">/</span>
        </div>
      </div>
    </div>
  );
}

// ---------- Policy table ----------
function relativeTime(iso) {
  // Accept "2026-04-19 11:04 UTC"
  const m = iso.match(/(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2}))?/);
  if (!m) return iso;
  const [, y, mo, d, hh = "00", mm = "00"] = m;
  const then = Date.UTC(+y, +mo - 1, +d, +hh, +mm);
  const diff = (Date.now() - then) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400 / 7)}w ago`;
  return `${Math.floor(diff / 86400 / 30)}mo ago`;
}

function PolicyTable({ rows, onPick, picked }) {
  return (
    <div className="panel">
      <div className="panel__head">
        <h3 className="panel__title">All policies</h3>
        <span className="panel__sub mono">sorted by last change · newest first</span>
      </div>
      <div className="tbl-scroll">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: "22%" }}>Tag</th>
              <th style={{ width: "8%"  }}>Scope</th>
              <th style={{ width: "10%" }}>Severity</th>
              <th style={{ width: "14%" }}>Signers</th>
              <th style={{ width: "10%" }}>Active since</th>
              <th>Last change</th>
              <th style={{ width: "10%" }}>State</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(p => (
              <tr
                key={p.id}
                className={`row ${picked?.id === p.id ? "is-picked" : ""}`}
                onClick={() => onPick(p)}
              >
                <td>
                  <span className="row__tag mono">{p.tag}</span>
                </td>
                <td><ScopePill label={p.scopeLabel} /></td>
                <td><SeverityPill severity={p.severity} /></td>
                <td>
                  <div className="signers-cell">
                    <span className="mono signers-cell__count">{p.signersReq} of {p.signersTotal}</span>
                    <SignerAvatars keys={p.signerKeys} approvals={p.approvals} />
                  </div>
                </td>
                <td className="mono muted">
                  {p.activeSince || <span className="dim">—</span>}
                </td>
                <td>
                  <div className="change-cell">
                    <span className="change-cell__text">{p.lastChange.text}</span>
                    <span className="change-cell__meta mono">
                      <SignerAvatar k={p.lastChange.author} size={14} />
                      {SIGNERS[p.lastChange.author].addr.slice(0, 6)}… · {relativeTime(p.lastChange.at)}
                    </span>
                  </div>
                </td>
                <td><StatePill state={p.state} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// Re-use the single-avatar primitive (imported via window globals)
function SignerAvatar(props) { return window.SignerAvatar(props); }

// ---------- Legend cards ----------
function Legend() {
  return (
    <div className="legend">
      <div className="legend__card">
        <span className="eyebrow eyebrow--sage">Scope</span>
        <h4 className="legend__title">Which surface a policy gates</h4>
        <ul className="legend__list">
          <li><span className="mono">claim</span> — auto-claim gates on run output</li>
          <li><span className="mono">settle</span> — releasing DOT from vaults</li>
          <li><span className="mono">xcm</span> — outbound cross-chain messages</li>
          <li><span className="mono">badge</span> — reputation mint & revoke</li>
          <li><span className="mono">co-sign</span> — default signer quorums</li>
          <li><span className="mono">worker</span> — stake & wallet separation</li>
          <li><span className="mono">treasury</span> — budget, reserve, report</li>
        </ul>
      </div>
      <div className="legend__card">
        <span className="eyebrow eyebrow--sage">Severity</span>
        <h4 className="legend__title">What happens when the rule fails</h4>
        <ul className="legend__list legend__list--sev">
          <li><SeverityPill severity="advisory" /><span>recorded on the receipt, no blocking</span></li>
          <li><SeverityPill severity="gating" /><span>claim is paused, requires manual pass</span></li>
          <li><SeverityPill severity="hard-stop" /><span>action refused, logged, no override</span></li>
        </ul>
      </div>
      <div className="legend__card">
        <span className="eyebrow eyebrow--sage">Quorum</span>
        <h4 className="legend__title">How many signers are required</h4>
        <ul className="legend__list">
          <li><b>2 of 3</b> — default for claim, xcm fee cap, badge mint</li>
          <li><b>3 of 3</b> — unanimous; required for all hard-stop changes</li>
          <li>Signers are operator wallets listed in <span className="mono">co-sign/quorum-2-of-3</span>.</li>
          <li>Proposals without enough signatures stay in <span className="mono">pending-signers</span>. No instant apply.</li>
        </ul>
      </div>
    </div>
  );
}

// ---------- Main app ----------
function App() {
  const [filters, setFilters] = useState({ scope: "all", status: "all", severity: "all", q: "" });
  const [picked, setPicked] = useState(null);

  const filtered = useMemo(() => {
    return policies.filter(p => {
      if (filters.scope !== "all" && p.scope !== filters.scope) return false;
      if (filters.status !== "all") {
        const stateMap = {
          "active": "Active", "draft": "Draft",
          "pending-signers": "Pending", "retired": "Retired",
        };
        if (p.state !== stateMap[filters.status]) return false;
      }
      if (filters.severity !== "all" && p.severity !== filters.severity) return false;
      if (filters.q.trim()) {
        const q = filters.q.toLowerCase();
        const hay = [
          p.tag, p.scope, p.severity, p.gates, p.handler,
          `v${p.revision}`, p.lastChange.text,
          ...p.signerKeys.map(k => SIGNERS[k].addr),
        ].join(" ").toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [filters]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && picked) setPicked(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picked]);

  return (
    <div className="ws">
      {/* Topbar */}
      <header className="topbar">
        <div className="topbar__l">
          <div className="crumbs">
            <span>Governance</span>
            <span className="crumbs__slash">/</span>
            <span className="cur">Policies</span>
          </div>
          <LiveClock />
        </div>
        <div className="topbar__actions">
          <button className="btn btn--ghost">⤓ Export policy bundle</button>
          <button className="btn btn--primary">＋ Propose new policy</button>
        </div>
      </header>

      {/* Header */}
      <section className="header">
        <span className="eyebrow eyebrow--sage">Rule surface</span>
        <h1 className="header__h1">Policies</h1>
        <p className="header__lede">
          Every action is gated by a policy — every change is signed.
        </p>
      </section>

      {/* Aggregates */}
      <AggregateStrip />

      {/* Filters */}
      <FilterRail filters={filters} setFilters={setFilters} />

      {/* Table */}
      <PolicyTable rows={filtered} onPick={setPicked} picked={picked} />

      {/* Legend */}
      <section className="legend-wrap">
        <span className="eyebrow eyebrow--sage legend-wrap__eyebrow">How policies work</span>
        <Legend />
      </section>

      {/* Footer */}
      <footer className="tfoot">
        <span className="tfoot__l mono">
          Showing <b>{filtered.length}</b> of {policies.length} · {filters.status === "all" ? "all policies" : filters.status.replace("-", " ")}
        </span>
        <a className="tfoot__r mono" href="#">
          Import from <span className="tfoot__path">/schemas/policies</span> →
        </a>
      </footer>

      {/* Drawer */}
      {picked && <DetailDrawer policy={picked} onClose={() => setPicked(null)} />}
    </div>
  );
}

Object.assign(window, { App, LiveClock, AggregateStrip, FilterRail, PolicyTable, Legend });
