# tslog qualification and proposal review

## Role, pin, and license

tslog is the higher-complexity candidate: multiple runtime entries, subpath exports, transports, presets, serializers, and CLI code. The canonical repository is `https://github.com/fullstack-build/tslog.git`, pinned to `07d3e31ea36ae1074accb0097bdc53bd73c93e13`. The reviewed `LICENSE` is MIT with SHA-256 `a5e6ddb3af783a02eacc848cbe309cc0940b4859ac653e9b1a2e21a4fea22552`.

## Scope and size

Included: `src/**/*.ts`. Excluded: declarations, tests, benchmarks, docs, generated `dist`, and dependencies. The pin contains 59 included source files, 99 TypeScript test files, 11,046 nonblank/non-comment LOC, and 6 Braid-classified modules, within the preferred range. Largest files are recorded in `repository.yaml`.

## Commands and qualification

- Install: `npm ci --ignore-scripts` using `package-lock.json` SHA-256 `8e72c592396e9e1bea0ef56d2ef32c9afad2208546db8be42cb431104fbd242f`; passed with lifecycle scripts disabled.
- Test: `npm test`; Vitest selected 86 files and 1,579 tests, all passed.
- Build: `npm run build`; native-preview type/ESM builds and browser build passed. The aggregate build invokes upstream `prepare-publish` for local file preparation; no publish, pre-publish, release, credentialed, or network service command ran.
- Braid: isolated `init`, `analyze`, and `propose`; passed. Three proposal runs had identical identity, order, targets, evidence, risk, reversibility, and ranking. Source mutation was zero.

Status is `qualified-with-limitations`: Playwright, Bun, and Deno tests were excluded, and Braid/ts-morph reported syntax diagnostics for six native-preview files while still extracting their imports and declarations. No size threshold differs from Braid's defaults. Public entrypoints and all exported subpath sources are protected.

## Architecture structure

Independent relative-import inspection reproduced six directory-level buckets: `core`, `env`, `internal`, `render`, `root`, and `subpaths`. `subpaths` depends inward and has no incoming source dependency. The dense reusable implementation is split among the other five buckets. The independent checker confirmed every selected edge and import count below.

## Proposal review

| Rank | Selected edge                             | Review             | Evidence, risk, and reversibility rationale                                                                                                                                                       |
| ---- | ----------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `render → core`                           | Accepted           | `render/json.ts` imports `core/logObj.ts`; `core/features.full.ts` and `core/pipeline.ts` import the renderer. Four affected files are bounded; low risk and conditional rollback are reasonable. |
| 2    | `render → root`                           | Ambiguous          | The one reverse import is real, but `root` combines interfaces, helpers, logger implementation, and public entrypoints. A finer root boundary is needed.                                          |
| 3    | `root → internal`                         | Ambiguous          | Two imports are real, but removing normal public-to-internal dependencies may be the wrong direction; the coarse root bucket prevents a definite label.                                           |
| 4    | `core → env`                              | Accepted           | `core/meta.ts` and `core/pipeline.ts` import environment seams; environment implementations import core async context/settings. Ten files, medium risk, and conditional rollback are reasonable.  |
| 5    | `internal → env` in `env/render/internal` | Rejected duplicate | Same one-import edge as rank 6 with a broader cycle; no distinct migration action.                                                                                                                |
| 6    | `internal → env` in `env/internal`        | Accepted           | `internal/errorUtils.ts` imports `env/stackTrace.ts`; environment providers import internal helpers. Thirteen files justify medium risk and difficult rollback.                                   |
| 7    | `render → core` in `core/env/render`      | Rejected duplicate | Same edge as rank 1 with eleven affected files and no new action.                                                                                                                                 |
| 8    | `root → render` in `internal/root/render` | Ambiguous          | The edge is real, but root classification and a twelve-file scope make the appropriate boundary unclear.                                                                                          |
| 9    | `internal → env` in four modules          | Rejected duplicate | Same edge as rank 6 with a four-module scope.                                                                                                                                                     |
| 10   | `internal → env` in `env/root/internal`   | Rejected duplicate | Same edge as rank 6 with the broadest fourteen-file scope.                                                                                                                                        |

Accepted: 3. Rejected/false positives: 4 duplicate actions. Ambiguous: 3. The accepted evidence values match the independent graph, scopes are bounded, and no accepted proposal touches the configured protected/public entrypoints, so no omitted public-impact evidence was found. Risk agreement is 3/3 and reversibility agreement is 3/3.

## Limitations

Browser-download, Bun, and Deno commands were intentionally excluded. Native-preview syntax diagnostics make completeness less certain for six files even though relevant imports were recovered. Braid's ten-proposal limit is saturated by cycle variants, so oversized-file proposals are not represented in the observed top ten. No migration was executed.
