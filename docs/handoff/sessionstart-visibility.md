# Handoff: make the rw SessionStart offer visible to the human

**Status:** TRIED AND REVERTED — do NOT re-apply as-is. The stderr+exit-2
approach was implemented (commit b1b11cb) and reverted, because Claude Code
labels ANY SessionStart hook that exits 2 as "SessionStart:startup hook error".
Since the hook is installed at USER scope, that turned every Claude Code launch
in EVERY folder into a red "hook error" showing the rw offer — noisy and
alarming, not the clean self-introduction the user wanted. Decision: keep the
hook SILENT (stdout additionalContext, exit 0) so the agent still discovers rw
while the human sees no error. If human-visible presentation is revisited, do it
ONLY at project scope (repos rw), never user scope, to avoid the global noise.
**Type:** small behavior change in one file + test updates.
**Owner:** closed (reverted by decision).

---

## Problem

When a user opens Claude Code in a folder, they see **nothing** from rw: no
message, no menu, no hint that rw exists or that they can configure the repo.
The user's words: *"no ocurre que rw se presente solo ni me deja configurar."*

This is a real, correct observation — not a config bug.

## Root cause (verified against the official Claude Code hooks docs)

The `SessionStart` hook (`rw session-start`) **is** installed and **does** run
on every session (confirmed: its context reaches the agent in live sessions,
including on Windows — so the hook command itself works, no `cmd /c` needed for
hooks). The problem is purely **visibility**:

- A SessionStart hook's **stdout** `additionalContext` is *"injected as a system
  reminder that Claude reads as plain text"* — it goes **only to the model's
  context and is invisible to the human user** in the terminal.
  (docs: `code.claude.com/docs/en/hooks-guide.md`, ~L554, ~L886)
- The **only** way a SessionStart hook can show text the human actually sees is
  **exit code 2 + stderr** (*"exit 2 shows stderr to the user and execution
  continues"*).
- The assistant **does not speak proactively** at session open; it stays silent
  until the user sends the first prompt. There is no auto-greeting in
  interactive mode (`initialUserMessage` only applies to non-interactive `-p`).

Today `rw session-start` emits its offer via **stdout + exit 0**, so it reaches
the agent but is invisible to the human. That is exactly why the user sees
nothing.

## What the user actually wants

At minimum: to **see** on opening Claude that rw is available and how to
configure — e.g. a terminal line like:

> rw-ai disponible. Este directorio no está configurado para trabajo
> multi-sesión. Corre `rw bootstrap` para inicializar git + sesiones aisladas.

Making the offer visible resolves **both** complaints at once ("no se presenta"
and "no me deja configurar"), because the visible message tells the user how to
configure.

---

## The change

Make `rw session-start` emit its message via **stderr + exit 2** instead of
stdout + exit 0, so the human sees it.

**File:** `src/cli/commands/session-start.ts`

Currently `sessionStartOutput(text)` returns
`{ lines: [JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart',
additionalContext } })], exitCode: 0 }`.

Change it to return the human-visible shape:
`{ lines: [], stderr: [text], exitCode: 2 }`.

**Copy the exact pattern already used by the lane guard** — same repo, same
mechanism — see `src/cli/commands/lane-guard.ts:68`:
`return { lines: [], stderr: [reason], exitCode: 2 };`

The `CommandResult` type already supports this: `stderr?: readonly string[]` +
`exitCode` (`src/cli/command.ts`), and the bin routes `result.stderr` to
`console.error` (`src/cli/run.ts` ~L322). No new plumbing needed.

Keep the **fail-open** guarantee: any thrown error must still end at
exit 2 with the generic offer on stderr (never break session startup, never
propagate). The three context branches (offer / inside-a-session / configured
shared-root) should all switch to the stderr+exit2 shape.

### Critical tradeoff to decide before implementing

`exit 2` means Claude Code **ignores the hook's stdout** (documented in
`lane-guard.ts:38-39`: *"Claude Code ignores stdout JSON when a hook exits 2"*).
So you **cannot** deliver both in one hook invocation: either the human sees the
message (stderr + exit 2) **or** the agent gets `additionalContext` (stdout +
exit 0) — not both.

**Recommended:** go stderr + exit 2 (human-visible). The agent still discovers
rw through the MCP tools (`rw_*`) and the installed skills, so losing the
`additionalContext` reminder is acceptable. If both are truly wanted, the only
way is to register **two** SessionStart hook groups (one exit-0/stdout for the
agent, one exit-2/stderr for the human) — more complex and needs verification
that the exit-2 group doesn't suppress the other; do NOT do this unless asked.

## Files to touch

- `src/cli/commands/session-start.ts` — the change above.
- `src/cli/commands/session-start.test.ts` — update assertions: the three
  branches now assert `exitCode === 2`, `stderr` contains the expected message,
  and `lines` is empty (was: exit 0 + JSON on `lines`/stdout). Keep the
  fail-open test (thrown error → exit 2 + generic offer on stderr).

## Acceptance criteria

- `pnpm typecheck` and `pnpm test` green.
- `rw session-start` returns `{ lines: [], stderr: [<offer>], exitCode: 2 }` for
  an unconfigured dir; analogous stderr+exit2 for the in-session and configured
  shared-root branches.
- Manual check on Windows: open Claude Code in a fresh folder → the rw offer is
  now **visible in the terminal** (previously nothing appeared).

## Out of scope / separate open decision (do NOT bundle here)

Whether rw should **auto-RUN** bootstrap (silently `git init` + create
worktrees) on session open, vs only **OFFER** it. The user originally chose
**Option A: offer, never auto-run** (see `session-start.ts` header comment), and
the hook is installed at USER scope so it fires in *every* folder — auto-running
would `git init` random directories. This handoff only makes the existing
**offer visible**; auto-run is a distinct product decision pending the user's
call.
