import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  registerThreadIssue,
  getThreadIssue,
  updateThreadIssueSyncTs,
  markParentIncluded,
  clearThreadIssueMap,
} from "../src/thread-store.js";

describe("thread-store", () => {
  beforeEach(() => clearThreadIssueMap());

  test("getThreadIssue returns null for unknown threadTs", async () => {
    assert.equal(await getThreadIssue("unknown.ts"), null);
  });

  test("registerThreadIssue stores entry retrievable by getThreadIssue", async () => {
    await registerThreadIssue("1000.0", "my-repo", 42, "999.0");
    const entry = await getThreadIssue("1000.0");
    assert.equal(entry.repo, "my-repo");
    assert.equal(entry.issueNumber, 42);
    assert.equal(entry.lastSyncedTs, "999.0");
  });

  test("updateThreadIssueSyncTs updates lastSyncedTs for known threadTs", async () => {
    await registerThreadIssue("2000.0", "backend", 7, "1900.0");
    await updateThreadIssueSyncTs("2000.0", "2100.0");
    assert.equal((await getThreadIssue("2000.0")).lastSyncedTs, "2100.0");
  });

  test("updateThreadIssueSyncTs is a no-op for unknown threadTs", async () => {
    await assert.doesNotReject(() => updateThreadIssueSyncTs("nope.0", "1234.0"));
  });

  test("clearThreadIssueMap removes all entries", async () => {
    await registerThreadIssue("a.0", "repo-a", 1, "0.0");
    await registerThreadIssue("b.0", "repo-b", 2, "0.0");
    clearThreadIssueMap();
    assert.equal(await getThreadIssue("a.0"), null);
    assert.equal(await getThreadIssue("b.0"), null);
  });

  test("multiple threads are stored independently", async () => {
    await registerThreadIssue("t1.0", "repo-x", 10, "t0.0");
    await registerThreadIssue("t2.0", "repo-y", 20, "t0.0");
    assert.equal((await getThreadIssue("t1.0")).issueNumber, 10);
    assert.equal((await getThreadIssue("t2.0")).issueNumber, 20);
  });

  test("registering the same threadTs twice overwrites the previous entry", async () => {
    await registerThreadIssue("3000.0", "old-repo", 1, "0.0");
    await registerThreadIssue("3000.0", "new-repo", 99, "500.0");
    const entry = await getThreadIssue("3000.0");
    assert.equal(entry.repo, "new-repo");
    assert.equal(entry.issueNumber, 99);
  });

  test("parentIncluded defaults to false and persists when set", async () => {
    await registerThreadIssue("4000.0", "repo", 5, "3500.0");
    assert.equal((await getThreadIssue("4000.0")).parentIncluded, false);

    await registerThreadIssue("4001.0", "repo", 6, "3500.0", true);
    assert.equal((await getThreadIssue("4001.0")).parentIncluded, true);
  });

  test("markParentIncluded flips the flag for known threadTs", async () => {
    await registerThreadIssue("5000.0", "repo", 7, "4900.0");
    assert.equal((await getThreadIssue("5000.0")).parentIncluded, false);
    await markParentIncluded("5000.0");
    assert.equal((await getThreadIssue("5000.0")).parentIncluded, true);
  });

  test("markParentIncluded is a no-op for unknown threadTs", async () => {
    await assert.doesNotReject(() => markParentIncluded("missing.0"));
  });
});
