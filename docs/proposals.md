# Migration proposals

Phase 2 turns validated architecture facts into planning records. It does not edit source, execute a
migration, call a model, create a worktree, or execute rollback.

## Break cycle

A candidate starts from each canonical module cycle. Braid groups file imports by module edge and picks
the lowest-coupling edge by importing-file count, import count, public-entrypoint involvement,
protected-path involvement, then lexical edge order. Removing that module edge is simulated against the
same adjacency graph, so the circular-dependency delta is exact for the snapshot.

The suggested strategy is deterministic: contract/type paths prefer `move-shared-contract`, a direct
reverse dependency prefers `dependency-inversion`, and other cycles use `introduce-boundary`. This is the
smallest strategy supported by static evidence, not a claim of architectural optimality. Type-only
imports and runtime coupling are not distinguished, so both false positives and missed runtime cycles
remain possible.

## Extract module

Candidates must exceed `oversized_file_lines`, contain declaration facts, and not be tests, declaration
files, generated files, or index barrels. Names are split across camelCase, PascalCase, snake_case, and
punctuation; generic action and role words are removed. Braid selects one bounded shared-token cluster
per file, preferring internal symbol references and smaller coherent groups. The destination name is the
dominant identifier token.

Evidence includes the threshold violation, selected symbols, shared token, references, and any public,
protected, or oversized-module involvement. Exact caller rewrites are unavailable, so line-threshold
impact is estimated and import/public API deltas remain unknown. Identifier-only clustering may group
similarly named but unrelated symbols or miss concepts whose names share no meaningful token.

## Risk and reversibility

Risk is the sum of visible typed factors: more than 5 files (+1), more than 10 additional points (+2),
more than 2 modules (+1), a public entrypoint (+2), a protected path (+5), a cycle longer than 2 modules
(+1), low confidence (+1), or a strategy that may require a public contract (+1). Totals 0–1 are low,
2–4 medium, and 5 or more high. Protected-path proposals are therefore always high risk. High-risk
proposals remain visible unless `include_high_risk` is false.

Reversibility is easy for a bounded single-module extraction, conditional for public or multi-module
changes, and difficult for protected paths or broad file/module sets. Every proposal includes a textual
rollback strategy, but Phase 2 never executes it.

## Identity, ranking, and persistence

IDs use `P-EM-<hash>` or `P-BC-<hash>` and exclude timestamps, absolute roots, random values, and input
enumeration order. Ranking compares graph/constraint severity, evidence confidence, expected benefit,
risk penalty, affected-file count, type, and ID. The first item is the recommended first candidate, not
the universally correct architecture decision.

Proposal JSON is validated and written atomically to `.braid/state/proposals/<id>.json`. Identical
content is idempotent; repeated unchanged fresh snapshots reuse the same proposal while preserving the
original stored snapshot lineage. A same-ID proposal with materially different content is rejected.
