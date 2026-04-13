import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { normalizeYamlLabels, parseIssueTemplate, createGitHubHelpers } from "../src/github.js";

// ── normalizeYamlLabels ───────────────────────────────────────────────────────

describe("normalizeYamlLabels", () => {
  test("returns [] for null", () => {
    assert.deepEqual(normalizeYamlLabels(null), []);
  });

  test("returns [] for undefined", () => {
    assert.deepEqual(normalizeYamlLabels(undefined), []);
  });

  test("passes through a string array", () => {
    assert.deepEqual(normalizeYamlLabels(["bug", "enhancement"]), ["bug", "enhancement"]);
  });

  test("coerces non-string array values to strings", () => {
    assert.deepEqual(normalizeYamlLabels([1, 2]), ["1", "2"]);
  });

  test("splits a comma-separated string", () => {
    assert.deepEqual(normalizeYamlLabels("bug, feature, enhancement"), ["bug", "feature", "enhancement"]);
  });

  test("handles a single-value string", () => {
    assert.deepEqual(normalizeYamlLabels("bug"), ["bug"]);
  });

  test("strips empty segments from comma-separated string", () => {
    assert.deepEqual(normalizeYamlLabels("bug,,feature"), ["bug", "feature"]);
  });
});

// ── parseIssueTemplate ────────────────────────────────────────────────────────

describe("parseIssueTemplate", () => {
  function toBase64(str) {
    return Buffer.from(str).toString("base64");
  }

  test("parses a .md template with front matter", () => {
    const content = `---
name: Bug Report
title: '[Bug] '
labels: bug
---

## Description

Steps to reproduce.
`;
    const result = parseIssueTemplate(toBase64(content), "bug_report.md");
    assert.equal(result.name, "Bug Report");
    assert.equal(result.title, "[Bug] ");
    assert.deepEqual(result.labels, ["bug"]);
    assert.equal(result.body, "## Description\n\nSteps to reproduce.");
  });

  test("falls back to filename (minus extension) when name is missing", () => {
    const content = `---
title: '[Feature] '
---
`;
    const result = parseIssueTemplate(toBase64(content), "feature_request.md");
    assert.equal(result.name, "feature_request");
  });

  test("returns null for .md without front matter", () => {
    const result = parseIssueTemplate(toBase64("No front matter here."), "plain.md");
    assert.equal(result, null);
  });

  test("parses a .yml GitHub Forms template", () => {
    const content = `name: Feature Request
title: '[Feature] '
labels:
  - enhancement
  - feature
`;
    const result = parseIssueTemplate(toBase64(content), "feature.yml");
    assert.equal(result.name, "Feature Request");
    assert.equal(result.title, "[Feature] ");
    assert.deepEqual(result.labels, ["enhancement", "feature"]);
    assert.equal(result.body, "");
  });

  test("returns null for invalid YAML in .yml file", () => {
    const result = parseIssueTemplate(toBase64(": invalid: yaml:"), "bad.yml");
    assert.equal(result, null);
  });

  test("returns null for invalid YAML in .md front matter", () => {
    const content = `---
: bad yaml
---
body
`;
    const result = parseIssueTemplate(toBase64(content), "bad.md");
    assert.equal(result, null);
  });

  test("handles .yaml extension", () => {
    const content = `name: Question\ntitle: ''\nlabels: question\n`;
    const result = parseIssueTemplate(toBase64(content), "question.yaml");
    assert.equal(result.name, "Question");
    assert.deepEqual(result.labels, ["question"]);
  });
});

// ── createGitHubHelpers (unit tests with stub octokit) ───────────────────────

describe("createGitHubHelpers", () => {
  test("getRepos returns GITHUB_REPOS from env when set", async () => {
    const prev = process.env.GITHUB_REPOS;
    process.env.GITHUB_REPOS = "repo-a, repo-b, repo-c";
    try {
      const github = createGitHubHelpers({}, "test-owner");
      const repos = await github.getRepos();
      assert.deepEqual(repos, ["repo-a", "repo-b", "repo-c"]);
    } finally {
      if (prev === undefined) delete process.env.GITHUB_REPOS;
      else process.env.GITHUB_REPOS = prev;
    }
  });

  test("getLabels maps API response to {text, value} pairs", async () => {
    const mockOctokit = {
      paginate: async (fn, params) => {
        assert.equal(params.owner, "test-owner");
        assert.equal(params.repo, "my-repo");
        return [{ name: "bug" }, { name: "enhancement" }];
      },
      rest: { issues: { listLabelsForRepo: {} } },
    };
    const github = createGitHubHelpers(mockOctokit, "test-owner");
    const labels = await github.getLabels("my-repo");
    assert.deepEqual(labels, [
      { text: "bug", value: "bug" },
      { text: "enhancement", value: "enhancement" },
    ]);
  });

  test("getLabels returns [] when API throws", async () => {
    const mockOctokit = {
      paginate: async () => { throw new Error("API error"); },
      rest: { issues: { listLabelsForRepo: {} } },
    };
    const github = createGitHubHelpers(mockOctokit, "test-owner");
    const labels = await github.getLabels("my-repo");
    assert.deepEqual(labels, []);
  });

  test("getMilestones maps API response to {text, value} pairs", async () => {
    const mockOctokit = {
      paginate: async () => [
        { title: "v1.0", number: 1 },
        { title: "v2.0", number: 2 },
      ],
      rest: { issues: { listMilestones: {} } },
    };
    const github = createGitHubHelpers(mockOctokit, "test-owner");
    const milestones = await github.getMilestones("my-repo");
    assert.deepEqual(milestones, [
      { text: "v1.0", value: "1" },
      { text: "v2.0", value: "2" },
    ]);
  });

  test("getProjectFields filters out built-in field types", async () => {
    const mockOctokit = {
      graphql: async () => ({
        node: {
          fields: {
            nodes: [
              { id: "f1", name: "Title", dataType: "TITLE" },
              { id: "f2", name: "Priority", dataType: "SINGLE_SELECT", options: [] },
              { id: "f3", name: "Assignees", dataType: "ASSIGNEES" },
              { id: "f4", name: "Status", dataType: "SINGLE_SELECT", options: [] },
            ],
          },
        },
      }),
    };
    const github = createGitHubHelpers(mockOctokit, "test-owner");
    const fields = await github.getProjectFields("proj-id");
    assert.equal(fields.length, 2);
    assert.deepEqual(fields.map((f) => f.name), ["Priority", "Status"]);
  });
});
