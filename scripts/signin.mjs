// Browser sign-in for a Rhythms account from a terminal (the GUI and rhythms_signin do the same).
//   pixi run signin <account> [--email you@company.com]
// Creates the account if needed. Never prints tokens.
import { spawn } from "node:child_process"
import { pluginDataDir } from "oc-secure-kit"
import { mergeAccount, normalizeAccount } from "../plugin/model.ts"
import { RhythmsService } from "../plugin/service.ts"

const args = process.argv.slice(2)
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const id = args.find((arg, i) => !arg.startsWith("--") && !args[i - 1]?.startsWith("--"))
if (!id) { console.error("Usage: pixi run signin <account> [--email you@company.com]"); process.exit(2) }

const service = await RhythmsService.open(pluginDataDir("oc-rhythms", process.env.OC_RHYTHMS_DATA_DIR || undefined), { ...(process.env.OC_RHYTHMS_MCP_URL && { mcpUrl: process.env.OC_RHYTHMS_MCP_URL }) })
let account = await service.store.get(id)
if (!account || option("--email")) {
  account = await service.store.put(normalizeAccount({ ...mergeAccount(account, {}), id, ...(option("--email") && { email: option("--email") }) }))
  console.log(`Account ${id}${account.email ? ` (${account.email})` : ""}`)
}
const state = await service.startSignIn(account)
console.log(`\nOpening your browser. Sign in to Rhythms${account.email ? ` as ${account.email}` : " with the email your Rhythms profile uses"}, then click Allow access.\nIf your organization blocks the Microsoft or Google button, use "Continue with email" and enter the emailed code.\nIf it does not open, visit:\n\n${state.url}\n`)
if (!process.env.OC_RHYTHMS_NO_BROWSER) spawn(process.platform === "darwin" ? "open" : "xdg-open", [state.url], { stdio: "ignore", detached: true }).on("error", () => {}).unref()
while (state.status === "waiting") await new Promise(resolve => setTimeout(resolve, 500))
if (state.status !== "done") { console.error(`Sign-in did not finish: ${state.error}`); process.exit(1) }
const discovery = await service.store.discovery(id)
console.log(`Signed in as ${discovery?.name ?? "?"} <${discovery?.email ?? "?"}> in workspace ${discovery?.workspace ?? "?"}. Actions: ${discovery?.actions ?? 0}.`)
if (discovery?.error) console.log(`Problem: ${discovery.error}`)
service.dispose()
process.exit(discovery?.error ? 1 : 0)
