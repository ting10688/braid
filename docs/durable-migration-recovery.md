# Durable migration recovery

Phase 4 adds a local recovery protocol to every newly approved migration execution. After a Braid
process or its host stops, another process can inspect immutable evidence and either continue from the
next safe stage, clean up proven Braid-owned resources, recognize an already completed execution, or
refuse automation. Recovery never changes the main checkout and never treats a path name alone as
ownership proof.

The public journal protocol is `Migration Recovery Journal schema 1.0.0`. It is separate from, and
does not change, execution plan schema v1 or execution record schema v1.

## Checkpoint state machine

The uninterrupted migration path and the recovery path use the same durable checkpoints. The normal
commit-producing path is linear; `--no-commit` takes the documented transition from
`architecture-passed` directly to `completed`.

| Durable checkpoint    | Evidence committed before advancing                                                                                       | Legal next checkpoint                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `planned`             | execution, approval, proposal, plan, base, repository, configuration, source, executor invocation, and intended resources | `preflight-passed`, `failed`, `discarded`                |
| `preflight-passed`    | exact freshness and preflight result identities                                                                           | `staging-created`, `failed`, `discarded`                 |
| `staging-created`     | staging repository, candidate worktree and candidate ref ownership; marker; initial commit; no-remotes proof              | `executor-started`, `failed`, `discarded`                |
| `executor-started`    | durable invocation ID, bounded executor configuration, and `prepared`/`launching` process metadata ownership              | `executor-finished`, `failed`, `discarded`               |
| `executor-finished`   | exit result, output hashes, process cleanup result, and resulting staging fingerprint                                     | `patch-captured`, `failed`, `discarded`                  |
| `patch-captured`      | canonical patch hash, changed files and modes, staging fingerprint, and retained patch ownership                          | `scope-verified`, `failed`, `discarded`                  |
| `scope-verified`      | scope-gate input and accepted-result identities                                                                           | `validation-passed`, `failed`, `discarded`               |
| `validation-passed`   | validation input, command, and result identities                                                                          | `architecture-passed`, `failed`, `discarded`             |
| `architecture-passed` | architecture comparison input and accepted-result identities                                                              | `candidate-prepared`, `completed`, `failed`, `discarded` |
| `candidate-prepared`  | exact deterministic commit inputs and temporary-index ownership                                                           | `candidate-created`, `failed`, `discarded`               |
| `candidate-created`   | commit, tree, parent, ref, and verification identities                                                                    | `completed`, `failed`, `discarded`                       |
| `completed`           | final execution-record identity and successful disposition                                                                | none                                                     |
| `failed`              | failed stage, stable failure code, and outcome identity                                                                   | none                                                     |
| `discarded`           | cleanup/discard stage, stable outcome code, and outcome identity                                                          | none                                                     |

`completed`, `failed`, and `discarded` are terminal. Interruption is not a separate state: it is
inferred from the latest complete entry. Replaying a checkpoint with identical semantic evidence is an
idempotent read of the existing entry. Replaying different evidence or skipping a legal transition is
an error; Braid never rewrites the prior entry.

## Journal layout and integrity

The immutable source of truth lives below the execution's existing portable artifact directory:

```text
.braid/executions/<execution-id>/
├── plan.json
├── record.json
├── candidate.patch
└── recovery/
    ├── entries/
    │   ├── 000000-planned.json
    │   ├── 000001-preflight-passed.json
    │   └── ...
    ├── mutation.lock/owner.json       # present only while a mutation owns the lock
    ├── executor-process.json          # present only while applicable
    ├── executor-result.json
    ├── candidate-preparation.json
    └── cleanup.json                   # retained audit result when cleanup runs
```

Candidate worktrees and durable executor staging repositories remain outside the main checkout. Their
portable locators and ownership hashes are stored in the journal; machine-local absolute paths remain
in local locator data and are not journal identity inputs.

Each entry has a zero-based sequence, the previous entry hash, a semantic hash, and an entry hash. The
semantic hash covers the versioned execution identity, checkpoint, and evidence using canonical key
ordering. The entry hash additionally binds the sequence, previous hash, recorded timestamp, and
diagnostics. Journal and report IDs do not depend on timestamps, random temporary names, locale
ordering, object insertion order, filesystem traversal order, or private absolute paths.

Appending uses an exclusive-create temporary file followed by an atomic rename to the final
`NNNNNN-<checkpoint>.json` name. A successful checkpoint is not reported until that rename succeeds.
Loading verifies:

- filenames and contiguous sequence numbers;
- the schema and checkpoint/evidence match;
- semantic and entry hashes;
- every previous-entry link;
- immutable execution, proposal, plan, base, and repository identity;
- duplicate checkpoints and legal transitions.

Incomplete `.tmp` files are ignored as evidence and returned as diagnostics. Missing entries,
modified entries, broken chains, conflicting duplicate checkpoints, and illegal transitions invalidate
the journal. Braid reports these conditions; it does not automatically repair evidence.

## Recovery classifications

Every read-only inspection returns exactly one of five classifications. The decision is conservative
and evaluated in this precedence order:

| Verified condition                                                                                               | Classification               | Automated consequence                      |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------------------------------------ |
| Journal/repository identity is invalid, resource ownership is ambiguous, or lock ownership/liveness is ambiguous | `manual-inspection-required` | Do not resume or clean up automatically    |
| Approval identity no longer matches                                                                              | `unsafe-to-resume`           | Refuse resume                              |
| Latest checkpoint is `executor-started`, a patch/candidate conflict exists, or another process holds a live lock | `unsafe-to-resume`           | Refuse resume; never relaunch the executor |
| Latest checkpoint is `completed` and journal, final record, candidate state and owned ref agree                  | `already-complete`           | No execution mutation                      |
| Latest checkpoint is `failed` or `discarded`, and verified owned mutable resources remain                        | `cleanup-required`           | Permit only verified owned cleanup         |
| Latest nonterminal checkpoint and all required identities/resources are consistent                               | `resumable`                  | Continue from the next incomplete stage    |
| No usable journal entry exists                                                                                   | `manual-inspection-required` | Inspect evidence manually                  |

`cleanupEligible` is a separate, explicit proof. An `unsafe-to-resume` execution such as an
`executor-started` interruption may still be eligible for cleanup when every remaining resource is
conclusively owned, process metadata remains `prepared`, and no conflict or live/ambiguous lock exists.
A `launching` marker makes process liveness uncertain and therefore disables cleanup. Conversely, an
ambiguous resource is never made cleanup-eligible merely because the execution cannot resume.

Inspection is read-only. It does not run the executor, validation commands, builds, tests, or the
architecture analyzer; create a commit or ref; or remove a resource. Listing omits
`already-complete` executions and sorts the remaining reports by execution ID.

## Resume matrix

Completed gates are reused only while their durable input identities still match. Changed or missing
inputs are not silently trusted and do not cause checkpoint evidence to be rewritten.

| Latest durable checkpoint                      | Resume behavior                                                         |           Additional executor launches |
| ---------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------: |
| `planned`                                      | Revalidate preflight, then continue                                     |                              at most 1 |
| `preflight-passed`                             | Recheck freshness, create verified staging, then continue               |                              at most 1 |
| `staging-created`                              | Verify and reuse the owned staging repository, then launch the executor | exactly 1 when continuation reaches it |
| `executor-started` without `executor-finished` | Classify `unsafe-to-resume`; refuse continuation                        |                                      0 |
| `executor-finished`                            | Verify the recorded staging result and capture its patch                |                                      0 |
| `patch-captured`                               | Verify the immutable patch and continue at the scope gate               |                                      0 |
| `scope-verified`                               | Continue at configured validation                                       |                                      0 |
| `validation-passed`                            | Continue at the architecture gate when its input matches                |                                      0 |
| `architecture-passed`                          | Prepare a candidate, or finalize a `--no-commit` execution              |                                      0 |
| `candidate-prepared`                           | Reconstruct the exact expected candidate object and owned ref           |                                      0 |
| `candidate-created`                            | Verify the candidate and finalize the execution record                  |                                      0 |
| `completed`                                    | Return the existing plan and record as an idempotent no-op              |                                      0 |
| `failed` or `discarded`                        | Do not resume; report cleanup eligibility separately                    |                                      0 |

Resume first inspects the state, then acquires the per-execution lock, re-inspects under that lock, and
compares the journal it observed before and after acquisition. It continues only if both observations
are `resumable`. There is no `--force` and no user-selectable checkpoint.

## Exactly-once executor behavior

Each execution derives one durable executor invocation ID from the execution, plan, and bounded
executor configuration. The order around the irreversible boundary is:

1. persist `prepared` process metadata and `executor-started` with that invocation ID;
2. atomically advance the metadata to `launching` immediately before invoking the executor;
3. launch the executor once;
4. terminate/clean the owned process group and persist sanitized output artifacts;
5. persist `executor-finished` with exit, timeout, output-hash, cleanup, and staging identities;
6. remove the matching `launching` metadata only after that checkpoint is durable.

Before `executor-started`, a verified continuation may eventually perform one launch. If
`executor-started` exists without `executor-finished`, Braid cannot prove whether the external executor
finished and therefore launches it zero more times. At `executor-finished` or any later checkpoint,
resume consumes durable output and also launches it zero more times. A partially modified staging
repository is never treated as proof of executor completion.

## Exactly-once candidate behavior

`candidate-prepared` binds the parent, tree, complete message, author, committer, durable timestamp,
UTC offset, expected commit SHA, and intended `refs/heads/braid/exec/<eight-hex>` ref. Before persisting
that checkpoint, preparation also verifies the changed-file set and patch hash against the gated
candidate. The commit SHA is calculated from the exact Git object bytes before the commit object or
ref is exposed.

Candidate creation writes or reuses that exact object, verifies its SHA, and compare-and-swaps the
owned ref from the approved parent to the expected commit. A ref already at the expected commit is an
idempotent success; a ref at any other commit is a conflict. Recovery therefore converges on one
logical candidate SHA when interruption happens before object creation, after object creation, after
the ref update, after `candidate-created`, or before `completed`.

An object written immediately before interruption may remain unreachable. It is not exposed as a
second candidate result, but Phase 4 cannot guarantee removal of every unreachable Git object.

## Ownership, cleanup, and locking

Every mutable resource record binds a deterministic resource ID and integrity hash to its resource
type, execution ID, repository identity, base commit, portable locator, creation checkpoint, and any
applicable Git common-directory, worktree, HEAD, or ref identity. Covered resource types are:

- journal and patch artifacts;
- executor staging repositories and process metadata;
- candidate worktrees, temporary indexes, and Braid-owned candidate refs.

Cleanup re-inspects ownership before mutation and then verifies main-checkout integrity around the
operation. It can remove only matching staging, process metadata, temporary indexes, candidate
worktrees, and Braid-owned refs. It retains the journal, patch, final execution record, and cleanup
audit artifact. It refuses an unknown marker, changed locator, mismatched repository/ref, user branch,
user worktree, main checkout, or valid completed candidate.

Process metadata has an integrity-bound `prepared` or `launching` state. An `executor-started`
interruption is cleanup-eligible only while the marker is still `prepared`. Once `launching` is
durable, Braid refuses automatic cleanup because killing the Braid parent does not prove that a
detached executor process group has stopped. A durable `executor-finished` checkpoint is the proof
that permits recovery to consume the result and remove a leftover `launching` marker.

Normal execution, resume, and cleanup share a per-execution mutation lock. Atomic directory creation
selects one owner; `owner.json` binds execution/repository, host, PID, random ownership token, and
acquisition time. A clearly live owner is rejected. A same-host stale owner is reclaimed only after a
process-liveness check proves the PID absent and the owner marker remains unchanged. Invalid markers,
permission-indeterminate liveness, and locks from another host are ambiguous and are not reclaimed.
Read-only recovery inspection observes the lock without stealing it, and release verifies that the
same token still owns it.

This lock prevents two local processes from mutating one execution; it is not a distributed lock or a
migration scheduler.

## CLI

```bash
braid migrate recover [<execution-id>] [--json] [--path <project>]
braid migrate resume <execution-id> --confirm <execution-id> [--json] [--path <project>]
braid migrate cleanup <execution-id> --confirm <execution-id> [--json] [--path <project>]
```

Without an ID, `recover` lists incomplete/recoverable executions deterministically. With an ID, human
output exposes every mutation decision field:

```text
$ braid migrate recover E-00000000-0000-4000-8000-000000000001
Execution: E-00000000-0000-4000-8000-000000000001
Classification: resumable
Latest checkpoint: patch-captured
Integrity: valid
Next safe action: Resume after patch-captured
Executor launch permitted: no
Candidate creation permitted: no
Cleanup eligible: no
```

`--json` writes one JSON document to stdout. Diagnostics and errors go to stderr, so automation never
has to parse mixed output. A report has this stable shape:

```json
{
  "schemaVersion": "1.0.0",
  "reportId": "RR-0123456789abcdef",
  "executionId": "E-00000000-0000-4000-8000-000000000001",
  "classification": "resumable",
  "latestCheckpoint": "patch-captured",
  "integrity": {
    "valid": true,
    "temporaryFiles": []
  },
  "nextSafeAction": "Resume after patch-captured",
  "executorLaunchPermitted": false,
  "candidateCreationPermitted": false,
  "cleanupEligible": false,
  "lock": {
    "status": "unlocked"
  },
  "resources": [
    {
      "resourceId": "R-0123456789abcdef01234567",
      "resourceType": "journal",
      "executionId": "E-00000000-0000-4000-8000-000000000001",
      "repositoryId": "0000000000000000000000000000000000000000000000000000000000000000",
      "baseCommit": "0000000000000000000000000000000000000000",
      "portableLocator": ".braid/executions/E-00000000-0000-4000-8000-000000000001/recovery/entries",
      "creationCheckpoint": "planned",
      "integrityHash": "0000000000000000000000000000000000000000000000000000000000000000"
    }
  ]
}
```

`resume` and `cleanup` require `--confirm` to equal the full execution ID exactly. A completed resume
returns the existing record successfully without acquiring a mutation lock or changing execution
state. Exit behavior is:

- `0`: successful inspection/listing, successful resume/cleanup, or completed no-op;
- `2`: malformed command-line use;
- `12`: missing/mismatched confirmation, journal-integrity refusal, live/ambiguous lock conflict,
  non-resumable resume, ambiguous ownership, or ineligible cleanup;
- existing migration stage codes (`7` through `11`, and other established safety codes) remain in
  effect if an actually resumed stage fails its executor, scope, validation, architecture, or main
  integrity gate.

`migrate status` and `migrate inspect` add recovery data only when a Phase 4 journal exists; existing
execution fields and legacy records remain readable.

## Interruption and SIGKILL semantics

Correctness depends only on the latest atomically renamed entry, not on signal handling or a final
`interrupted` write. Graceful termination may add diagnostics, but SIGKILL, process failure, or host
interruption has the same decision rules:

- a partially written temporary entry is ignored and reported;
- work before the latest complete checkpoint is never inferred as complete;
- `executor-started` without `executor-finished` permanently disables automatic executor relaunch for
  that execution;
- `executor-started` with `launching` process metadata also disables automatic cleanup, even when the
  Braid parent PID is stale, because a detached executor may still be alive;
- `candidate-prepared` allows exact candidate reconstruction, including an object already written but
  not referenced;
- an owned ref already at the prepared SHA is verified and reused before `candidate-created` is
  appended;
- a final record written after `candidate-created` but before `completed` is verified and finalized;
- `completed` remains a zero-mutation, idempotent result on every later inspection or resume.

The local filesystem containing `.braid`, the Git common directory, and the external execution root
must survive the interruption for their evidence to be inspected. Missing or modified evidence is
classified conservatively rather than reconstructed by guesswork.

## Trust boundary and limitations

Durable recovery is local and single-host. It assumes a trusted repository owner, Braid configuration,
configured validation commands and package scripts, Git executable, Node.js runtime, operating system,
and filesystem. It protects normal migration correctness and ownership boundaries; it is not an
operating-system security boundary against a hostile repository or deliberate tampering with Git
internals while recovery is in progress.

Phase 4 is deliberately:

- not rollback of main, and it never merges, pushes, or mutates main;
- not distributed or cross-machine recovery;
- not a queue, daemon, database, or concurrent migration scheduler;
- limited to resources whose Braid ownership is structurally and cryptographically verified;
- unable to guarantee removal of unreachable Git objects left by an interrupted low-level object
  write.

Ambiguous ownership or corrupted evidence requires manual inspection. Phase 4 does not supply a force
flag, auto-repair journal history, delete unknown resources, or convert uncertainty into a resumable
classification.
