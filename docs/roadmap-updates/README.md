# Roadmap Update Fragments

`docs/PROJECT_ROADMAP.md` is the canonical project roadmap. This folder is the
low-conflict intake lane for parallel agents to propose status changes,
evidence, blockers, or next actions without rewriting the roadmap at the same
time.

Use a fragment when:

- another PR is already editing the same roadmap section;
- the work is research, audit, design, or operator evidence rather than the
  implementing code PR;
- the update affects several sections and needs steward consolidation;
- you are unsure whether the item is ready to move status.

An implementing PR may edit the exact roadmap row it owns directly when the
change is narrow and evidence is included.

## File Naming

Use:

```text
docs/roadmap-updates/YYYY-MM-DD-<agent>-<roadmap-item>.md
```

Examples:

```text
docs/roadmap-updates/2026-05-19-codex-metrics-auth.md
docs/roadmap-updates/2026-05-19-design-agent-timeline-filters.md
```

## Fragment Template

```md
# Roadmap Update: <item title or stable ID>

- **Date:** YYYY-MM-DD
- **Agent:** <agent name / branch>
- **Roadmap section:** <section heading in PROJECT_ROADMAP.md>
- **Item:** <exact row title or proposed new item>
- **Related PRs/issues:** <links or `none`>
- **Proposed status:** Open | In progress | Blocked | Ready for proof | Done | Proofed | Deferred
- **Owner:** <who should act next>

## Summary

<One short paragraph explaining what changed or was learned.>

## Evidence

- <PR, CI, hosted smoke, chain tx, operator report, docs MCP finding, or runtime evidence>

## Blockers Or Caveats

- <Anything preventing Done/Proofed, or `none`>

## Requested Roadmap Change

<Exact row edit, new row, status change, or note the steward should apply.>
```

## Rules

- Do not mark an item `Done` unless the relevant PR is merged or the current
  branch is the implementing PR and CI/checks prove the behavior.
- Do not mark an item `Proofed` without hosted smoke, real workflow, chain
  transaction, or durable operator evidence.
- Chain-specific claims must cite Polkadot docs MCP findings, runtime state, or
  transaction evidence.
- Keep fragments scoped to one roadmap item or one clearly named section.
- Avoid broad rewording of `PROJECT_ROADMAP.md` from worker-agent PRs.
- If your PR changes production behavior, include the required secret/env/VPS
  follow-up before asking the steward to close the item.

## Pasteable Agent Instruction

Give this to any agent working on Averray:

```text
You are working in the averray-agent/agent repo with multiple parallel agents.

Before changing roadmap status:
1. Read AGENTS.md, docs/PROJECT_ROADMAP.md, and docs/roadmap-updates/README.md.
2. Own one narrow roadmap item or section only.
3. Do not broad-rewrite docs/PROJECT_ROADMAP.md.
4. If your implementing PR clearly closes or moves one exact roadmap row, update
   only that row and include evidence in the PR body.
5. If your work is research, audit, design, operator proof, or overlaps another
   roadmap PR, create a fragment under docs/roadmap-updates/ using the template.
6. Use only these statuses: Open, In progress, Blocked, Ready for proof, Done,
   Proofed, Deferred.
7. Never mark Done without merged/merge-ready implementation evidence and
   passing checks. Never mark Proofed without hosted, chain, workflow, or
   durable operator evidence.
8. For Polkadot-specific claims, verify against Polkadot docs MCP, runtime
   state, or transaction evidence before adding them to the roadmap.
9. Keep your PR narrow and list any roadmap row or fragment you touched.
```

## Steward Consolidation

The roadmap steward periodically:

1. Reviews open fragments in this folder.
2. Applies accepted changes to `docs/PROJECT_ROADMAP.md`.
3. Keeps rejected or superseded fragments only if they contain useful audit
   evidence.
4. Deletes consumed fragments when their evidence is fully represented in the
   canonical roadmap or linked detail docs.
