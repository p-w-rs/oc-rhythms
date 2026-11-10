# oc-rhythms

[Rhythms](https://rhythms.ai) for OpenCode agents: OKRs and goals, check-ins,
documents, teams, saved views, and Rhythms' own agent for cross-app work. Sign
in once in the browser; agents then act as you, with your Rhythms permissions
plus a permission table you control and built-in know-how (a `rhythms` skill).
macOS and Linux; OpenCode 2.2.6+ and Pixi.

## Sign-in

Browser sign-in to Rhythms' agent interface (MCP, OAuth 2.1): no app to
register and no API key. The plugin registers itself as a public client, uses
PKCE and a local callback, and renews the short-lived sign-in automatically.

- Set the account's **email to the one your Rhythms profile shows**. It can
  differ from your email in other tools. The sign-in page is pre-filled with
  it, and the plugin warns if someone else signs in.
- If your organization blocks the "Continue with Microsoft/Google" button, use
  **Continue with email** and enter the emailed code. With the right email this
  reaches the same workspace as your company sign-on.
- If Rhythms answers `account_setup_required`, the sign-in reached no
  workspace: check the email, or ask your Rhythms admin for an invitation.

Any number of accounts. The agent uses the only one, the default, or the one it
names; when it is unclear it asks.

## What agents get

| Tool | |
|---|---|
| `rhythms_list` | Accounts, who is signed in, which workspace, what the agent may do; also in the tool description |
| `rhythms_find_actions` | Search Rhythms' ~70 actions by keyword; `names=[...]` returns exact parameters |
| `rhythms_run` | Run an action |
| `rhythms_account_upsert` / `_remove`, `rhythms_signin`, `rhythms_refresh` | Setup |

The `rhythms` skill covers finding your and your team's goals, check-ins,
documents (section-wise reading and editing), views and reports, delegating to
the Rhythms agent, and links. After sign-in it also includes Rhythms' own
guidance for agents.

## Permissions

Per account, for goals & check-ins, documents, people & teams, views & settings
and other actions: read, create & edit, delete, share & admin. Plus delegating
to the Rhythms agent (which can act in other connected apps), and edit/remove
account. By default the agent can read, create and edit (including check-ins)
without asking. Deletes, sharing and admin changes (invites, teams, time
periods, labels, publishing), delegating and removing an account ask first. Every cell is
editable in the GUI (`/rhythms`, the Review-pane **+** menu, or **Settings →
Rhythms**); **Allow always** on a prompt writes allow. Rhythms' own permissions
still apply.

## Setup

```sh
pixi run --locked install                              # verified snapshot into your OpenCode config
pixi run signin work --email you@company.com           # or use the GUI, or ask your agent
```

Export/Import in the GUI moves accounts, permissions and sign-ins between
installs (passphrase-encrypted).

## Development

```sh
pixi run --locked test            # fake Rhythms: OAuth (DCR, PKCE, rotating refresh), MCP, wrong-email handling
pixi run --locked smoke-host      # real OpenCode 2.2.6 CLI, scripted model, fake Rhythms
```
