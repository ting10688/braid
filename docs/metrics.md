# Architecture metrics

Braid reports explainable raw measurements, not an opaque architecture score. Threshold comparisons
use strict `>` semantics: a file exactly at its configured limit is not oversized.

| Metric                | Definition and calculation                                                               | Known limitation                                                                                          | Is lower always better?                     |
| --------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Source files          | Count of included, successfully parsed TypeScript/TSX files.                             | Depends on configured globs; generated or excluded code is absent.                                        | No.                                         |
| Modules               | Count of directory-classified module IDs represented by source files.                    | Directory layout is only a responsibility proxy.                                                          | No.                                         |
| Internal imports      | Count of unique static import/re-export specifiers resolved to an included file.         | Dynamic and runtime-resolved imports are not represented.                                                 | No.                                         |
| External imports      | Count of unique static import/re-export specifiers not resolved to an included file.     | A missing internal target can appear external; package subpaths collapse to the package name.             | No.                                         |
| Cross-module imports  | Internal edges whose source and target module IDs differ.                                | Cross-module collaboration can be intentional and healthy.                                                | No.                                         |
| Circular dependencies | Count of canonical internal cycles after equivalent file/module cycles are deduplicated. | Multiple file paths supporting one module cycle appear in one record; type-only edges still count.        | Usually, but some cycles may be deliberate. |
| Oversized files       | Files with lexical lines of code greater than `oversized_file_lines`.                    | The simple counter ignores blank and obvious comment-only lines but is not a semantic complexity measure. | Usually, not always.                        |
| Oversized modules     | Modules exceeding `oversized_module_files` or `oversized_module_exports`.                | Re-exports contribute to exported-symbol count and may intentionally expand a public facade.              | Usually, not always.                        |
| Public entrypoints    | Included files named `index.ts` or `index.tsx`.                                          | A project may expose public APIs through package exports or differently named files.                      | No.                                         |

`max_module_dependencies` is validated and retained in configuration for boundary warnings in a future
phase. The current snapshot schema has no corresponding raw metric, so Braid does not silently fold it
into another number.
