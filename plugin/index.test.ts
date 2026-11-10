import { after, before, test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { PolicyStore, Vault } from "oc-secure-kit"
import plugin, { createPlugin, parseOptions, PLUGIN_ID } from "./index.js"
import { INSTRUCTIONS, startFakeRhythms, type FakeRhythms } from "./testrhythms.js"

const EMAIL = "pat.lee@acme.example"
const dirs: string[] = []
let fake: FakeRhythms
before(async () => { fake = await startFakeRhythms({ members: [EMAIL] }) })
after(async () => { await fake.stop(); await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))) })

type Effect = "allow" | "ask" | "deny"
type Tool = { name: string; description: string; execute: (input: unknown, context: unknown) => Promise<{ content: string }> }

async function host(reply: "approve" | "reject" = "approve", options: Record<string, unknown> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ocr-"))
  dirs.push(dir)
  const hooks = { evaluate: [] as any[], after: [] as any[] }
  const transforms: ((editor: any) => void)[] = []
  const skillTransforms: ((editor: any) => void)[] = []
  const tools = new Map<string, Tool>()
  const skills: { id: string; content: string }[] = []
  const prompts: { action: string; resources: string[]; metadata?: Record<string, unknown> }[] = []
  let rpc: any
  const registration = (list: unknown[], item: unknown) => { list.push(item); return { dispose: async () => { const i = list.indexOf(item); if (i >= 0) list.splice(i, 1) } } }
  const rebuild = () => { tools.clear(); for (const transform of transforms) transform({ add: (tool: Tool) => tools.set(tool.name, tool) }) }
  const rebuildSkills = () => { skills.length = 0; for (const transform of skillTransforms) transform({ add: (skill: any) => skills.push(skill) }) }
  const ctx = {
    options: { dataDirectory: dir, mcpUrl: fake.mcpUrl, ...options },
    session: { get: async () => ({ parentID: undefined }) },
    permission: {
      hook: async (_: string, callback: any) => registration(hooks.evaluate, callback),
      assert: async (input: any) => {
        const event = { ...input, effect: "allow" as Effect }
        for (const hook of hooks.evaluate) await hook(event)
        if (event.effect === "deny") throw new Error(event.message ?? "denied")
        if (event.effect === "ask") { prompts.push({ action: input.action, resources: input.resources, metadata: input.metadata }); if (reply === "reject") throw new Error("rejected by user") }
      },
    },
    tool: {
      transform: async (callback: any) => { transforms.push(callback); rebuild(); return { dispose: async () => { transforms.splice(transforms.indexOf(callback), 1); rebuild() } } },
      reload: async () => rebuild(),
      hook: async (_: string, callback: any) => registration(hooks.after, callback),
    },
    skill: {
      transform: async (callback: any) => { skillTransforms.push(callback); rebuildSkills(); return { dispose: async () => { skillTransforms.splice(skillTransforms.indexOf(callback), 1); rebuildSkills() } } },
      reload: async () => rebuildSkills(),
    },
    event: { subscribe: () => (async function* () {})() },
    agent: { list: async () => ({ data: [{ id: "build", name: "build", mode: "primary", hidden: false }] }) },
    rpc: { register: async (_: unknown, handlers: any) => { rpc = handlers; return { dispose: async () => { rpc = undefined } } } },
  }
  const cleanup = await createPlugin().setup(ctx as unknown as Plugin.Context) as () => Promise<void>
  let n = 0
  const call = async (name: string, input: unknown, agent = "build") => {
    const tool = tools.get(name)
    if (!tool) throw new Error(`no tool ${name}`)
    const c = { sessionID: "s", agent, messageID: "m", id: `c${++n}`, signal: new AbortController().signal, progress: async () => {} }
    let event: any
    try { event = { tool: name, id: c.id, input, status: "completed", result: await tool.execute(input, c) } }
    catch (error) { event = { tool: name, id: c.id, input, status: "error", error } }
    for (const hook of hooks.after) await hook(event)
    if (event.status === "error") throw event.error
    const text = event.result.content
    try { return JSON.parse(text) } catch { return text }
  }
  const settle = async (id: string, done: (account: any) => boolean) => {
    for (let i = 0; i < 100; i++) { const list = await call("rhythms_list", {}); const account = list.accounts.find((a: { id: string }) => a.id === id); if (account && done(account)) return account; await new Promise(r => setTimeout(r, 30)) }
    throw new Error("sign-in did not settle")
  }
  /** Signs in through the browser flow, approving like a user would (optionally as a different email). */
  const signedIn = async (id = "work", as?: string, email: string | null = EMAIL) => {
    await call("rhythms_account_upsert", { id, ...(email && { email }) })
    const started = await call("rhythms_signin", { account: id })
    const url = /(http\S+\/oauth2\/authorize\S+)/.exec(started.tellUser)![1]!
    await fake.approve(url, as)
    return settle(id, account => account.signedInAs || account.problem)
  }
  return { dir, tools, skills, prompts, call, signedIn, cleanup, rpc: () => rpc, policy: () => PolicyStore.open(dir), vault: () => Vault.open({ dir, plugin: PLUGIN_ID }) }
}

test("identity, tools, skill, and safe failure", async () => {
  assert.equal(plugin.id, PLUGIN_ID)
  const h = await host()
  assert.equal(h.tools.size, 7)
  assert.equal(h.skills[0]!.id, "rhythms")
  assert.match(h.skills[0]!.content, /My goals/)
  assert.doesNotMatch(h.skills[0]!.content, /own guidance/, "no server guidance before sign-in")
  assert.match(h.tools.get("rhythms_list")!.description, /No Rhythms accounts are configured yet/)
  await h.cleanup()
  assert.equal(h.tools.size, 0)
  const broken = await host("approve", { dataDirectory: "relative" })
  assert.equal(broken.tools.size, 0)
  assert.throws(() => parseOptions({ mcpUrl: "ftp://x" }), /http/)
})

test("browser sign-in as a public client; identity, workspace and server guidance discovered", async () => {
  const h = await host()
  const work = await h.signedIn()
  assert.equal(fake.lastAuthorize()!.get("login_hint"), EMAIL, "sign-in pre-filled with the account's email")
  assert.equal(fake.lastAuthorize()!.get("scope"), "openid profile email offline_access")
  assert.equal(work.signedInAs, `Pat Lee <${EMAIL}>`)
  assert.equal(work.workspace, "Acme")
  assert.equal(work.tenantUuid, fake.tenantUuid)
  assert.equal(work.actions, 8)
  assert.equal(work.problem, undefined)
  assert.doesNotMatch(JSON.stringify(work), /access_token|refresh/, "tokens never reach the agent")
  await new Promise(r => setTimeout(r, 30))
  assert.match(h.tools.get("rhythms_list")!.description, /work: Pat Lee <pat\.lee@acme\.example> in workspace Acme; 8 actions/)
  assert.ok(h.skills[0]!.content.includes(INSTRUCTIONS.split("\n").at(-1)!), "server guidance added to the skill")
})

test("find and run actions; permissions ask for deletes, sharing and delegating", async () => {
  const h = await host()
  await h.signedIn()
  const found = await h.call("rhythms_find_actions", { query: "my goals" })
  assert.equal(found.actions[0].name, "search_knowledge")
  assert.equal(found.actions[0].kind, "goals-read")
  const schema = await h.call("rhythms_find_actions", { names: ["search_knowledge", "nope"] })
  assert.deepEqual(schema.actions[0].parameters.required, ["type"])
  assert.deepEqual(schema.actions[1], { name: "nope", missing: true })
  const goals = await h.call("rhythms_run", { action: "search_knowledge", arguments: { type: "goal", my_role_in: ["owner"] } })
  assert.equal(goals.data.goals[0].short_id, "OBJ-7")
  await h.call("rhythms_run", { action: "create_checkin", arguments: { goal_uuid: "g-1", value: 60 } })
  assert.deepEqual(h.prompts, [], "reads and check-ins allowed by default")
  await h.call("rhythms_run", { action: "delete_goals", arguments: { goal_uuids: ["g-1"] } })
  await h.call("rhythms_run", { action: "share_goals", arguments: {} })
  await h.call("rhythms_run", { action: "answer_and_act_across_apps", arguments: { request: "x", request_id: "1" } })
  assert.deepEqual((h.prompts as { action: string; metadata?: Record<string, unknown> }[]).map(p => [p.action, p.metadata?.action]), [["oc-rhythms.goals-delete", "delete_goals"], ["oc-rhythms.goals-admin", "share_goals"], ["oc-rhythms.delegate", "answer_and_act_across_apps"]])
  await (await h.policy()).setCells([{ entity: "work", row: { agent: "plan" }, capability: "goals-write", effect: "deny" }])
  await assert.rejects(h.call("rhythms_run", { action: "create_checkin", arguments: {} }, "plan"), /Denied by the oc-rhythms permissions table \(goals-write on work\)/)
  await assert.rejects(h.call("rhythms_run", { action: "create_chekin", arguments: {} }), /Did you mean: create_checkin/)
  await assert.rejects(h.call("rhythms_run", { action: "get_goal", arguments: { goal_uuid: "NOPE" } }), /get_goal failed: Goal not found/)
  const rejecting = await host("reject")
  await rejecting.signedIn()
  await assert.rejects(rejecting.call("rhythms_run", { action: "delete_goals", arguments: {} }), /rejected by user/)
})

test("5-minute tokens are refreshed transparently, with rotating refresh tokens", async () => {
  const h = await host()
  await h.signedIn()
  const vault = await h.vault()
  const before = { access: await vault.get("work", "access-token"), refresh: await vault.get("work", "refresh-token") }
  for (let round = 0; round < 2; round++) {
    fake.expireTokens()
    const goals = await h.call("rhythms_run", { action: "search_knowledge", arguments: { type: "goal" } })
    assert.ok(goals.data.goals.length)
  }
  assert.notEqual(await vault.get("work", "access-token"), before.access)
  assert.notEqual(await vault.get("work", "refresh-token"), before.refresh, "rotated refresh token stored")
})

test("signing in with the wrong email is explained, not silently accepted", async () => {
  const h = await host()
  const uninvited = await h.signedIn("work", "pat@personal.example")
  assert.match(uninvited.problem, /different email.*expected pat\.lee@acme\.example/)
  const run = await h.call("rhythms_run", { action: "search_knowledge", arguments: { type: "goal" } })
  assert.match(run, /account_setup_required[\s\S]*Note: Rhythms does not see a workspace/)
  const other = await startFakeRhythms({ members: [EMAIL, "someone@acme.example"] })
  try {
    const h2 = await host("approve", { mcpUrl: other.mcpUrl })
    await h2.call("rhythms_account_upsert", { id: "work", email: EMAIL })
    const started = await h2.call("rhythms_signin", { account: "work" })
    await other.approve(/(http\S+\/oauth2\/authorize\S+)/.exec(started.tellUser)![1]!, "someone@acme.example")
    for (let i = 0; i < 100 && !(await h2.call("rhythms_list", {})).accounts[0].problem; i++) await new Promise(r => setTimeout(r, 30))
    assert.match((await h2.call("rhythms_list", {})).accounts[0].problem, /Signed in as someone@acme\.example, but this account is set to pat\.lee@acme\.example/)
  } finally { await other.stop() }
})

test("several accounts: the agent must pick, or a default applies", async () => {
  const h = await host()
  await h.signedIn("work")
  await h.call("rhythms_account_upsert", { id: "other" })
  await assert.rejects(h.call("rhythms_find_actions", { query: "goal" }), /Several Rhythms accounts exist .* Pass account=<id>/)
  assert.ok((await h.call("rhythms_find_actions", { account: "work", query: "goal" })).actions.length)
  await h.rpc().setDefault({ id: "work" })
  assert.ok((await h.call("rhythms_find_actions", { query: "goal" })).actions.length)
})

test("GUI admin: sign-in from the GUI, email, sign-out, export and import", async () => {
  const h = await host()
  await h.rpc().createAccount({ id: "work" })
  await h.rpc().setEmail({ id: "work", email: EMAIL })
  const started = await h.rpc().signIn({ id: "work" })
  assert.equal((await h.rpc().state({ sessionID: "s" })).accounts[0].signIn.status, "waiting")
  await fake.approve(started.url)
  for (let i = 0; i < 100 && !(await h.rpc().state({})).accounts[0].who; i++) await new Promise(r => setTimeout(r, 30))
  const state = await h.rpc().state({ sessionID: "s" })
  assert.equal(state.accounts[0].who, "Pat Lee")
  assert.equal(state.accounts[0].workspace, "Acme")
  assert.equal(state.accounts[0].signIn, undefined)
  const token = (await (await h.vault()).get("work", "access-token"))!
  assert.ok(!JSON.stringify(state).includes(token), "tokens never reach the GUI")
  await h.rpc().setCells({ changes: [{ entity: "work", capability: "goals-delete", effect: "deny", agent: "*" }] })
  const exported = await h.rpc().exportBundle({ passphrase: "export passphrase 1" })
  const other = await host()
  const preview = await other.rpc().previewImport({ content: exported.content, passphrase: "export passphrase 1" })
  assert.deepEqual(preview.accounts, [{ id: "work", status: "added" }])
  await other.rpc().applyImport({ content: exported.content, passphrase: "export passphrase 1", mode: "merge" })
  for (let i = 0; i < 100 && !(await other.rpc().state({})).accounts[0]?.who; i++) await new Promise(r => setTimeout(r, 30))
  const imported = await other.rpc().state({})
  assert.equal(imported.accounts[0].who, "Pat Lee", "the imported sign-in works on the new install")
  assert.equal(imported.cells.work["*"]["goals-delete"], "deny")
  await h.rpc().signOut({ id: "work" })
  assert.equal((await h.rpc().state({})).accounts[0].signedIn, false)
  await assert.rejects(h.call("rhythms_run", { action: "whoami", arguments: {} }), /not signed in to Rhythms\. Call rhythms_signin/)
})
