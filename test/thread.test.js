import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { compileThread, deriveTitle } from "../src/thread.js";

describe("compileThread", () => {
  test("returns empty string for empty array", () => {
    assert.equal(compileThread([]), "");
  });

  test("formats a single message as a blockquote", () => {
    const result = compileThread([{ text: "Hello world" }]);
    assert.ok(result.startsWith("**Full thread:**"));
    assert.ok(result.includes("> Hello world"));
  });

  test("formats multiple messages", () => {
    const result = compileThread([
      { text: "First message" },
      { text: "Second message" },
    ]);
    assert.ok(result.includes("> First message"));
    assert.ok(result.includes("> Second message"));
  });

  test("indents continuation lines within a multi-line message", () => {
    const result = compileThread([{ text: "Line 1\nLine 2" }]);
    assert.ok(result.includes("> Line 1\n> Line 2"));
  });

  test("skips messages with empty text", () => {
    const result = compileThread([{ text: "Hello" }, { text: "" }, { text: "World" }]);
    const quoteLines = result.split("\n").filter((l) => l.startsWith("> ") && l.trim() !== ">");
    assert.equal(quoteLines.length, 2);
  });

  test("handles messages with null text", () => {
    const result = compileThread([{ text: null }, { text: "Valid message" }]);
    assert.ok(result.includes("> Valid message"));
  });
});

describe("deriveTitle", () => {
  test("returns the first line of a multi-line text", () => {
    assert.equal(deriveTitle("First line\nSecond line"), "First line");
  });

  test("returns text unchanged when 80 chars or fewer", () => {
    const exactly80 = "a".repeat(80);
    assert.equal(deriveTitle(exactly80), exactly80);
  });

  test("truncates to 80 chars with ellipsis when text is longer than 80 chars", () => {
    const long = "b".repeat(100);
    const result = deriveTitle(long);
    assert.equal(result.length, 80);
    assert.ok(result.endsWith("..."));
  });

  test("returns fallback title for empty string", () => {
    assert.equal(deriveTitle(""), "Issue from Slack");
  });

  test("returns fallback title for null", () => {
    assert.equal(deriveTitle(null), "Issue from Slack");
  });

  test("trims whitespace from the first line", () => {
    assert.equal(deriveTitle("  padded title  \nother"), "padded title");
  });

  test("returns fallback when first line is only whitespace", () => {
    assert.equal(deriveTitle("   \nsecond line"), "Issue from Slack");
  });
});
