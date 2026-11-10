import { validName } from "oc-secure-kit"

export const ACCOUNTS_FORMAT = "oc-rhythms-accounts/1"

/** Rhythms' agent interface (MCP). Overridable for tests. */
export const DEFAULT_MCP = "https://mcpservers.rhythms.ai/rhythms/mcp"
export const WEB = "https://app.rhythms.ai"

/** A Rhythms sign-in. Signs in through the browser (OAuth); the workspace comes with the sign-in. */
export interface Account {
  readonly id: string
  readonly label?: string
  /** The email Rhythms knows you by (Rhythms → profile). Pre-fills sign-in and is checked against who signs in. */
  readonly email?: string
  readonly notes?: string
  readonly updatedAt: string
}

/** What the plugin learned by signing in. Rediscovered; never exported. */
export interface Discovery {
  readonly userUuid?: string
  readonly name?: string
  readonly email?: string
  readonly tenantUuid?: string
  readonly workspace?: string
  readonly actions?: number
  /** Rhythms' own guidance for agents (from the server), shown in the skill. */
  readonly instructions?: string
  readonly checkedAt?: string
  readonly error?: string
}

export const AREAS = ["goals", "documents", "people", "workspace", "other"] as const
export type Area = (typeof AREAS)[number]
export const VERBS = ["read", "write", "delete", "admin"] as const
export type Verb = (typeof VERBS)[number]
export const CAPABILITIES = [
  ...AREAS.flatMap(area => VERBS.map(verb => `${area}-${verb}` as const)),
  "delegate", "manage", "remove",
] as const
export type Capability = (typeof CAPABILITIES)[number]

/** Starting point only; users change it in the table. */
export function defaultEffect(capability: string): "allow" | "ask" {
  return /-(delete|admin)$/.test(capability) || ["other-write", "delegate", "remove"].includes(capability) ? "ask" : "allow"
}

/** Vault secret names (entity = account id). */
export const ACCESS = "access-token"
export const REFRESH = "refresh-token"
/** OAuth client bound to the tokens: { clientId, tokenEndpoint, resource, expiresAt, scopes }. */
export const OAUTH = "oauth"
export const SECRET_NAMES = [ACCESS, REFRESH, OAUTH] as const

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const CONTROL = /[\u0000-\u001f\u007f]/
const fail = (message: string): never => { throw new Error(message) }
const text = (value: unknown, field: string, max: number): string | undefined => {
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string" || value.length > max || CONTROL.test(value)) fail(`${field} must be a single-line string up to ${max} characters`)
  return value as string
}

export function validAccountId(id: unknown): string {
  if (typeof id !== "string" || !ID.test(id)) return fail(`account id ${JSON.stringify(id)} must be 1-64 letters, digits, '.', '_' or '-'`)
  return validName("account", id)
}

export function normalizeAccount(input: unknown, now = new Date()): Account {
  if (!input || typeof input !== "object" || Array.isArray(input)) return fail("account must be an object")
  const raw = input as Record<string, unknown>
  for (const key of Object.keys(raw)) if (!["id", "label", "email", "notes", "updatedAt"].includes(key)) fail(`Unknown account field ${JSON.stringify(key)}`)
  const id = validAccountId(raw.id)
  const email = text(raw.email, "email", 254)?.trim().toLowerCase()
  if (email !== undefined && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("email is not an email address")
  const label = text(raw.label, "label", 120)
  const notes = typeof raw.notes === "string" && raw.notes.length <= 4000 ? raw.notes : raw.notes == null ? undefined : fail("notes must be text up to 4000 characters")
  return { id, ...(label && { label }), ...(email && { email }), ...(notes && { notes }), updatedAt: now.toISOString() }
}

export function mergeAccount(existing: Account | undefined, patch: Record<string, unknown>): Record<string, unknown> {
  const base: Record<string, unknown> = existing ? { ...existing } : {}
  delete base.updatedAt
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete base[key]
    else base[key] = value
  }
  return base
}

// ------------------------------------------------------------------ action classification

/** Hands work to the Rhythms agent, which may act in other connected apps. */
const DELEGATE = new Set(["answer_and_act_across_apps", "continue_work", "cancel_work"])
/** Changes that affect other people's access or the workspace's structure. */
const ADMIN = new Set([
  "share_document", "share_goals", "invite_users", "create_team", "manage_team", "create_time_period", "manage_time_period",
  "create_label", "manage_labels", "join_workspace", "publish_draft_okrs", "install_solution", "update_solution_installation",
])
const DELETE = /^(delete|unshare|leave|remove|uninstall)_/

function area(name: string): Area {
  if (/(^|_)documents?(_|$)|^document_task$|refresh_status/.test(name)) return "documents"
  if (/(^|_)(goal|goals|okrs?|checkins?|progress_plan|checkin_rhythm|labels?|time_periods?|data_source|knowledge)(_|$)/.test(name)) return "goals"
  if (/(^|_)(comments?|comment_anchor)(_|$)/.test(name)) return "documents"
  if (/(^|_)(users?|teams?|whoami)(_|$)/.test(name)) return "people"
  if (/(^|_)(views?|view_data|settings|workspace)(_|$)/.test(name)) return "workspace"
  return "other"
}

export interface ActionAnnotations { readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean }

/** Permission an action needs: delegate, or area + verb. Uses the server's read-only hint, then the name. */
export function classifyAction(name: string, annotations: ActionAnnotations = {}): Capability {
  if (DELEGATE.has(name)) return "delegate"
  const where = area(name)
  if (annotations.readOnlyHint === true || /^(get|list|search|whoami$)/.test(name)) return `${where}-read`
  if (DELETE.test(name)) return `${where}-delete`
  if (ADMIN.has(name)) return `${where}-admin`
  return `${where}-write`
}
