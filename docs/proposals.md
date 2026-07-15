# Migration proposals

Phase 2 turns validated architecture facts into planning records. It does not edit source, execute a
migration, call a model, create a worktree, or execute rollback.

## Break cycle

A candidate starts from each deterministic strongly connected component (SCC), not from every simple
cycle traversal. Its `CR-<hash>` root-cause signature covers the canonical SCC module set, relevant
internal module edges, normalized participating files, snapshot configuration/commit identity, and
planner version. Every technically plausible module-edge removal is simulated against the same graph.
The primary action is selected by exact cycle reduction, smaller affected scope, lower coupling, no
public or protected surface, lower risk, easier reversal, and finally stable edge identity.

Other unique actions remain typed `alternatives` on that primary. They carry their own strategy, edge,
scope, evidence, expected impact, risk, and reversibility, but do not compete in top-level ranking. An
exact edge/strategy duplicate is removed; a broader action with the same effective target is removed
when a narrower action subsumes it. Same titles never establish equivalence, and separate root-cause
signatures remain separate proposals even if their prose or files overlap.

The suggested strategy is deterministic: contract/type paths prefer `move-shared-contract`, a direct
reverse dependency prefers `dependency-inversion`, and other cycles use `introduce-boundary`. This is the
smallest strategy supported by static evidence, not a claim of architectural optimality. Syntactic
type-only imports are recorded, but cycle planning conservatively retains them because static type facts
alone do not establish runtime coupling. Both false positives and missed runtime cycles remain possible.

## Extract module

Candidates must exceed `oversized_file_lines`, contain declaration facts, and not be tests, declaration
files, generated files, entrypoints, barrels, or index files. Names are split across camelCase,
PascalCase, snake_case, and punctuation; generic action and role words are removed. A candidate also
needs a sufficiently specific shared token, connected internal references, runtime declarations, and a
bounded declaration span; a class that dominates its file is not treated as a hidden submodule. Braid
selects one cluster per file, preferring internal symbol references and smaller coherent groups. The
destination name is the dominant identifier token.

Evidence includes the threshold violation, selected symbols, shared token, references, and any public,
protected, or oversized-module involvement. Exact caller rewrites are unavailable, so line-threshold
impact is estimated and import/public API deltas remain unknown. Identifier-only clustering may group
similarly named but unrelated symbols or miss concepts whose names share no meaningful token.

## Risk and reversibility

Risk is the sum of visible typed factors: more than 5 files (+1), more than 10 additional points (+2),
more than 2 modules (+1), a public entrypoint (+2), an entrypoint/barrel module surface (+1), a protected
path (+5), a cycle longer than 2 modules (+1), low confidence (+1), or a strategy that may require a
public contract (+1). Totals 0–1 are low,
2–4 medium, and 5 or more high. Protected-path proposals are therefore always high risk. High-risk
proposals remain visible unless `include_high_risk` is false.

Reversibility is easy for a bounded single-module extraction, conditional for public or multi-module
changes, and difficult for protected paths or broad file/module sets. Every proposal includes a textual
rollback strategy, but Phase 2 never executes it.

## Identity, ranking, and persistence

IDs use `P-EM-<hash>` or `P-BC-<hash>` and exclude timestamps, absolute roots, random values, and input
enumeration order. Planner version `0.2.1` deliberately changes cycle identity when root grouping,
primary action, or typed alternatives change. Ranking compares graph/constraint severity, evidence
confidence, expected benefit, risk penalty, affected-file count, type, and ID. Alternatives are absent
from this top-level competition. The first item is the recommended first candidate, not the universally
correct architecture decision.

Proposal JSON is validated and written atomically to `.braid/state/proposals/<id>.json`. Identical
content is idempotent; repeated unchanged fresh snapshots reuse the same proposal while preserving the
original stored snapshot lineage. A same-ID proposal with materially different content is rejected.
