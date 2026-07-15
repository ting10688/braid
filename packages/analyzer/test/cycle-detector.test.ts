import { describe, expect, it } from "vitest";
import {
  buildAdjacencyList,
  detectCycles,
  findDependencyCycles,
} from "../src/index.js";

const graph = (edges: Array<readonly [string, string]>) =>
  buildAdjacencyList(new Set(edges.flatMap(([from, to]) => [from, to])), edges);

describe("cycle detection", () => {
  it("returns no cycle for an acyclic graph", () => {
    expect(detectCycles(graph([["a", "b"]]))).toEqual([]);
  });

  it("detects a two-node cycle", () => {
    expect(
      detectCycles(
        graph([
          ["a", "b"],
          ["b", "a"],
        ]),
      ),
    ).toEqual([["a", "b"]]);
  });

  it("detects a three-node cycle", () => {
    expect(
      detectCycles(
        graph([
          ["a", "b"],
          ["b", "c"],
          ["c", "a"],
        ]),
      ),
    ).toEqual([["a", "b", "c"]]);
  });

  it("canonicalizes duplicate traversal paths", () => {
    expect(
      detectCycles(
        graph([
          ["a", "b"],
          ["a", "b"],
          ["b", "c"],
          ["c", "a"],
        ]),
      ),
    ).toEqual([["a", "b", "c"]]);
  });

  it("handles self imports as a one-node file cycle", () => {
    expect(detectCycles(graph([["a", "a"]]))).toEqual([["a"]]);
  });

  it("excludes external dependencies", () => {
    expect(
      findDependencyCycles([
        {
          fromFile: "src/a.ts",
          toFile: "react",
          fromModule: "root",
          toModule: "react",
          kind: "external",
        },
      ]),
    ).toEqual([]);
  });
});
