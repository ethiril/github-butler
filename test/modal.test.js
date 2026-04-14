import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { toSlackOption, resolveDefaultProjectId, buildProjectFieldMap, buildModal, buildAddToIssueModal } from "../src/modal.js";

// ── toSlackOption ─────────────────────────────────────────────────────────────

describe("toSlackOption", () => {
  test("produces correct plain_text and value structure", () => {
    const option = toSlackOption("My Label", "my-label");
    assert.deepEqual(option, {
      text: { type: "plain_text", text: "My Label" },
      value: "my-label",
    });
  });

  test("truncates display text at 75 characters", () => {
    const option = toSlackOption("a".repeat(100), "val");
    assert.equal(option.text.text.length, 75);
  });

  test("coerces numeric displayText and value to strings", () => {
    const option = toSlackOption(42, 99);
    assert.equal(option.text.text, "42");
    assert.equal(option.value, "99");
  });
});

// ── resolveDefaultProjectId ───────────────────────────────────────────────────

describe("resolveDefaultProjectId", () => {
  const projects = [
    { text: "Alpha", value: "id-alpha" },
    { text: "Beta", value: "id-beta" },
  ];

  test("returns userProjectId when it exists in projects list", () => {
    assert.equal(resolveDefaultProjectId(projects, "id-beta", null), "id-beta");
  });

  test("ignores userProjectId that is not in the projects list", () => {
    assert.equal(resolveDefaultProjectId(projects, "id-missing", null), null);
  });

  test("falls back to defaultProjectName match when userProjectId is absent", () => {
    assert.equal(resolveDefaultProjectId(projects, null, "Alpha"), "id-alpha");
  });

  test("returns null when neither userProjectId nor defaultProjectName matches", () => {
    assert.equal(resolveDefaultProjectId(projects, null, "Nonexistent"), null);
  });

  test("returns null when projects list is empty", () => {
    assert.equal(resolveDefaultProjectId([], "id-alpha", "Alpha"), null);
  });

  test("userProjectId takes priority over defaultProjectName", () => {
    assert.equal(resolveDefaultProjectId(projects, "id-alpha", "Beta"), "id-alpha");
  });
});

// ── buildProjectFieldMap ──────────────────────────────────────────────────────

describe("buildProjectFieldMap", () => {
  test("creates pf_N keyed entries with id and dataType", () => {
    const fields = [
      { id: "field-1", name: "Priority", dataType: "SINGLE_SELECT", options: [] },
      { id: "field-2", name: "Min", dataType: "NUMBER" },
    ];
    assert.deepEqual(buildProjectFieldMap(fields), {
      pf_0: { id: "field-1", dataType: "SINGLE_SELECT" },
      pf_1: { id: "field-2", dataType: "NUMBER" },
    });
  });

  test("returns empty object for empty array", () => {
    assert.deepEqual(buildProjectFieldMap([]), {});
  });
});

// ── buildModal ────────────────────────────────────────────────────────────────

describe("buildModal", () => {
  test("always starts with repo_block", () => {
    const modal = buildModal({ metadata: {} });
    assert.equal(modal.blocks[0].block_id, "repo_block");
  });

  test("shows context hint when no repo is selected", () => {
    const modal = buildModal({ metadata: {} });
    const hasHint = modal.blocks.some((b) => b.type === "context");
    assert.ok(hasHint);
  });

  test("omits context hint when a repo is selected", () => {
    const modal = buildModal({ metadata: {}, selectedRepo: "my-repo" });
    const hasHint = modal.blocks.some((b) => b.type === "context");
    assert.ok(!hasHint);
  });

  test("title block comes before body block", () => {
    const modal = buildModal({ metadata: {} });
    const ids = modal.blocks.map((b) => b.block_id);
    assert.ok(ids.indexOf("title_block") < ids.indexOf("body_block"));
  });

  test("pre-fills body with messageText when currentBody is absent", () => {
    const modal = buildModal({ metadata: {}, messageText: "Hello from Slack" });
    const bodyBlock = modal.blocks.find((b) => b.block_id === "body_block");
    assert.equal(bodyBlock.element.initial_value, "Hello from Slack");
  });

  test("currentBody takes precedence over messageText", () => {
    const modal = buildModal({ metadata: {}, messageText: "Slack msg", currentBody: "Custom body" });
    const bodyBlock = modal.blocks.find((b) => b.block_id === "body_block");
    assert.equal(bodyBlock.element.initial_value, "Custom body");
  });

  test("omits labels block when labels array is empty", () => {
    const modal = buildModal({ metadata: {}, selectedRepo: "repo" });
    assert.ok(!modal.blocks.some((b) => b.block_id === "labels_block"));
  });

  test("includes labels block with initial_options when labels are provided", () => {
    const labels = [{ text: "bug", value: "bug" }, { text: "feature", value: "feature" }];
    const modal = buildModal({ metadata: {}, selectedRepo: "repo", labels, initialLabelValues: ["bug"] });
    const labelsBlock = modal.blocks.find((b) => b.block_id === "labels_block");
    assert.ok(labelsBlock);
    assert.equal(labelsBlock.element.initial_options.length, 1);
    assert.equal(labelsBlock.element.initial_options[0].value, "bug");
  });

  test("project block is mandatory (no optional property)", () => {
    const projects = [{ text: "My Project", value: "pid" }];
    const modal = buildModal({ metadata: {}, selectedRepo: "repo", projects });
    const projectBlock = modal.blocks.find((b) => b.block_id === "project_block");
    assert.ok(projectBlock);
    assert.ok(!("optional" in projectBlock));
  });

  test("project block pre-selects initialProjectId", () => {
    const projects = [
      { text: "Alpha", value: "id-alpha" },
      { text: "Beta", value: "id-beta" },
    ];
    const modal = buildModal({ metadata: {}, selectedRepo: "repo", projects, initialProjectId: "id-beta" });
    const projectBlock = modal.blocks.find((b) => b.block_id === "project_block");
    assert.equal(projectBlock.element.initial_option.value, "id-beta");
  });

  test("Priority project field is mandatory", () => {
    const projectFields = [
      { id: "f1", name: "Priority", dataType: "SINGLE_SELECT", options: [{ id: "o1", name: "High" }] },
    ];
    const modal = buildModal({ metadata: {}, selectedRepo: "repo", projectFields });
    const priorityBlock = modal.blocks.find((b) => b.block_id === "pf_0");
    assert.ok(!("optional" in priorityBlock));
  });

  test("non-Priority single-select project fields are optional", () => {
    const projectFields = [
      { id: "f1", name: "Type", dataType: "SINGLE_SELECT", options: [{ id: "o1", name: "Bug" }] },
    ];
    const modal = buildModal({ metadata: {}, selectedRepo: "repo", projectFields });
    const typeBlock = modal.blocks.find((b) => b.block_id === "pf_0");
    assert.equal(typeBlock.optional, true);
  });

  test("Status field defaults to Backlog option", () => {
    const projectFields = [
      {
        id: "f1",
        name: "Status",
        dataType: "SINGLE_SELECT",
        options: [
          { id: "o1", name: "In Progress" },
          { id: "o2", name: "Backlog" },
          { id: "o3", name: "Done" },
        ],
      },
    ];
    const modal = buildModal({ metadata: {}, selectedRepo: "repo", projectFields });
    const statusBlock = modal.blocks.find((b) => b.block_id === "pf_0");
    assert.equal(statusBlock.element.initial_option?.value, "o2");
  });

  test("Status field has no default when Backlog option is absent", () => {
    const projectFields = [
      {
        id: "f1",
        name: "Status",
        dataType: "SINGLE_SELECT",
        options: [{ id: "o1", name: "In Progress" }],
      },
    ];
    const modal = buildModal({ metadata: {}, selectedRepo: "repo", projectFields });
    const statusBlock = modal.blocks.find((b) => b.block_id === "pf_0");
    assert.ok(!("initial_option" in statusBlock.element));
  });

  test("project fields appear before parent_issue_block", () => {
    const projectFields = [
      { id: "f1", name: "Priority", dataType: "SINGLE_SELECT", options: [{ id: "o1", name: "High" }] },
    ];
    const modal = buildModal({ metadata: {}, selectedRepo: "repo", projectFields });
    const ids = modal.blocks.map((b) => b.block_id);
    assert.ok(ids.indexOf("pf_0") < ids.indexOf("parent_issue_block"));
  });

  test("parent_issue_block only appears when repo is selected", () => {
    const withoutRepo = buildModal({ metadata: {} });
    assert.ok(!withoutRepo.blocks.some((b) => b.block_id === "parent_issue_block"));

    const withRepo = buildModal({ metadata: {}, selectedRepo: "repo" });
    assert.ok(withRepo.blocks.some((b) => b.block_id === "parent_issue_block"));
  });

  test("template block appears when templates are provided", () => {
    const templates = [{ name: "Bug Report" }];
    const modal = buildModal({ metadata: {}, templates });
    assert.ok(modal.blocks.some((b) => b.block_id === "template_block"));
  });

  test("private_metadata is the JSON-serialised metadata param", () => {
    const metadata = { channelId: "C123", userId: "U456", projectFieldMap: {} };
    const modal = buildModal({ metadata });
    assert.deepEqual(JSON.parse(modal.private_metadata), metadata);
  });

  test("thread_block appears when metadata has threadTs", () => {
    const modal = buildModal({ metadata: { threadTs: "123.456" } });
    assert.ok(modal.blocks.some((b) => b.block_id === "thread_block"));
  });

  test("thread_block is absent when metadata has no threadTs", () => {
    const modal = buildModal({ metadata: {} });
    assert.ok(!modal.blocks.some((b) => b.block_id === "thread_block"));
  });

  test("thread_block comes after body_block", () => {
    const modal = buildModal({ metadata: { threadTs: "123.456" } });
    const ids = modal.blocks.map((b) => b.block_id);
    assert.ok(ids.indexOf("body_block") < ids.indexOf("thread_block"));
  });
});

// ── buildAddToIssueModal ──────────────────────────────────────────────────────

describe("buildAddToIssueModal", () => {
  test("has callback_id add_to_issue_modal", () => {
    const modal = buildAddToIssueModal({ metadata: {} });
    assert.equal(modal.callback_id, "add_to_issue_modal");
  });

  test("contains repo, issue number, and body blocks", () => {
    const modal = buildAddToIssueModal({ metadata: {} });
    const ids = modal.blocks.map((b) => b.block_id);
    assert.ok(ids.includes("repo_block"));
    assert.ok(ids.includes("issue_number_block"));
    assert.ok(ids.includes("body_block"));
  });

  test("pre-fills body with messageText", () => {
    const modal = buildAddToIssueModal({ messageText: "bug found here", metadata: {} });
    const bodyBlock = modal.blocks.find((b) => b.block_id === "body_block");
    assert.equal(bodyBlock.element.initial_value, "bug found here");
  });

  test("currentBody takes precedence over messageText", () => {
    const modal = buildAddToIssueModal({ messageText: "original", currentBody: "edited", metadata: {} });
    const bodyBlock = modal.blocks.find((b) => b.block_id === "body_block");
    assert.equal(bodyBlock.element.initial_value, "edited");
  });

  test("thread_block appears when metadata has threadTs", () => {
    const modal = buildAddToIssueModal({ metadata: { threadTs: "123.456" } });
    assert.ok(modal.blocks.some((b) => b.block_id === "thread_block"));
  });

  test("thread_block is absent when no threadTs", () => {
    const modal = buildAddToIssueModal({ metadata: {} });
    assert.ok(!modal.blocks.some((b) => b.block_id === "thread_block"));
  });

  test("repo_block uses repo_select action_id for shared options handler", () => {
    const modal = buildAddToIssueModal({ metadata: {} });
    const repoBlock = modal.blocks.find((b) => b.block_id === "repo_block");
    assert.equal(repoBlock.element.action_id, "repo_select");
  });
});
