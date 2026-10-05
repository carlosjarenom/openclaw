import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it } from "vitest";
import { mergeAtPath, parseConfigSetValue, setAtPath } from "./config-cli-path.js";

function nestedRecord(depth: number, leaf: Record<string, unknown>): Record<string, unknown> {
  let value = leaf;
  for (let index = 0; index < depth; index += 1) {
    value = { nested: value };
  }
  return value;
}

describe("parseConfigSetValue", () => {
  it.each([
    { raw: "42", expected: 42 },
    { raw: "true", expected: true },
    { raw: "null", expected: null },
    { raw: "{a:1}", expected: { a: 1 } },
    { raw: "[1,2]", expected: [1, 2] },
  ])("parses $raw as expected", ({ raw, expected }) => {
    expect(parseConfigSetValue(raw, false)).toEqual(expected);
  });

  it("falls back to the raw string when JSON5 parsing fails", () => {
    expect(parseConfigSetValue("hello", false)).toBe("hello");
  });

  it.each([
    { raw: "Infinity", label: "Infinity" },
    { raw: "NaN", label: "NaN" },
    { raw: "1e999", label: "overflow exponent" },
    { raw: "{timeout:1e999}", label: "object with overflow exponent" },
    { raw: "[1e999]", label: "array with overflow exponent" },
  ])("rejects $label in value mode", ({ raw }) => {
    expect(() => parseConfigSetValue(raw, false)).toThrow("Value must be a finite number");
  });

  it("rejects overflow exponent in strict JSON mode with the finite-number error", () => {
    expect(() => parseConfigSetValue("1e999", true)).toThrow("Value must be a finite number");
  });

  it("still reports JSON parse errors in strict JSON mode", () => {
    expect(() => parseConfigSetValue("not-json", true)).toThrow(
      expect.objectContaining({
        message: expect.stringContaining('Could not parse "not-json" as JSON for --strict-json.'),
        cause: expect.any(SyntaxError),
      }),
    );
  });

  it("merges deeply nested object values without an engine failure", () => {
    const depth = 20_000;
    const root = { value: nestedRecord(depth, { retained: true }) };

    mergeAtPath(root, ["value"], nestedRecord(depth, { added: true }));

    let cursor: unknown = root.value;
    for (let index = 0; index < depth; index += 1) {
      if (!isRecord(cursor)) {
        throw new Error(`missing nested record at depth ${index}`);
      }
      cursor = cursor.nested;
    }
    expect(cursor).toEqual({ retained: true, added: true });
  });
});

describe("setAtPath traversal guards", () => {
  it.each([
    { label: "string shorthand", primary: "openai/gpt-5.4" },
    { label: "number", primary: 42 },
    { label: "boolean", primary: false },
  ])("refuses to set a sub-value under a $label instead of dropping it", ({ primary }) => {
    const root = { agents: { defaults: { model: primary } } };

    expect(() =>
      setAtPath(
        root,
        ["agents", "defaults", "model", "fallbacks"],
        ["anthropic/claude-sonnet-4-6"],
      ),
    ).toThrow(/agents\.defaults\.model/);
    expect(root.agents.defaults.model).toBe(primary);
  });

  it("still replaces a scalar when the caller writes the parent path itself", () => {
    const root = { agents: { defaults: { model: "openai/gpt-5.4" } } };

    setAtPath(root, ["agents", "defaults", "model"], {
      primary: "openai/gpt-5.4",
      fallbacks: ["anthropic/claude-sonnet-4-6"],
    });

    expect(root.agents.defaults.model).toEqual({
      primary: "openai/gpt-5.4",
      fallbacks: ["anthropic/claude-sonnet-4-6"],
    });
  });

  it("creates sub-values under an absent or empty parent", () => {
    const absent: Record<string, unknown> = { agents: {} };
    setAtPath(absent, ["agents", "defaults", "model", "fallbacks"], ["a"]);
    expect(absent.agents).toEqual({ defaults: { model: { fallbacks: ["a"] } } });

    const empty: Record<string, unknown> = { agents: { defaults: { model: null } } };
    setAtPath(empty, ["agents", "defaults", "model", "fallbacks"], ["a"]);
    expect(isRecord(empty.agents) && isRecord(empty.agents.defaults)).toBe(true);
  });
});
