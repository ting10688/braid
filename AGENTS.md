## Scope, Review, and Closure Policy

Braid tasks are outcome-bounded. Completing a task does not require eliminating every theoretical weakness or implementing every improvement discovered during review.

These rules apply regardless of model, reasoning level, or whether subagents are used.

### Source of truth

The current task specification defines:

- authorized outcomes;
- accepted scope;
- threat-model boundaries;
- required validation;
- definition of done.

A review finding does not automatically expand the task.

The lead agent must classify every newly discovered concern as one of:

- `blocker`
- `deferred`
- `out-of-scope`
- `duplicate`

Only blockers authorize additional implementation work.

### Blocker threshold

A finding is a blocker only when it is reproducible and can cause at least one of the following:

- an unsafe migration or proposal is accepted;
- the main checkout or user-owned source is modified unexpectedly;
- an unauthorized file, dependency, public API, or protected path change is accepted;
- validated content differs from the generated patch, artifact, execution record, or candidate commit;
- a terminal success record is materially false;
- an existing public CLI, schema, benchmark, baseline, compatibility contract, or safety invariant regresses;
- required build, typecheck, test, or benchmark validation fails.

A blocker report must include:

1. the violated requirement or invariant;
2. a deterministic reproduction or failing test;
3. the practical consequence;
4. the smallest reasonable fix.

Concerns without a deterministic reproduction must not trigger production-code changes. Record them as known limitations or deferred work.

### Threat-model boundary

Unless a task explicitly expands the threat model, assume:

- the repository owner is trusted;
- Braid configuration is trusted;
- configured validation commands and package scripts are trusted;
- the operating system, Git executable, Node runtime, and filesystem are trusted;
- users are not deliberately tampering with Git internals during execution.

The following are normally out of scope:

- hostile repositories designed to attack Braid;
- malicious Git hooks;
- intentional daemonization or process-group escape;
- direct manipulation of reflogs, worktree registries, refs, indexes, or Git configuration by an adversary;
- operating-system or filesystem compromise;
- credential theft outside Braid-controlled artifacts;
- defenses that require a new security subsystem unrelated to the current milestone.

Document these risks when relevant, but do not implement defenses unless the task explicitly requires them or a reproducible in-scope failure demonstrates their necessity.

### Review budget

For a main Phase, use at most:

- one architecture review pass;
- one safety and correctness review pass;
- one focused verification pass after blocker fixes.

Review agents are advisory. They may identify findings but may not:

- redefine the task;
- add new acceptance criteria;
- expand the threat model;
- create new required subsystems;
- declare a theoretical concern to be a blocker without evidence.

After blocker fixes, verification must be limited to confirming those fixes and rerunning the specified validation. Do not start another unrestricted audit.

### Subagent rules

Subagents must receive:

- one clearly bounded workstream;
- explicit file ownership;
- relevant interfaces and invariants;
- a stated output format.

Subagents must not:

- modify files owned by another workstream;
- perform unrelated repository-wide refactors;
- create, switch, merge, delete, tag, or push Git branches;
- manage production worktrees;
- create commits;
- run the full validation suite unless explicitly assigned;
- turn optional hardening into required scope;
- continue searching for additional weaknesses after their assignment is complete.

Subagents should return:

- files inspected;
- files changed;
- assumptions;
- discovered conflicts;
- reproducible blockers;
- deferred concerns;
- integration notes.

The lead agent alone owns cross-package architecture, public API decisions, Git state, full validation, commits, merges, tags, releases, and pushes.

### Change budget

Do not introduce any of the following unless explicitly required by the task:

- a new workspace package;
- a new production dependency;
- a new persistence format or schema version;
- a new public API;
- a new CLI command family;
- a new security or orchestration subsystem;
- unrelated cleanup or refactoring.

When addressing a finding would require a substantial new abstraction, defer it to a separate milestone unless it is necessary to fix a reproducible blocker.

Prefer the smallest change that restores the violated invariant.

### Benchmark and baseline policy

Do not modify expectations, fixture hashes, regression policies, or tracked baselines merely to make validation pass.

A benchmark or baseline may change only when:

- the tested semantics intentionally changed;
- the version is incremented appropriately;
- the previous baseline is preserved where required;
- the comparison report explains the compatibility impact.

Timing-only warnings on uncontrolled machines are not blockers unless the task explicitly defines them as blocking.

### Closure mode

Enter closure mode when:

- all required outcomes are implemented;
- all reproducible in-scope blockers are resolved;
- required tests and benchmarks pass.

In closure mode:

- do not launch new broad reviews;
- do not search for theoretical weaknesses;
- do not add optional hardening;
- do not refactor unrelated code;
- make changes only in response to a failing required validation command;
- run the specified final validation;
- document known limitations;
- create the requested commits;
- stop.

A successful final validation is a terminal condition, not an invitation for another audit.

### Terminal states

Every task must end in exactly one state:

- `completed`  
  All required outcomes and validation passed.

- `completed-with-known-limitations`  
  All required outcomes passed; remaining concerns are out of scope, deferred, non-reproducible, or accepted limitations.

- `blocked`  
  A reproducible in-scope blocker cannot be resolved safely within the authorized task.

Do not continue implementation after reaching a terminal state.