# tslog qualification and proposal review

## Role, pin, and license

tslog is the higher-complexity candidate: multiple runtime entries, subpath exports, transports, presets, serializers, and CLI code. The canonical repository is `https://github.com/fullstack-build/tslog.git`, pinned to `07d3e31ea36ae1074accb0097bdc53bd73c93e13`. The reviewed `LICENSE` is MIT with SHA-256 `a5e6ddb3af783a02eacc848cbe309cc0940b4859ac653e9b1a2e21a4fea22552`.

## Scope and size

Included: `src/**/*.ts`. Excluded: declarations, tests, benchmarks, docs, generated `dist`, and dependencies. The pin contains 59 included source files, 99 TypeScript test files, 11,046 nonblank/non-comment LOC, and 6 qualification-time directory buckets, within the preferred range. Largest files are recorded in `repository.yaml`.

## Commands and qualification

- Install: `npm ci --ignore-scripts` using `package-lock.json` SHA-256 `8e72c592396e9e1bea0ef56d2ef32c9afad2208546db8be42cb431104fbd242f`; passed with lifecycle scripts disabled.
- Test: `npm test`; Vitest selected 86 files and 1,579 tests, all passed.
- Build: `npm run build`; native-preview type/ESM builds and browser build passed. The aggregate build invokes upstream `prepare-publish` for local file preparation; no publish, pre-publish, release, credentialed, or network service command ran.
- Braid: isolated `init`, `analyze`, and `propose`; passed. Three proposal runs had identical identity, order, targets, evidence, risk, reversibility, and ranking. Source mutation was zero.

Status is `qualified-with-limitations`: Playwright, Bun, and Deno tests were excluded, and Braid/ts-morph reported syntax diagnostics for six native-preview files while still extracting their imports and declarations. No size threshold differs from Braid's defaults. Public entrypoints and all exported subpath sources are protected.

## Architecture structure

Independent relative-import inspection reproduced the feature/infrastructure directories and the former coarse root. Phase 2.1 keeps `core`, `env`, `internal`, and `render`, classifies package surfaces as entrypoints/barrels, and splits top-level implementation files into stable identities such as `root:interfaces` and `root:formatTemplate`. `subpaths` depends inward and has no incoming source dependency. The independent checker confirmed every selected edge and import count below.

## Proposal review

| Rank | Root cause                        | Primary target                                                                           | Alternatives                                                                         | Review   | Evidence, risk, and reversibility rationale                                                                                                                                                                                                                                                                         |
| ---- | --------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `CR-96e57d0a6656`                 | `internal → env`                                                                         | 17 typed actions, including the accepted `core → env` and `render → core` boundaries | Accepted | The SCC covers `core`, `env`, `internal`, `render`, `root:formatTemplate`, and `root:interfaces`. The primary's one import is exact; its 13-file `env/internal` cycle scope supports medium risk and difficult reversal. Each existing accepted action retains its own evidence/risk/reversibility in alternatives. |
| 2    | Not applicable (`extract-module`) | `jsonStringifySafe`, `jsonStringifyValue`, and `stringifyFieldValue` in `render/json.ts` | None                                                                                 | Rejected | The name cluster, 2 internal references, and 789-line threshold evidence are exact; risk is low and reversal easy. The helpers are nevertheless coupled to the renderer's serialization hot path and include an existing public function, so naming facts do not establish a better independent module boundary.    |

Accepted semantic actions: 3, represented by 1 accepted top-level proposal. Rejected/false positives: 1. Ambiguous top-level proposals: 0. Proposal-action validity is 75%. Evidence correctness, risk agreement, and reversibility agreement are 100%. The cycle primary remains top-level because it is the only representative of its SCC root cause; the extraction remains top-level because it is a different proposal type and has no equivalent target to suppress. Historical duplicate and coarse-root reviews remain in the expectation file for auditability.

## Limitations

Browser-download, Bun, and Deno commands were intentionally excluded. Native-preview syntax diagnostics make completeness less certain for six files even though relevant imports were recovered. The 17 alternatives are statically plausible graph actions, not a claim that each is semantically desirable. No migration was executed.
