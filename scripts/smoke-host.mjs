// End-to-end check against a real OpenCode CLI (pinned) in an isolated home, a scripted local model (not a real LLM)
// and a fake Rhythms (OAuth with dynamic registration + PKCE, MCP). Verifies: tools and the skill load, browser sign-in
// completes, the account inventory reaches the model, actions run, a delete goes through the permission prompt, and
// tokens never reach the model. --snapshot loads a verified installed snapshot instead of the checkout.
import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { startFakeRhythms } from "../plugin/testrhythms.ts"

const OPENCODE_VERSION = "2.2.6"
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const cliPackage = `@opencode/cli-${process.platform}-${process.arch}`
const binary = path.join(root, ".local", "host", "node_modules", cliPackage, "bin", "opencode")
export async function ensureCli() {
  try { await access(binary); return binary } catch {}
  console.log(`Installing ${cliPackage}@${OPENCODE_VERSION} into .local/host ...`)
  await mkdir(path.join(root, ".local", "host"), { recursive: true })
  const result = spawnSync("npm", ["install", "--no-save", "--no-package-lock", "--ignore-scripts", "--prefix", path.join(root, ".local", "host"), "--cache", path.join(root, ".local", "npm-cache"), `${cliPackage}@${OPENCODE_VERSION}`], { stdio: "inherit" })
  if (result.status !== 0) throw new Error(`Could not install ${cliPackage}@${OPENCODE_VERSION}`)
  return binary
}
if (process.argv.includes("--install-cli")) { await ensureCli(); process.exit(0) }
await ensureCli()

const base = await mkdtemp(path.join(await realpath(os.tmpdir()), "oc-rhythms-smoke-"))
const home = path.join(base, "home"), workspace = path.join(base, "workspace")
await mkdir(workspace, { recursive: true }); await mkdir(path.join(home, "config", "opencode"), { recursive: true })
const rhythms = await startFakeRhythms({ members: ["pat.lee@acme.example"] })

let pluginPath = root
if (process.argv.includes("--snapshot")) {
  process.env.XDG_DATA_HOME = path.join(home, "data")
  const { deploy, verifyRelease } = await import("./install.mjs")
  pluginPath = await deploy()
  await verifyRelease(pluginPath)
  console.log(`Using snapshot ${pluginPath}`)
}

const calls = [
  { name: "rhythms_account_upsert", input: { id: "work", email: "pat.lee@acme.example", label: "Work" } },
  { name: "rhythms_signin", input: { account: "work" } },
  { name: "rhythms_signin", input: { account: "work", wait: 30 } },
  { name: "rhythms_find_actions", input: { query: "my goals" } },
  { name: "rhythms_run", input: { action: "search_knowledge", arguments: { type: "goal", my_role_in: ["owner"] } } },
  { name: "rhythms_run", input: { action: "delete_goals", arguments: { goal_uuids: ["g-1"] } } },
]
const toolResults = []
const descriptions = []
const prompts = []
let modelRequests = 0
const server = createServer(async (req, res) => {
  const chunks = []
  for await (const part of req) chunks.push(part)
  let body
  try { body = JSON.parse(Buffer.concat(chunks).toString()) } catch { res.writeHead(400); res.end(); return }
  const main = Array.isArray(body.tools) && body.tools.some(tool => tool.function?.name === "rhythms_list")
  if (main) {
    modelRequests++
    descriptions.push(body.tools.find(tool => tool.function?.name === "rhythms_list").function.description)
    prompts.push(JSON.stringify(body.messages ?? []))
    toolResults.length = 0
    for (const message of body.messages ?? []) if (message.role === "tool") toolResults.push(typeof message.content === "string" ? message.content : JSON.stringify(message.content))
  }
  const call = main ? calls.shift() : undefined
  // The user opens the sign-in link the agent passed on, and approves.
  if (call?.name === "rhythms_signin" && call.input.wait) {
    const link = /(http\S+\/oauth2\/authorize\?\S+)/.exec(toolResults.join("\n"))?.[1]?.replace(/\\"?$|"$/, "")
    if (link) setTimeout(() => rhythms.approve(link).catch(error => console.error("approve failed", error)), 500)
  }
  if (!body.stream) {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(JSON.stringify({ id: "x", object: "chat.completion", model: "probe", choices: [{ index: 0, message: { role: "assistant", content: "Smoke" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
    return
  }
  const chunk = (delta, finish_reason = null) => ({ id: `c${modelRequests}`, object: "chat.completion.chunk", created: 0, model: "probe", choices: [{ index: 0, delta, finish_reason }] })
  const events = call
    ? [chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call-${modelRequests}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.input) } }] }), chunk({}, "tool_calls")]
    : [chunk({ role: "assistant", content: main ? "OC_RHYTHMS_SMOKE_COMPLETE" : "Smoke" }), chunk({}, "stop")]
  res.writeHead(200, { "content-type": "text/event-stream" })
  res.end(events.map(value => `data: ${JSON.stringify(value)}\n\n`).join("") + "data: [DONE]\n\n")
})
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
await writeFile(path.join(home, "config", "opencode", "opencode.json"), JSON.stringify({
  $schema: "https://opencode.ai/config.json", model: "probe/probe",
  plugins: [{ package: pluginPath, options: { mcpUrl: rhythms.mcpUrl } }],
  providers: { probe: {
    package: "@opencode/ai/providers/openai-compatible",
    settings: { baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "synthetic-not-a-secret" },
    models: { probe: { limit: { context: 32000, output: 1024 }, capabilities: { tools: true, input: ["text"], output: ["text"] } } },
  } },
}))
const env = {
  HOME: home, TMPDIR: home, PATH: [path.join(root, ".pixi/envs/default/bin"), "/usr/bin", "/bin"].join(":"),
  XDG_CONFIG_HOME: path.join(home, "config"), XDG_DATA_HOME: path.join(home, "data"), XDG_CACHE_HOME: path.join(home, "cache"), XDG_STATE_HOME: path.join(home, "state"),
  OPENCODE_DISABLE_CLAUDE_CODE: "true",
}
let stdout = "", stderr = ""
const child = spawn(binary, ["run", "--standalone", "--auto", "--format", "json", "--model", "probe/probe", "oc-rhythms smoke"], { cwd: workspace, env, detached: true, stdio: ["ignore", "pipe", "pipe"] })
child.stdout.on("data", data => { stdout += data }); child.stderr.on("data", data => { stderr += data })
const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL") } catch {} }, 150_000)
const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve) })
clearTimeout(timer); server.close(); await rhythms.stop()

const logs = path.join(root, ".local", "smoke-host.log")
await mkdir(path.dirname(logs), { recursive: true })
await writeFile(logs, `${stdout}\n----- stderr -----\n${stderr}`, { mode: 0o600 })
try {
  assert.equal(code, 0, `opencode exited ${code}; see ${logs}`)
  assert.equal(calls.length, 0, "every scripted call was made")
  assert.ok(stdout.includes("OC_RHYTHMS_SMOKE_COMPLETE"), "run completed")
  assert.doesNotMatch(stderr, /\[oc-rhythms\] (disabled|could not|tool reload failed|skill not registered)/, "no plugin warnings")
  assert.match(descriptions[0], /No Rhythms accounts are configured yet/)
  assert.match(descriptions.at(-1), /work: Pat Lee <pat\.lee@acme\.example> in workspace Acme; 8 actions \(Work\)/, "inventory refreshed live")
  assert.match(prompts[0], /rhythms/, "the rhythms skill is offered")
  const all = toolResults.join("\n")
  assert.match(all, /"status": "done"/, "browser sign-in completed")
  assert.match(all, /search_knowledge/)
  assert.match(all, /OBJ-7/, "action ran")
  assert.ok(rhythms.calls.some(call => call.name === "delete_goals"), "delete ran after the prompt was approved")
  const vault = await (await import("oc-secure-kit")).Vault.open({ dir: path.join(home, "data", "oc-rhythms"), plugin: "oc-rhythms" })
  const token = await vault.get("work", "access-token")
  assert.ok(token && !all.includes(token), "the token never reaches the model")
  if (pluginPath !== root) await (await import("./install.mjs")).verifyRelease(pluginPath)
  console.log(`oc-rhythms host smoke passed${pluginPath !== root ? " from a snapshot" : ""} (OpenCode ${OPENCODE_VERSION}, ${process.platform}-${process.arch}, ${modelRequests} model requests).`)
  await rm(base, { recursive: true, force: true })
} catch (error) {
  console.error(`Smoke failed. Scratch home kept at ${base}; logs at ${logs}`)
  throw error
}
