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

## Phase 3: Codex migration execution in Git worktrees — next

Execute approved migrations through Codex in isolated worktrees without contaminating read-only analysis.

## Phase 4: Validation and direct rollback

Validate behavior and architecture after each migration and provide a direct, auditable rollback path.

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
- Real-world repository suite — complete (`real-world-phase-2`, Consola and tslog)
- Real-world-guided proposal precision (module-boundary classification and duplicate cycle actions) — complete
