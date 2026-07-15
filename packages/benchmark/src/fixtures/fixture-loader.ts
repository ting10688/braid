import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import {
  benchmarkSuiteSchema,
  benchmarkProtocolSchema,
  expectationFileSchema,
  regressionPolicySchema,
  type BenchmarkProtocol,
  type BenchmarkSuite,
  type ExpectationFile,
  type RegressionPolicy,
} from "../models/benchmark.js";

export const benchmarkAssetPath = (
  benchmarksRoot: string,
  relativePath: string,
): string => {
  if (path.isAbsolute(relativePath))
    throw new Error("Benchmark asset paths must be relative");
  const root = path.resolve(benchmarksRoot);
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))
    throw new Error(
      `Benchmark asset escapes the benchmark root: ${relativePath}`,
    );
  return resolved;
};

export const loadSuite = async (
  benchmarksRoot: string,
  suiteId: string,
): Promise<BenchmarkSuite> => {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(suiteId))
    throw new Error(`Invalid benchmark suite ID: ${suiteId}`);
  const file = benchmarkAssetPath(
    benchmarksRoot,
    path.join("suites", `${suiteId}.yaml`),
  );
  return benchmarkSuiteSchema.parse(parse(await readFile(file, "utf8")));
};

export const loadExpectation = async (
  benchmarksRoot: string,
  relativeFile: string,
): Promise<ExpectationFile> =>
  expectationFileSchema.parse(
    JSON.parse(
      await readFile(benchmarkAssetPath(benchmarksRoot, relativeFile), "utf8"),
    ),
  );

export const loadProtocol = async (
  benchmarksRoot: string,
): Promise<BenchmarkProtocol> =>
  benchmarkProtocolSchema.parse(
    parse(
      await readFile(
        benchmarkAssetPath(benchmarksRoot, "protocol.yaml"),
        "utf8",
      ),
    ),
  );

export const loadRegressionPolicy = async (
  benchmarksRoot: string,
  policyName = "default",
): Promise<RegressionPolicy> => {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(policyName))
    throw new Error(`Invalid regression policy name: ${policyName}`);
  return regressionPolicySchema.parse(
    parse(
      await readFile(
        benchmarkAssetPath(
          benchmarksRoot,
          path.join("policies", `${policyName}.yaml`),
        ),
        "utf8",
      ),
    ),
  );
};
