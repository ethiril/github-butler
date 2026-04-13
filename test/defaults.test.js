import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { getUserDefaults, setUserDefaults, clearDefaults } from "../src/defaults.js";

beforeEach(() => clearDefaults());

test("getUserDefaults returns nulled-out defaults for an unknown user", () => {
  const defaults = getUserDefaults("unknown-user");
  assert.deepEqual(defaults, {
    repo: null,
    projectId: null,
    milestoneValue: null,
    labelValues: [],
  });
});

test("setUserDefaults persists and getUserDefaults retrieves them", () => {
  setUserDefaults("U123", {
    repo: "my-repo",
    projectId: "proj-id",
    milestoneValue: "3",
    labelValues: ["bug", "enhancement"],
  });
  const defaults = getUserDefaults("U123");
  assert.equal(defaults.repo, "my-repo");
  assert.equal(defaults.projectId, "proj-id");
  assert.equal(defaults.milestoneValue, "3");
  assert.deepEqual(defaults.labelValues, ["bug", "enhancement"]);
});

test("clearDefaults resets all stored users", () => {
  setUserDefaults("U1", { repo: "r", projectId: "p", milestoneValue: "1", labelValues: [] });
  clearDefaults();
  const defaults = getUserDefaults("U1");
  assert.equal(defaults.repo, null);
});

test("defaults are isolated per user", () => {
  setUserDefaults("U1", { repo: "repo-a", projectId: null, milestoneValue: null, labelValues: [] });
  setUserDefaults("U2", { repo: "repo-b", projectId: null, milestoneValue: null, labelValues: [] });
  assert.equal(getUserDefaults("U1").repo, "repo-a");
  assert.equal(getUserDefaults("U2").repo, "repo-b");
});
