import { test } from "node:test"
import assert from "node:assert/strict"
import { classifyAction, defaultEffect, normalizeAccount } from "./model.js"
import { skillContent } from "./index.js"
import { setupHint } from "./service.js"
import { searchActions } from "./tools.js"

test("accounts: email normalized and validated", () => {
  assert.deepEqual(normalizeAccount({ id: "work", email: "Joshua.Powers@ASI.example " }, new Date(0)), { id: "work", email: "joshua.powers@asi.example", updatedAt: "1970-01-01T00:00:00.000Z" })
  assert.throws(() => normalizeAccount({ id: "w", email: "nope" }), /email/)
  assert.throws(() => normalizeAccount({ id: "w", token: "x" }), /Unknown account field/)
  assert.throws(() => normalizeAccount({ id: "bad id" }), /account id/)
})

test("actions are classified by area and verb (all 73 real Rhythms actions spot-checked)", () => {
  const ro = { readOnlyHint: true }
  const cases: [string, object, string][] = [
    ["search_knowledge", ro, "goals-read"], ["get_goal", ro, "goals-read"], ["list_time_periods", ro, "goals-read"],
    ["create_goals", {}, "goals-write"], ["create_checkin", {}, "goals-write"], ["archive_goals", {}, "goals-write"],
    ["delete_goals", { destructiveHint: true }, "goals-delete"], ["leave_goal_contribution", { destructiveHint: true }, "goals-delete"],
    ["share_goals", {}, "goals-admin"], ["publish_draft_okrs", {}, "goals-admin"], ["manage_time_period", { destructiveHint: true }, "goals-admin"],
    ["get_document_section", ro, "documents-read"], ["search_comments", ro, "documents-read"], ["edit_document_content", { destructiveHint: true }, "documents-write"],
    ["manage_document_labels", {}, "documents-write"], ["delete_document", { destructiveHint: true }, "documents-delete"], ["unshare_document", { destructiveHint: true }, "documents-delete"],
    ["share_document", {}, "documents-admin"], ["whoami", ro, "people-read"], ["search_users", ro, "people-read"], ["invite_users", {}, "people-admin"],
    ["manage_team", { destructiveHint: true }, "people-admin"], ["get_view_data", ro, "workspace-read"], ["create_view", {}, "workspace-write"],
    ["join_workspace", {}, "workspace-admin"], ["answer_and_act_across_apps", { destructiveHint: true }, "delegate"], ["continue_work", {}, "delegate"],
    ["get_work", ro, "other-read"], ["install_solution", {}, "other-admin"], ["brand_new_thing", {}, "other-write"], ["brand_new_lookup", ro, "other-read"],
  ]
  for (const [name, annotations, expected] of cases) assert.equal(classifyAction(name, annotations), expected, name)
})

test("defaults: reads and writes allowed; deletes, admin, delegating, unknown writes and removal ask", () => {
  for (const capability of ["goals-read", "goals-write", "documents-write", "manage"]) assert.equal(defaultEffect(capability), "allow")
  for (const capability of ["goals-delete", "people-admin", "delegate", "other-write", "remove"]) assert.equal(defaultEffect(capability), "ask")
})

test("action search and the uninvited-sign-in hint", () => {
  const tools = [{ name: "create_checkin", description: "Create a goal check-in." }, { name: "list_goal_checkins", description: "check-in history" }, { name: "get_document", description: "doc" }]
  assert.deepEqual(searchActions(tools, "checkins").map(tool => tool.name), ["create_checkin", "list_goal_checkins"])
  assert.match(setupHint('{"status":"error","error":{"code":"account_setup_required"}}', { id: "w", email: "a@b.co", updatedAt: "" })!, /different email.*expected a@b\.co.*Continue with email/)
  assert.equal(setupHint('{"status":"success","data":{"title":"workspace review"}}'), undefined)
  assert.match(skillContent("base", { w: { instructions: "# Rhythms MCP\n## Goals\nconfirm" } }), /Rhythms' own guidance[\s\S]*### Rhythms MCP\n### Goals/)
  assert.equal(skillContent("base", {}), "base")
})
