import type { Plugin } from "@opencode/plugin"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { installRedaction, PermissionBridge, pluginDataDir, SECURE_KIT_VERSION, sessionRoots, type PermissionHost } from "oc-secure-kit"
import { createAdmin } from "./admin.js"
import { defaultEffect, type Discovery } from "./model.js"
import { RhythmsRpc } from "./rpc.js"
import { PLUGIN_ID, RhythmsService } from "./service.js"
import { createTools, TOOL_NAMES } from "./tools.js"

export { PLUGIN_ID, SECURE_KIT_VERSION }

export interface RhythmsOptions {
  /** Absolute path; default `$XDG_DATA_HOME/oc-rhythms`. */
  readonly dataDirectory?: string
  /** Rhythms MCP URL; default https://mcpservers.rhythms.ai/rhythms/mcp. For tests. */
  readonly mcpUrl?: string
}

export function parseOptions(raw: unknown): RhythmsOptions {
  const options = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>
  for (const key of ["dataDirectory", "mcpUrl"]) if (options[key] !== undefined && typeof options[key] !== "string") throw new Error(`${PLUGIN_ID}: ${key} must be a string`)
  if (options.mcpUrl !== undefined && !/^https?:\/\//.test(options.mcpUrl as string)) throw new Error(`${PLUGIN_ID}: mcpUrl must be an http(s) URL`)
  return { ...(options.dataDirectory !== undefined && { dataDirectory: options.dataDirectory as string }), ...(options.mcpUrl !== undefined && { mcpUrl: options.mcpUrl as string }) }
}

const SKILL = fileURLToPath(new URL("../skill/SKILL.md", import.meta.url))
const warn = (message: string, error?: unknown) =>
  console.warn(`[${PLUGIN_ID}] ${message}${error ? `: ${error instanceof Error ? error.message : String(error)}` : ""}`)

/** The bundled know-how plus Rhythms' own guidance for agents, once an account has signed in. */
export function skillContent(base: string, discovery: Record<string, Discovery>): string {
  const instructions = Object.values(discovery).find(item => item.instructions)?.instructions
  return instructions ? `${base.trimEnd()}\n\n## Rhythms' own guidance for agents (from the Rhythms server)\n\n${instructions.replace(/^#{1,2} /gm, "### ")}\n` : base
}

export function createPlugin(): Plugin.Plugin {
  return ({
    id: PLUGIN_ID,
    async setup(ctx) {
      const registrations: { dispose(): Promise<void> | void }[] = []
      const cleanup = async () => { await Promise.allSettled(registrations.splice(0).reverse().map(async item => item.dispose())) }
      try {
        const options = parseOptions(ctx.options)
        const service = await RhythmsService.open(pluginDataDir(PLUGIN_ID, options.dataDirectory), { ...(options.mcpUrl && { mcpUrl: options.mcpUrl }) })
        registrations.push({ dispose: () => service.dispose() })
        const root = sessionRoots(async sessionID => (await ctx.session.get({ sessionID: sessionID as never })).parentID ?? undefined)
        const bridge = new PermissionBridge({ plugin: PLUGIN_ID, policy: service.policy, fallback: defaultEffect, root })
        registrations.push(await bridge.install(ctx.permission as unknown as PermissionHost))
        registrations.push(bridge.followReplies(ctx.event as never, error => warn("could not save Allow always", error)))
        service.attach(bridge)

        const tools = createTools(service)
        registrations.push(await ctx.tool.transform(editor => {
          for (const tool of tools) {
            editor.add({
              name: tool.name, description: tool.description(), input: tool.input as never, options: { codemode: false },
              execute: async (input, context) => {
                try { return await tool.execute(input, context) }
                finally { await service.syncRedactor().catch(error => warn("redactor refresh failed", error)) }
              },
            })
          }
        }))
        registrations.push(await installRedaction(ctx.tool as never, service.redactor, new Set<string>(TOOL_NAMES), error => warn("redaction skipped", error)))

        let skillReady = false
        try {
          const base = await readFile(SKILL, "utf8")
          const description = /^description:\s*(.+)$/m.exec(base)?.[1] ?? "Rhythms know-how"
          registrations.push(await ctx.skill.transform(editor => {
            editor.add({ id: "rhythms" as never, name: "rhythms" as never, description, path: SKILL as never, content: skillContent(base, service.store.cached().discovery) })
          }))
          skillReady = true
        } catch (error) { warn("skill not registered", error) }

        let reloading: Promise<void> | undefined
        registrations.push({ dispose: service.store.onChange(() => {
          reloading ??= Promise.resolve()
            .then(() => Promise.all([ctx.tool.reload(), skillReady ? ctx.skill.reload() : undefined]))
            .then(() => {}).catch(error => warn("tool reload failed", error)).finally(() => { reloading = undefined })
        }) })

        const admin = createAdmin({
          service, root,
          agents: async () => ((await ctx.agent.list()).data ?? []).filter(agent => !agent.hidden).map(agent => ({ id: agent.id as string, name: agent.name, mode: agent.mode })),
        })
        const handlers = Object.fromEntries(Object.keys(RhythmsRpc.methods).map(name => [name, async (input: unknown) => (admin as Record<string, (input: never) => Promise<unknown>>)[name]!(input as never)]))
        registrations.push(await ctx.rpc.register(RhythmsRpc, handlers as never))
      } catch (error) {
        warn("disabled", error)
        await cleanup()
      }
      return cleanup
    },
  }) satisfies Plugin.Plugin
}

export default createPlugin()
