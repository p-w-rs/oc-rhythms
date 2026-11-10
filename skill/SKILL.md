---
name: rhythms
description: Work effectively in Rhythms (rhythms.ai) through the oc-rhythms tools — finding your and your team's OKRs/goals, check-ins, progress, documents and their sections, comments, teams and users, saved views and reports, and delegating cross-app work to the Rhythms agent. Load before non-trivial Rhythms work.
---

# Working in Rhythms

Rhythms holds a company's goals (OKRs: Objectives, Key Results, Initiatives), check-ins, documents, teams and
saved views. You act as the signed-in user with exactly their Rhythms permissions.

## Tools

- `rhythms_list` — accounts, who is signed in, which workspace, and what you may do.
- `rhythms_find_actions` — search actions by keyword; then `names=[...]` for exact parameters. **Read the schema before
  the first call of an action**; Rhythms' parameters are specific (`my_role_in`, `goal_uuid`, `detail`, …).
- `rhythms_run` — run an action.

Permissions: reads usually just run; creates, edits and check-ins may run or ask; deletes, sharing, admin changes
(teams, invites, time periods, labels, publishing) and delegating to the Rhythms agent ask by default. If something is
denied, tell the user; do not work around it.

## Recipes

- **Who am I / which workspace:** `whoami` (only when identity matters).
- **My goals:** `search_knowledge` with `type: "goal"` and `my_role_in: ["owner", "delegate", "contributor"]` (or
  `owner_is_current_user: true`). Do not assume the current quarter; add `time_period_name` (e.g. "Q4 2026") only
  when the user asks. Page with `page`/`per_page`; never treat one page as everything.
- **A team's goals:** `list_teams` → match the name → `search_knowledge` with `team_uuid`.
- **One goal in depth:** `get_goal` with its UUID or short id (`OBJ-123`, `KR-45`); children via
  `search_knowledge parent_goal_uuid=…`; history via `list_goal_checkins`.
- **Check-ins:** confirm goal, value, status and date with the user, then `create_checkin`. Status values follow the
  workspace's labels (see `get_settings`): on track, at risk, behind, …
- **Creating goals:** `list_time_periods` first; align to a parent only when the user names one.
- **Documents:** find with `search_knowledge type: "document"`; read one section with `get_document_section` or
  search inside with `search_document_content` before loading a whole body. Edit with `edit_document_content`
  (`target_heading` from `get_document` headings; echo component tags back unchanged).
- **Reports and saved views:** `search_views` → `get_view_data` (use its computed counts; never count from prose).
- **Decisions, commitments, "what did we conclude":** `search_operating_memory` when available.
- **Cross-app questions** (Rhythms' connected apps such as Jira, Slack, Salesforce): `answer_and_act_across_apps`
  with a unique `request_id`, then `get_work` with `wait_seconds: 15` until it ends; follow-ups with `continue_work`.
  Research does not authorize writes; say exactly what may be changed.

## Habits

1. Read before writing; prefer UUIDs over names for changes; ask when a name matches several records.
2. Confirm before deleting, archiving, sharing, inviting, publishing or bulk changes.
3. Report results with links: goals `https://app.rhythms.ai/goal/<short_id>?type=<Okrs::Objective|Okrs::KeyResult|Okrs::Initiative>&switchToTenant=<tenant_uuid>`,
   documents `https://app.rhythms.ai/library/<tenant_uuid>_<uuid>?switchToTenant=<tenant_uuid>`. `tenantUuid` is in `rhythms_list`.
4. If an action answers `account_setup_required`, the sign-in reached no workspace — usually the wrong email. Tell the
   user to check the email on their Rhythms profile and sign in again with it (`rhythms_account_upsert email=…`,
   `rhythms_signin`).
