# Roadmap

## Phase 1: Deterministic repository analysis — current

Scan TypeScript repositories, model imports and modules, detect cycles, calculate explainable metrics,
and persist validated deterministic snapshots.

## Phase 2: Migration proposal generation

Generate small evidence-backed proposals from snapshots, with explicit affected files and dependencies.

## Phase 3: Codex migration execution in Git worktrees

Execute approved migrations through Codex in isolated worktrees without contaminating read-only analysis.

## Phase 4: Validation and direct rollback

Validate behavior and architecture after each migration and provide a direct, auditable rollback path.

## Phase 5: Growth Mode feature impact analysis

Analyze requested features before implementation and identify prerequisite architecture migrations.

## Phase 6: Migration dependency graph and reverse migrations

Model migration ordering, feature dependencies, and explicit reverse migrations for complex evolution.
