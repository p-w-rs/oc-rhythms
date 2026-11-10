// Test helper: a fake Rhythms — OAuth (resource + server metadata, dynamic registration, PKCE, rotating refresh tokens,
// 5-minute access tokens) and the MCP endpoint with a few actions, annotations and server instructions.
import { createHash, randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

export interface FakeRhythms {
  readonly base: string
  readonly mcpUrl: string
  readonly tenantUuid: string
  /** What the browser does: open the authorization URL, approve, follow the redirect to the loopback callback. */
  approve(authorizeUrl: string, as?: string): Promise<void>
  readonly calls: { name: string; args: Record<string, unknown> }[]
  /** Last authorization request's parameters. */
  readonly lastAuthorize: () => URLSearchParams | undefined
  expireTokens(): void
  stop(): Promise<void>
}

export const INSTRUCTIONS = "# Rhythms MCP\n\n## Goals\n\n- Before creating a check-in, confirm the goal, value, status, and date with the user."

export async function startFakeRhythms(options: { members?: string[] } = {}): Promise<FakeRhythms> {
  const members = new Set((options.members ?? ["pat.lee@acme.example"]).map(email => email.toLowerCase()))
  const tenantUuid = "0199e468-0000-7000-8000-000000000001"
  const clients = new Set<string>()
  const codes = new Map<string, { clientId: string; challenge: string; redirect: string; email: string }>()
  const access = new Map<string, { expiry: number; email: string }>()
  const refresh = new Map<string, string>()
  const sessions = new Set<string>()
  const calls: FakeRhythms["calls"] = []
  let lastAuthorize: URLSearchParams | undefined
  let pendingEmail = ""
  let base = ""
  const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(body)) }
  const read = async (req: IncomingMessage) => { const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(chunk as Buffer); return Buffer.concat(chunks).toString() }
  const issue = (email: string) => {
    const token = randomBytes(12).toString("hex"); access.set(token, { expiry: Date.now() + 300_000, email })
    const r = randomBytes(12).toString("hex"); refresh.set(r, email)
    return { access_token: token, refresh_token: r, expires_in: 300, token_type: "Bearer", id_token: "x.y.z" }
  }
  const ro = { readOnlyHint: true, destructiveHint: false }
  const tools = [
    { name: "whoami", description: "Return the authenticated user's identity together with the current tenant details.", annotations: ro, inputSchema: { type: "object", properties: {} } },
    { name: "search_knowledge", description: "Find Rhythms RECORDS by name or filter. Use type='goal' for goal/OKR discovery such as my goals.", annotations: ro, inputSchema: { type: "object", properties: { type: { enum: ["goal", "document", "all"] }, my_role_in: { type: "array" }, query: { type: "string" } }, required: ["type"] } },
    { name: "get_goal", description: "Get one goal by UUID or short ID such as OBJ-001.", annotations: ro, inputSchema: { type: "object", properties: { goal_uuid: { type: "string" } }, required: ["goal_uuid"] } },
    { name: "create_checkin", description: "Create a goal check-in.", annotations: { readOnlyHint: false, destructiveHint: false }, inputSchema: { type: "object", properties: { goal_uuid: { type: "string" }, value: { type: "number" } } } },
    { name: "delete_goals", description: "Delete one or more goals by uuid.", annotations: { readOnlyHint: false, destructiveHint: true }, inputSchema: { type: "object", properties: { goal_uuids: { type: "array" } } } },
    { name: "share_goals", description: "Share goals with users or teams.", annotations: { readOnlyHint: false, destructiveHint: false }, inputSchema: { type: "object", properties: {} } },
    { name: "answer_and_act_across_apps", description: "Ask the Rhythms agent a question across connected systems.", annotations: { readOnlyHint: false, destructiveHint: true }, inputSchema: { type: "object", properties: { request: { type: "string" }, request_id: { type: "string" } } } },
    { name: "get_work", description: "Read a delegated work snapshot.", annotations: ro, inputSchema: { type: "object", properties: { work_id: { type: "string" } } } },
  ]
  const goals = [{ uuid: "g-1", short_id: "OBJ-7", title: "Ship the harness", type: "Okrs::Objective", progress: 50 }]
  const text = (value: unknown) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }] })
  const setup = { status: "error", error: { code: "account_setup_required", reason: "account_setup_required", message: "Your organization requires an invitation to join Rhythms. Please contact your IT or Rhythms administrator." } }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, base)
    const path = url.pathname
    if (path === "/.well-known/oauth-protected-resource/rhythms/mcp") return send(res, 200, { resource: `${base}/rhythms/mcp`, authorization_servers: [`${base}/`], scopes_supported: [], bearer_methods_supported: ["header"] })
    if (path === "/.well-known/oauth-authorization-server") return send(res, 200, { issuer: base, authorization_endpoint: `${base}/oauth2/authorize`, token_endpoint: `${base}/oauth2/token`, registration_endpoint: `${base}/oauth2/register`, scopes_supported: ["email", "offline_access", "openid", "profile"], code_challenge_methods_supported: ["S256"] })
    if (path === "/oauth2/register") {
      const body = JSON.parse(await read(req))
      if (body.token_endpoint_auth_method !== "none") return send(res, 400, { error: "invalid_client_metadata" })
      const id = `client_${randomBytes(4).toString("hex")}`; clients.add(id)
      return send(res, 201, { client_id: id, redirect_uris: body.redirect_uris })
    }
    if (path === "/oauth2/authorize") {
      const p = url.searchParams
      lastAuthorize = p
      if (!clients.has(p.get("client_id")!) || p.get("code_challenge_method") !== "S256" || p.get("resource") !== `${base}/rhythms/mcp`) return send(res, 400, { error: "invalid_request" })
      const code = randomBytes(8).toString("hex")
      codes.set(code, { clientId: p.get("client_id")!, challenge: p.get("code_challenge")!, redirect: p.get("redirect_uri")!, email: pendingEmail || p.get("login_hint") || [...members][0]! })
      res.writeHead(302, { location: `${p.get("redirect_uri")}?code=${code}&state=${p.get("state")}` }); res.end(); return
    }
    if (path === "/oauth2/token") {
      const form = new URLSearchParams(await read(req))
      if (form.get("grant_type") === "authorization_code") {
        const entry = codes.get(form.get("code")!)
        const verifier = form.get("code_verifier") ?? ""
        if (!entry || entry.clientId !== form.get("client_id") || entry.redirect !== form.get("redirect_uri") || createHash("sha256").update(verifier).digest("base64url") !== entry.challenge) return send(res, 400, { error: "invalid_grant" })
        codes.delete(form.get("code")!)
        return send(res, 200, issue(entry.email))
      }
      const email = refresh.get(form.get("refresh_token") ?? "")
      if (form.get("grant_type") === "refresh_token" && email) { refresh.delete(form.get("refresh_token")!); return send(res, 200, issue(email)) }
      return send(res, 400, { error: "invalid_grant" })
    }
    if (path === "/rhythms/mcp") {
      const auth = access.get(req.headers.authorization?.replace(/^Bearer /, "") ?? "")
      if (!auth || auth.expiry < Date.now()) return send(res, 401, { error: "invalid_token" }, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/rhythms/mcp"` })
      const message = JSON.parse(await read(req))
      if (message.method === "initialize") { const id = randomBytes(6).toString("hex"); sessions.add(id); return send(res, 200, { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "Rhythms", version: "3.4.4" }, instructions: INSTRUCTIONS } }, { "mcp-session-id": id }) }
      if (!sessions.has(String(req.headers["mcp-session-id"]))) return send(res, 404, { error: "session not found" })
      if (!("id" in message)) { res.writeHead(202); res.end(); return }
      let result: unknown
      if (message.method === "tools/list") result = { tools }
      else if (message.method === "tools/call") {
        const { name, arguments: args } = message.params
        calls.push({ name, args })
        const member = members.has(auth.email)
        if (!member) result = text(setup)
        else if (name === "whoami") result = text({ status: "success", data: { user_uuid: "u-1", user_name: "Pat Lee", user_email: auth.email, tenant_uuid: tenantUuid, tenant_name: "Acme" } })
        else if (name === "search_knowledge") result = text({ status: "success", data: { goals: goals.map(goal => ({ ...goal, tenant_uuid: tenantUuid })) } })
        else if (name === "get_goal") result = goals.some(goal => goal.uuid === args.goal_uuid || goal.short_id === args.goal_uuid) ? text({ status: "success", data: goals[0] }) : { ...text("Goal not found"), isError: true }
        else result = text({ status: "success", data: { ok: true } })
      } else return send(res, 200, { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "method not found" } })
      res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`); return
    }
    send(res, 404, { detail: "Not Found" })
  })
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  return {
    base, mcpUrl: `${base}/rhythms/mcp`, tenantUuid, calls, lastAuthorize: () => lastAuthorize,
    async approve(authorizeUrl, as) {
      pendingEmail = as ?? ""
      try {
        const redirect = await fetch(authorizeUrl, { redirect: "manual" })
        const location = redirect.headers.get("location")
        if (!location) throw new Error(`authorize failed: ${redirect.status} ${await redirect.text()}`)
        await fetch(location)
      } finally { pendingEmail = "" }
    },
    expireTokens() { for (const entry of access.values()) entry.expiry = 0 },
    async stop() { await new Promise(resolve => server.close(resolve)) },
  }
}
