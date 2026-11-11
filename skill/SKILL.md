---
name: rhythms
description: Work effectively in Rhythms (rhythms.ai) through the oc-rhythms tools — finding your and your team's OKRs/goals, check-ins, progress, documents and their sections, comments, teams and users, saved views and reports, and delegating cross-app work to the Rhythms agent. Load before non-trivial Rhythms work.
---

# Working in Rhythms

Rhythms holds a company's goals (OKRs: Objectives, Key Results, Initiatives), check-ins, documents, teams and
saved views. You act as the signed-in user with exactly their Rhythms permissions.

## Tools

- `rhythms_list` — accounts, who is signed in, which workspace (`tenantUuid`), and what you may do.
- `rhythms_find_actions` — search actions by keyword; then `names=[...]` for exact parameters. **Read the schema before
  the first call of an action**; parameters are specific (`my_role_in`, `goal_uuid`, `detail`, …) and some are nested
  (`edit_document_content` takes `{request: {…}}`).
- `rhythms_run` — run an action.

Permissions (defaults): reads, creates and edits (including check-ins) run; deletes, unsharing, sharing and admin
changes (teams, invites, time periods, labels, publishing) and delegating to the Rhythms agent ask. If something is
denied, tell the user; do not work around it.

## Recipes

- **Who am I / which workspace:** `whoami` (only when identity matters).
- **My goals:** `search_knowledge` with `type: "goal"` and `my_role_in: ["owner", "delegate", "contributor"]`. Do not
  assume the current quarter; add `time_period_name` (e.g. "Q4 2026") only when asked. Page (`page`, `per_page` ≤ 50)
  while `pagination.has_more`; never treat one page as everything. `archived: "include"` if a goal seems missing.
- **A team's goals:** `list_teams` → match the name → `search_knowledge` with `team_uuid`.
- **One goal in depth:** `get_goal` with its UUID or short id (`OBJ-123`); children via `search_knowledge`
  `parent_goal_uuid=…`; history via `list_goal_checkins` (across goals: `search_checkins`).
- **Check-ins:** confirm goal, value/status and note with the user, then `create_checkin` with the goal **UUID** (short
  ids are rejected) and at least one of `value`, `status` (`not_started`, `in_progress`, `on_track`, `behind`,
  `at_risk`, `closed` + `score` 0–1, `postponed`), `note`.
- **Creating goals:** `get_settings` and `list_time_periods` first; align to a parent only when the user names one.
- **Documents:** `search_knowledge` with `type: "document", document_type: "document"`; read one section with
  `get_document_section` or search inside with `search_document_content` before loading a whole body. Edit with
  `edit_document_content`: one paragraph/row via `replace_anchored`/`delete_anchored` and an exact `anchor` quote;
  sections via `target_heading` (from `get_document` headings; omitting it replaces the whole body). Echo component
  tags back unchanged.
- **Reports and saved views:** `search_views` → `get_view_data` (use `summary.total_goal_count`; never count yourself).
- **Cross-app questions** (connected apps such as Jira, Slack, Salesforce; also "what did we decide"):
  `answer_and_act_across_apps` with `prompt` and a unique `request_id`, then `get_work` with the `work_id`
  (`wait_seconds` ≤ 20) until it ends; if it needs input, ask the user and reply with `continue_work`. Research does
  not authorize writes; say exactly what may be changed.

## Habits

1. Read before writing; prefer UUIDs over names for changes; ask when a name matches several records.
2. Confirm before deleting, archiving, sharing, inviting, publishing or bulk changes.
3. Report results with links (prefer a returned `url`): goals `https://app.rhythms.ai/goal/<short_id>?type=<Okrs::Objective|Okrs::KeyResult|Okrs::Initiative>&switchToTenant=<tenant_uuid>`,
   documents `https://app.rhythms.ai/library/<tenant_uuid>_<uuid>?switchToTenant=<tenant_uuid>`.
4. If an action answers `account_setup_required`, the sign-in reached no workspace — usually the wrong email. Tell the
   user to check the email on their Rhythms profile and sign in again with it (`rhythms_account_upsert email=…`,
   `rhythms_signin`). Use `join_workspace` only for a workspace the user picked from that response.
