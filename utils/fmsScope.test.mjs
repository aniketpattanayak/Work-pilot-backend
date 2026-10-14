// Plain-Node tests for fmsScope.js. Run with: node utils/fmsScope.test.mjs
import assert from "node:assert/strict";
import {
  isUnrestrictedFmsViewer,
  buildMappingIds,
  buildInvolvedOrClause,
  instanceInvolvesAnyOf,
} from "./fmsScope.js";

let passed = 0;
const test = (name, fn) => {
  fn();
  passed += 1;
  console.log(`ok - ${name}`);
};

// --- isUnrestrictedFmsViewer ---

test("superAdmin is unrestricted", () => {
  assert.equal(isUnrestrictedFmsViewer({ isSuperAdmin: true, roles: [] }), true);
});

test("Admin role is unrestricted", () => {
  assert.equal(isUnrestrictedFmsViewer({ roles: ["Admin"] }), true);
});

test("viewer-only (single Viewer role) is unrestricted", () => {
  assert.equal(isUnrestrictedFmsViewer({ roles: ["Viewer"] }), true);
});

test("plain Coordinator role is restricted", () => {
  assert.equal(isUnrestrictedFmsViewer({ roles: ["Coordinator"] }), false);
});

test("Viewer + another role is NOT viewer-only, so restricted", () => {
  assert.equal(isUnrestrictedFmsViewer({ roles: ["Viewer", "Coordinator"] }), false);
});

test("no user / empty roles is restricted (safe default)", () => {
  assert.equal(isUnrestrictedFmsViewer(null), false);
  assert.equal(isUnrestrictedFmsViewer({ roles: [] }), false);
});

// --- buildMappingIds ---

test("combines managedDoers + managedAssigners, no self", () => {
  const ids = buildMappingIds({ _id: "me", managedDoers: ["a", "b"], managedAssigners: ["c"] });
  assert.deepEqual(ids, ["a", "b", "c"]);
});

test("missing arrays default to empty", () => {
  assert.deepEqual(buildMappingIds({}), []);
  assert.deepEqual(buildMappingIds(null), []);
});

// --- buildInvolvedOrClause ---

test("empty idList returns null (so caller can short-circuit to no instances)", () => {
  assert.equal(buildInvolvedOrClause([]), null);
  assert.equal(buildInvolvedOrClause(null), null);
});

test("builds $or clause covering activeStep, nodeHistory assignee and completer", () => {
  const clause = buildInvolvedOrClause(["a", "b"]);
  assert.equal(clause.length, 3);
  assert.deepEqual(clause[0], { "activeStep.assignedToId": { $in: ["a", "b"] } });
  assert.deepEqual(clause[1], { "nodeHistory.assignedToId": { $in: ["a", "b"] } });
  assert.deepEqual(clause[2], { "nodeHistory.completedById": { $in: ["a", "b"] } });
});

test("stringifies ids for the String-typed assignedToId paths", () => {
  const clause = buildInvolvedOrClause([123, "456"]);
  assert.deepEqual(clause[0]["activeStep.assignedToId"].$in, ["123", "456"]);
});

// --- instanceInvolvesAnyOf ---

test("true when activeStep.assignedToId matches", () => {
  const instance = { activeStep: { assignedToId: "a" }, nodeHistory: [] };
  assert.equal(instanceInvolvesAnyOf(instance, ["a", "b"]), true);
});

test("true when a past nodeHistory assignedToId matches", () => {
  const instance = { activeStep: null, nodeHistory: [{ assignedToId: "x" }] };
  assert.equal(instanceInvolvesAnyOf(instance, ["x"]), true);
});

test("true when a past nodeHistory completedById matches", () => {
  const instance = { activeStep: null, nodeHistory: [{ completedById: "y" }] };
  assert.equal(instanceInvolvesAnyOf(instance, ["y"]), true);
});

test("false when nothing matches", () => {
  const instance = {
    activeStep: { assignedToId: "a" },
    nodeHistory: [{ assignedToId: "b", completedById: "c" }],
  };
  assert.equal(instanceInvolvesAnyOf(instance, ["z"]), false);
});

test("false for empty/missing idList or instance", () => {
  assert.equal(instanceInvolvesAnyOf(null, ["a"]), false);
  assert.equal(instanceInvolvesAnyOf({}, []), false);
});

console.log(`\n${passed} tests passed`);
