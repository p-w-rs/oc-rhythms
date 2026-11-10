import type { ToolContext } from "@opencode/plugin/promise/tool"
import type { McpToolInfo } from "oc-secure-kit"
import { classifyAction, mergeAccount, normalizeAccount, validAccountId, type Account, type Discovery } from "./model.js"
import { setupHint, type RhythmsService } from "./service.js"

export const TOOL_NAMES = [
  "rhythms_list", "rhythms_find_actions", "rhythms_run",
  "rhythms_account_upsert", "rhythms_account_remove", "rhythms_signin", "rhythms_refresh",
] as const

export interface ToolDefinition {
  readonly name: (typeof TOOL_NAMES)[number]
  readonly description: () => string
  readonly input: Record<string, unknown>
  readonly execute: (input: any, context: ToolContext) => Promise<{ content: string }>
}

const MAX_OUTPUT = 60_000
const json = (value: unknown) => ({ content: JSON.stringify(value, null, 2) })
const ACCOUNT = { type: "string", description: "Account id (optional when there is only one account)" }

export const USAGE = [
  "Load the 'rhythms' skill before non-trivial Rhythms work (finding goals, check-ins, documents, the Rhythms agent).",
  "Workflow: rhythms_find_actions to find an action (keyword), then names=[...] for its exact parameters, then rhythms_run.",
].join("\n")

function describe(account: Account, discovery: Discovery | undefined): string {
  const who = discovery?.name ? `${discovery.name}${discovery.email ? ` <${discovery.email}>` : ""}` : "not signed in"
  return `  ${account.id}: ${who}${discovery?.workspace ? ` in workspace ${discovery.workspace}` : ""}${discovery?.actions ? `; ${discovery.actions} actions` : ""}${account.label ? ` (${account.label})` : ""}${discovery?.error ? ` [problem: ${discovery.error.slice(0, 160)}]` : ""}`
}

export function inventory(accounts: readonly Account[], discovery: Record<string, Discovery>): string {
  if (!accounts.length) return "No Rhythms accounts are configured yet. Create one with rhythms_account_upsert (id, email), then rhythms_signin."
  return ["Rhythms accounts (OKRs/goals, check-ins, documents, teams):", ...accounts.map(account => describe(account, discovery[account.id]))].join("\n")
}

/** Ranks actions by how well they match a keyword query. */
export function searchActions(tools: readonly McpToolInfo[], query: string): McpToolInfo[] {
  const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 1).map(word => word.replace(/s$/, ""))
  if (!words.length) return [...tools]
  const phrase = query.toLowerCase().trim()
  const score = (tool: McpToolInfo) => {
    const name = tool.name.toLowerCase(), text = `${name} ${(tool.description ?? "").toLowerCase()}`
    return words.reduce((sum, word) => sum + (name.includes(word) ? 3 : text.includes(word) ? 1 : 0), 0) + (words.length > 1 && text.includes(phrase) ? 4 : 0)
  }
  return tools.map(tool => [tool, score(tool)] as const).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).map(([tool]) => tool)
}

const clip = (text: string) => text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…[truncated ${text.length - MAX_OUTPUT} characters; narrow the request (per_page, detail, a single section)]` : text
const summarize = (value: unknown) => { const text = JSON.stringify(value); return text.length > 400 ? `${text.slice(0, 400)}…` : text }
const kind = (tool: McpToolInfo) => classifyAction(tool.name, tool.annotations as never)

export function createTools(service: RhythmsService): ToolDefinition[] {
  const caller = (context: ToolContext) => ({ sessionID: context.sessionID, agent: context.agent, source: { type: "tool" as const, messageID: context.messageID, id: context.id } })
  const check = (context: ToolContext, capability: string, entity: string, metadata?: Record<string, unknown>) =>
    service.bridge.check({ ...caller(context), capability, entities: [entity], ...(metadata && { metadata }) })

  return [
    {
      name: "rhythms_list",
      description: () => {
        const { accounts, discovery } = service.store.cached()
        return `${inventory(accounts, discovery)}\n${USAGE}\nCall this tool for details and what you may do (allow / ask = the user is prompted / deny).`
      },
      input: { type: "object", properties: {}, additionalProperties: false },
      execute: async (_input, context) => {
        const settings = await service.store.settings()
        const accounts = await Promise.all((await service.store.list()).map(async account => {
          const discovery = await service.store.discovery(account.id)
          const signIn = service.signIns.get(account.id)
          const may = Object.fromEntries(await Promise.all(["goals-read", "goals-write", "goals-delete", "documents-read", "documents-write", "people-admin", "delegate"].map(async capability =>
            [capability, (await service.bridge.effect({ ...caller(context), capability, entity: account.id })).effect] as const)))
          return {
            id: account.id, ...(account.label && { label: account.label }), ...(account.email && { email: account.email }),
            signedInAs: discovery?.name ? `${discovery.name} <${discovery.email ?? "?"}>` : null, workspace: discovery?.workspace ?? null,
            ...(discovery?.tenantUuid && { tenantUuid: discovery.tenantUuid }), signedIn: await service.signedIn(account), actions: discovery?.actions ?? 0,
            ...(signIn?.status === "waiting" && { signIn: `waiting for the user: ${signIn.url}` }), ...(discovery?.error && { problem: discovery.error }),
            ...(settings.defaultAccount === account.id && { default: true }), youMay: may,
          }
        }))
        return json({ accounts, usage: USAGE })
      },
    },
    {
      name: "rhythms_find_actions",
      description: () => "Find Rhythms actions by keyword, e.g. 'my goals', 'check-in', 'document section', 'team', 'view'. Returns names, permission kind and summaries; pass names=[...] to get exact parameters before rhythms_run.",
      input: {
        type: "object",
        properties: { account: ACCOUNT, query: { type: "string", maxLength: 200 }, names: { type: "array", items: { type: "string" }, maxItems: 20 }, limit: { type: "integer", minimum: 1, maximum: 100 } },
        additionalProperties: false,
      },
      execute: async (input: { account?: string; query?: string; names?: string[]; limit?: number }) => {
        const account = await service.pick(input.account)
        const tools = await service.actions(account)
        if (input.names?.length) {
          return json({ account: account.id, actions: input.names.map(name => {
            const tool = tools.find(item => item.name === name)
            return tool ? { name: tool.name, kind: kind(tool), description: tool.description, parameters: tool.inputSchema } : { name, missing: true }
          }) })
        }
        const matches = searchActions(tools, input.query ?? "").slice(0, input.limit ?? 25)
        return json({
          account: account.id, total: tools.length,
          actions: matches.map(tool => ({ name: tool.name, kind: kind(tool), summary: (tool.description ?? "").replace(/\s+/g, " ").slice(0, 240) })),
          next: "Call rhythms_find_actions names=[...] for parameters, then rhythms_run.",
        })
      },
    },
    {
      name: "rhythms_run",
      description: () => "Run a Rhythms action found with rhythms_find_actions, e.g. action='search_knowledge' arguments={type:'goal', my_role_in:['owner']}. Deletes, sharing/admin changes and delegating to the Rhythms agent may ask the user first.",
      input: {
        type: "object",
        properties: { account: ACCOUNT, action: { type: "string", minLength: 1, maxLength: 120 }, arguments: { type: "object", additionalProperties: true } },
        required: ["action"], additionalProperties: false,
      },
      execute: async (input: { account?: string; action: string; arguments?: Record<string, unknown> }, context) => {
        const account = await service.pick(input.account)
        const tools = await service.actions(account)
        const tool = tools.find(item => item.name === input.action)
        if (!tool) {
          const near = searchActions(tools, input.action.replace(/_/g, " ")).slice(0, 5).map(item => item.name)
          throw new Error(`No action ${JSON.stringify(input.action)}.${near.length ? ` Did you mean: ${near.join(", ")}?` : ""} Use rhythms_find_actions.`)
        }
        await check(context, kind(tool), account.id, { action: tool.name, arguments: summarize(input.arguments ?? {}) })
        const result = await service.mcp(account).call(tool.name, input.arguments ?? {})
        const hint = setupHint(result.text, account)
        if (result.isError) throw new Error(`${tool.name} failed: ${clip(result.text)}${hint ? `\n${hint}` : ""}`)
        return { content: clip(result.text || "(no output)") + (hint ? `\n\nNote: ${hint}` : "") }
      },
    },
    {
      name: "rhythms_account_upsert",
      description: () => "Create or update a Rhythms account (fields merge; null clears). email: the address your Rhythms profile uses (it may differ from other tools' email); it pre-fills sign-in and is checked after sign-in. Never pass tokens.",
      input: {
        type: "object",
        properties: {
          id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$", maxLength: 64, description: "Name chosen by the user, e.g. work" },
          rename: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$", maxLength: 64 },
          email: { type: ["string", "null"] }, label: { type: ["string", "null"] }, notes: { type: ["string", "null"] },
        },
        required: ["id"], additionalProperties: false,
      },
      execute: async (input: Record<string, unknown> & { id: string; rename?: string }, context) => {
        const { id, rename, ...patch } = input
        validAccountId(id)
        const existing = await service.store.get(id)
        await check(context, "manage", id, { operation: existing ? "update" : "create" })
        if (rename !== undefined && !existing) throw new Error(`Cannot rename: no account ${id}`)
        const target = rename ?? id
        if (target !== id) await check(context, "manage", validAccountId(target), { operation: "rename", from: id })
        const saved = await service.store.put(normalizeAccount({ ...mergeAccount(existing, patch), id: target }), existing && target !== id ? id : undefined)
        if (existing && target !== id) { await service.vault.renameEntity(id, target); await service.policy.renameEntity(id, target) }
        const signedIn = await service.signedIn(saved)
        return json({ saved, signedIn, ...(!signedIn && { next: `sign in: rhythms_signin account=${saved.id}` }) })
      },
    },
    {
      name: "rhythms_account_remove",
      description: () => "Delete a Rhythms account with its stored sign-in and permission settings. Asks the user by default. Does not change anything in Rhythms.",
      input: { type: "object", properties: { account: { type: "string" } }, required: ["account"], additionalProperties: false },
      execute: async (input: { account: string }, context) => {
        const account = await service.pick(input.account)
        await check(context, "remove", account.id)
        service.signIns.get(account.id)?.flow.cancel()
        service.signIns.delete(account.id)
        await service.store.remove(account.id)
        await service.vault.deleteEntity(account.id)
        await service.policy.removeEntity(account.id)
        return json({ removed: account.id })
      },
    },
    {
      name: "rhythms_signin",
      description: () => "Start the browser sign-in to Rhythms. Returns a link for the user to open on this computer; it completes in the background once they sign in and click Allow access. wait blocks up to that many seconds.",
      input: { type: "object", properties: { account: ACCOUNT, wait: { type: "integer", minimum: 0, maximum: 600 } }, additionalProperties: false },
      execute: async (input: { account?: string; wait?: number }, context) => {
        const account = await service.pick(input.account)
        await check(context, "manage", account.id, { operation: "sign in" })
        const state = await service.startSignIn(account)
        const deadline = Date.now() + (input.wait ?? 0) * 1000
        while (state.status === "waiting" && Date.now() < deadline) {
          context.signal?.throwIfAborted()
          await new Promise(resolve => setTimeout(resolve, 1000))
        }
        const discovery = state.status === "done" ? await service.store.discovery(account.id) : undefined
        return json({
          account: account.id, status: state.status,
          ...(state.status === "waiting" && { tellUser: `Open this link on this computer and sign in to Rhythms${account.email ? ` as ${account.email}` : " with the email your Rhythms profile uses"}. If the Microsoft or Google button is blocked by your organization, use "Continue with email" and enter the emailed code. Then click Allow access: ${state.url}  — or click Sign in in OpenCode's Rhythms view.` }),
          ...(state.error && { error: state.error }),
          ...(discovery && { signedInAs: discovery.name ? `${discovery.name} <${discovery.email}>` : null, workspace: discovery.workspace ?? null, actions: discovery.actions, ...(discovery.error && { problem: discovery.error }) }),
        })
      },
    },
    {
      name: "rhythms_refresh",
      description: () => "Check an account again: who is signed in, which workspace, how many actions (after the user signed in or something failed).",
      input: { type: "object", properties: { account: ACCOUNT }, additionalProperties: false },
      execute: async (input: { account?: string }) => {
        const account = await service.pick(input.account)
        const { instructions: _, ...discovery } = await service.rediscover(account)
        return json({ account: account.id, ...discovery })
      },
    },
  ]
}
