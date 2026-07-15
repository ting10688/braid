# Consola qualification and proposal review

## Role, pin, and license

Consola is the false-positive control candidate. The canonical repository is `https://github.com/unjs/consola.git`, pinned to `c47faac1738b7383971c6c20b5a34ffa15e7cc3b`. Upstream `package.json` declares MIT and the reviewed `LICENSE` is MIT with SHA-256 `df0e3cef4a42bae7db60ee33c3409a63df5f4dc40291d3627fbf52dfbd44e8a7`.

## Scope and size

Included: `src/**/*.ts`. Excluded: declarations, `test`, examples, generated `dist`/`lib`, and dependencies. The pin contains 21 included source files, 1 TypeScript test file, 1,809 nonblank/non-comment LOC, and 3 Braid-classified modules. It is below the preferred 30–150 file range but is fast enough for repetition. Largest files are recorded in `repository.yaml`.

## Commands and qualification

- Install: `corepack pnpm install --frozen-lockfile --ignore-scripts` using pnpm 10.6.3 and `pnpm-lock.yaml` SHA-256 `c729beba14be288f8ecabe12a5ac037df3e7eb39ae450aa83fb72154f37d3b93`.
- Build: `corepack pnpm build`; passed.
- Test: `corepack pnpm vitest run`; 1 file and 3 tests passed.
- Braid: isolated `init`, `analyze`, and `propose`; passed. Three proposal runs had identical identity, order, targets, evidence, risk, reversibility, and ranking. Source mutation was zero.

No configured size threshold differs from Braid's defaults. Public package entrypoints are protected because a boundary change there would require explicit API review.

## Architecture and independent proposal review

The source has a public/composition root, a `reporters` directory, and a `utils` directory. Manual import inspection found that `src/basic.ts`, `src/browser.ts`, and `src/index.ts` import reporters, while reporters import shared `src/types.ts`, `src/constants.ts`, and the root re-export `src/utils.ts`.

Braid emitted one proposal: break `root → reporters` across 9 files. Its import counts and file evidence are factually correct, and high risk/difficult reversibility correctly reflect protected public entrypoints. It is nevertheless rejected as an actionable issue: `root` is not a cohesive implementation module—it combines public composition entrypoints, shared types, constants, and a utility re-export. The reported cycle is therefore produced by coarse module classification; dependency inversion would add a contract to a small library without demonstrating a real boundary defect.

Accepted issues: none. Rejected proposals/false positives: 1. Ambiguous proposals: none. Informational proposals: none. The expectation intentionally does not force the control to zero output; it records the independently reviewed false positive.

## Limitations

Consola has fewer files than the preferred range. Only Node-compatible build and Vitest validation were run; release scripts were excluded. The independent graph checker resolves relative TypeScript imports used by this pin and does not claim general path-alias support.
