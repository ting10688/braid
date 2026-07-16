# Roadmap

## Phase 1: Deterministic repository analysis — complete

Scan TypeScript repositories, model imports and modules, detect cycles, calculate explainable metrics,
and persist validated deterministic snapshots.

## Phase 2: Migration proposal generation — complete

Generate deterministic evidence-backed proposals with explainable risk, reversibility, impact certainty,
stable identity, ranking, persistence, and source-safety guards.

### Phase 2.1: Proposal precision improvements — complete

Classify root files, package entrypoints, and barrels explicitly; group cycle actions by deterministic
SCC root cause; retain one ranked primary with typed alternatives; and suppress equivalent or subsumed
cycle actions. The reviewed real-world comparison preserves recall and reduces false positives.

## Phase 3: Safe isolated migration execution — complete

Execute explicitly approved low-risk extractions through bounded Codex in owned external worktrees;
enforce Git scope, trusted validation, architecture comparison, main-checkout integrity, portable records,
one local candidate commit, and ownership-safe discard. Automatic merge/push, rollback, and
`break-cycle` execution remain excluded.

### Phase 3.1: Execution readiness and symbol closure — complete

Resolve declaration dependencies before executor launch; classify primary, companion, retained,
external, and unresolved symbols; predict reverse imports and cycles; enforce file, symbol, and
protected-surface budgets; and reject incomplete approvals before any execution resource is created.

### Phase 3.2: Deterministic proposal repair suggestions — complete

Turn a readiness rejection into a deterministic advisory explanation of the smallest supported
`approvedCompanionSymbols` additions. Classify suggestions as `actionable`, `partial`, or `unavailable`,
re-evaluate proposed additions in memory, and require a separately stored and explicitly approved
revised proposal before execution. Automatic mutation, persistence, approval, execution, and
architectural redesign remain excluded.

## Phase 4: Direct rollback and recovery hardening — next

Add direct, auditable rollback after dependent-migration modeling and extend interrupted-run recovery.

## Phase 5: Growth Mode feature impact analysis

Analyze requested features before implementation and identify prerequisite architecture migrations.

## Phase 6: Migration dependency graph and reverse migrations

Model migration ordering, feature dependencies, and explicit reverse migrations for complex evolution.

## Benchmark roadmap

These milestones describe evaluator coverage and are distinct from product execution phases.

- Benchmark A: Proposal quality and determinism — complete
- Benchmark B: Static before/after comparison — complete
- Benchmark C: Downstream feature change cost — scaffolded
- Benchmark D: Migration rollback validation — scaffolded
- Phase 3 deterministic migration execution — complete (`phase-3-execution@1.0.0`)
- Phase 3.1 execution readiness — complete (`phase-3-1-readiness@1.0.0`)
- Phase 3.2 proposal repair suggestions — complete (`phase-3-2-proposal-repair-suggestions@1.0.0`)
- Real-world repository suite — complete (`real-world-phase-2`, Consola and tslog)
- Real-world-guided proposal precision (module-boundary classification and duplicate cycle actions) — complete
