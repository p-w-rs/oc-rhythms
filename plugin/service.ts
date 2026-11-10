import {
  McpClient, PolicyStore, Redactor, refreshGrant, Serial, startBrowserSignIn, Vault,
  type BrowserSignIn, type Grant, type McpToolInfo, type OAuthClient, type PermissionBridge,
} from "oc-secure-kit"
import { ACCESS, DEFAULT_MCP, OAUTH, REFRESH, SECRET_NAMES, type Account, type Discovery } from "./model.js"
import { AccountStore } from "./store.js"

export const PLUGIN_ID = "oc-rhythms"
export const VERSION = "1.0.2"
const SERVICE = "Rhythms"
/** Scopes for identity and refresh; Rhythms grants workspace access by the sign-in itself. */
const SCOPES = ["openid", "profile", "email", "offline_access"]
/** Rhythms access tokens live ~5 minutes; refresh when less than this remains. */
const REFRESH_MARGIN = 60_000

export interface SignInState {
  readonly account: string
  readonly url: string
  readonly expiresAt: number
  status: "waiting" | "done" | "failed"
  error?: string
  readonly flow: BrowserSignIn
}

interface Catalog { readonly tools: McpToolInfo[]; readonly at: number }
const CATALOG_TTL = 6 * 60 * 60_000

/** Explains Rhythms' "account setup" answers, which usually mean the wrong email signed in. */
export function setupHint(text: string, account?: Account): string | undefined {
  if (!/account_setup_required|requires an invitation|use a work email|workspace/i.test(text) || !/"status"\s*:\s*"error"|account_setup_required/.test(text)) return undefined
  return `Rhythms does not see a workspace for this sign-in. Usually the sign-in used a different email than the one your Rhythms profile has${account?.email ? ` (expected ${account.email})` : ""}: in Rhythms open your profile to see that email, set it on the account (rhythms_account_upsert email=...), and sign in again with it ("Continue with email" works when the Microsoft/Google button is blocked). If the email is right, your workspace admin must invite you.`
}

/** Accounts, vault, permissions, sign-in and per-account connections of one data directory. */
export class RhythmsService {
  readonly redactor = new Redactor()
  readonly signIns = new Map<string, SignInState>()
  #bridge?: PermissionBridge
  #redactorStale = false
  #mcp = new Map<string, McpClient>()
  #catalog = new Map<string, Catalog>()
  #refreshing = new Map<string, Serial>()

  private constructor(
    readonly dir: string,
    readonly store: AccountStore,
    readonly vault: Vault,
    readonly policy: PolicyStore,
    readonly mcpUrl: string,
  ) {}

  static async open(dir: string, options: { mcpUrl?: string } = {}): Promise<RhythmsService> {
    const [store, vault, policy] = await Promise.all([AccountStore.open(dir), Vault.open({ dir, plugin: PLUGIN_ID }), PolicyStore.open(dir)])
    const service = new RhythmsService(dir, store, vault, policy, options.mcpUrl ?? DEFAULT_MCP)
    await service.refreshRedactor()
    vault.onChange(() => { service.#redactorStale = true })
    store.onChange(() => { service.#mcp.clear(); service.#catalog.clear() })
    return service
  }

  attach(bridge: PermissionBridge): void { this.#bridge = bridge }
  get bridge(): PermissionBridge {
    if (!this.#bridge) throw new Error(`${PLUGIN_ID}: permissions are not set up`)
    return this.#bridge
  }

  /** The account a call is for: the named one, the only one, or the default. */
  async pick(id: string | undefined): Promise<Account> {
    const accounts = await this.store.list()
    if (id) {
      const found = accounts.find(account => account.id === id || account.email === id.toLowerCase())
      if (!found) throw new Error(`No Rhythms account ${JSON.stringify(id)}. Accounts: ${accounts.map(account => account.id).join(", ") || "(none; create one with rhythms_account_upsert)"}`)
      return found
    }
    if (accounts.length === 1) return accounts[0]!
    const fallback = (await this.store.settings()).defaultAccount
    if (fallback) { const found = accounts.find(account => account.id === fallback); if (found) return found }
    if (!accounts.length) throw new Error("No Rhythms account is configured yet. Create one with rhythms_account_upsert (id, and the email your Rhythms profile uses), then rhythms_signin.")
    throw new Error(`Several Rhythms accounts exist (${accounts.map(account => account.id).join(", ")}). Pass account=<id>; decide from the conversation or ask the user.`)
  }

  // ------------------------------------------------------------------ credentials

  async saveGrant(account: Account, grant: Grant, client: OAuthClient): Promise<void> {
    await this.vault.set(account.id, ACCESS, grant.accessToken)
    if (grant.refreshToken) await this.vault.set(account.id, REFRESH, grant.refreshToken)
    await this.vault.set(account.id, OAUTH, JSON.stringify({ ...client, ...(grant.expiresAt && { expiresAt: grant.expiresAt }), scopes: grant.scopes }))
    await this.refreshRedactor()
  }

  async signedIn(account: Account): Promise<boolean> { return this.vault.has(account.id, ACCESS) }

  /** A valid access token, refreshed when about to expire (or `force`). Refreshes are serialized per account. */
  async accessToken(account: Account, force = false): Promise<string | undefined> {
    const serial = this.#refreshing.get(account.id) ?? new Serial()
    this.#refreshing.set(account.id, serial)
    return serial.run(async () => {
      const token = await this.vault.get(account.id, ACCESS)
      const stored = await this.vault.get(account.id, OAUTH)
      const oauth = stored ? JSON.parse(stored) as OAuthClient & { expiresAt?: number } : undefined
      if (token && !force && (!oauth?.expiresAt || oauth.expiresAt - Date.now() > REFRESH_MARGIN)) return token
      const refreshToken = await this.vault.get(account.id, REFRESH)
      if (!refreshToken || !oauth) return token
      const grant = await refreshGrant(oauth, refreshToken, SERVICE)
      await this.saveGrant(account, { ...grant, refreshToken: grant.refreshToken ?? refreshToken }, oauth)
      return grant.accessToken
    })
  }

  async authorization(account: Account): Promise<string> {
    const token = await this.accessToken(account)
    if (!token) throw new Error(`${account.id} is not signed in to Rhythms. Call rhythms_signin account=${account.id} and give the user the link.`)
    return `Bearer ${token}`
  }

  // ------------------------------------------------------------------ actions (MCP)

  mcp(account: Account): McpClient {
    let client = this.#mcp.get(account.id)
    if (!client) {
      client = new McpClient(this.mcpUrl, {
        authorization: () => this.authorization(account), onUnauthorized: async () => { await this.accessToken(account, true) },
        clientName: PLUGIN_ID, clientVersion: VERSION, service: SERVICE,
      })
      this.#mcp.set(account.id, client)
    }
    return client
  }

  async actions(account: Account, fresh = false): Promise<McpToolInfo[]> {
    const cached = this.#catalog.get(account.id)
    if (cached && !fresh && Date.now() - cached.at < CATALOG_TTL) return cached.tools
    const tools = await this.mcp(account).listTools()
    this.#catalog.set(account.id, { tools, at: Date.now() })
    return tools
  }

  // ------------------------------------------------------------------ discovery and sign-in

  /** Learns who signed in and to which workspace; flags the wrong email or a missing workspace. */
  async rediscover(account: Account): Promise<Discovery> {
    const previous = await this.store.discovery(account.id)
    let discovery: Discovery
    try {
      const client = this.mcp(account)
      const info = await client.initialize()
      const tools = await this.actions(account, true)
      const result = await client.call("whoami", {})
      const parsed = (() => { try { return JSON.parse(result.text) as { status?: string; data?: Record<string, string>; error?: { message?: string } } } catch { return undefined } })()
      const me = parsed?.status === "success" ? parsed.data ?? {} : {}
      const problem = result.isError || parsed?.status === "error"
        ? setupHint(result.text, account) ?? `Rhythms: ${parsed?.error?.message ?? result.text.slice(0, 300)}`
        : account.email && me.user_email && me.user_email.toLowerCase() !== account.email
          ? `Signed in as ${me.user_email}, but this account is set to ${account.email}. Sign in again with ${account.email}, or change the account's email.`
          : undefined
      discovery = {
        ...(me.user_uuid && { userUuid: me.user_uuid }), ...(me.user_name && { name: me.user_name }), ...(me.user_email && { email: me.user_email }),
        ...(me.tenant_uuid && { tenantUuid: me.tenant_uuid }), ...(me.tenant_name && { workspace: me.tenant_name }),
        actions: tools.length, ...(info.instructions && { instructions: info.instructions.slice(0, 20_000) }),
        checkedAt: new Date().toISOString(), ...(problem && { error: problem }),
      }
    } catch (error) {
      discovery = { ...(previous ?? {}), error: (error as Error).message.slice(0, 500), checkedAt: new Date().toISOString() }
    }
    await this.store.setDiscovery(account.id, discovery)
    return discovery
  }

  async startSignIn(account: Account): Promise<SignInState> {
    const running = this.signIns.get(account.id)
    if (running?.status === "waiting" && running.expiresAt > Date.now()) return running
    running?.flow.cancel()
    const flow = await startBrowserSignIn(this.mcpUrl, {
      clientName: "OpenCode (oc-rhythms)", service: SERVICE,
      scopes: (_advertised, server) => SCOPES.filter(scope => !server.length || server.includes(scope)),
      ...(account.email && { authorizeParams: { login_hint: account.email } }),
    })
    const state: SignInState = { account: account.id, url: flow.url, expiresAt: flow.expiresAt, status: "waiting", flow }
    this.signIns.set(account.id, state)
    flow.done
      .then(async ({ grant, client }) => { await this.saveGrant(account, grant, client); this.#mcp.get(account.id)?.reset(); await this.rediscover(account); state.status = "done" })
      .catch(error => { if (state.status === "waiting") { state.status = "failed"; state.error = (error as Error).message } })
    return state
  }

  async signOut(account: Account): Promise<void> {
    for (const name of SECRET_NAMES) await this.vault.delete(account.id, name)
    await this.store.setDiscovery(account.id, undefined)
    this.#mcp.delete(account.id)
    this.#catalog.delete(account.id)
    await this.refreshRedactor()
  }

  async syncRedactor(): Promise<void> {
    await this.vault.list()
    if (this.#redactorStale) { this.#redactorStale = false; await this.refreshRedactor() }
  }
  async refreshRedactor(): Promise<void> {
    this.redactor.replaceAll((await this.vault.values()).filter(item => item.name !== OAUTH).map(item => [`${item.entity}/${item.name}`, item.value] as const))
  }

  dispose(): void { for (const state of this.signIns.values()) state.flow.cancel() }
}
