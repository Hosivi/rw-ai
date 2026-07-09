# Startup Integration Architecture

> Current direction: this startup model is now a supporting adapter concern.
> The target architecture is defined in
> [`orca-rwai-runtime-model.md`](./orca-rwai-runtime-model.md).

RWAI is an agent-agnostic revision workspace manager. It coordinates sessions,
claims, worktrees, branches, ports, databases, and the Review Workbench backing
store; it is not an AI system and it does not manage model tokens.

## Decision summary

| Topic | Decision |
| --- | --- |
| Core identity | RWAI models agents as external clients, not domain-specific agent kinds. |
| Point of entry | Users should start Claude Code, OpenCode, or another agent normally. |
| Startup UX | An in-agent startup selector or hook should help the user choose, assume, or create a session. |
| Fallback | A launcher or shim is the reliable fallback when the process must start in a different worktree. |
| Scale | RWAI must support one active agent and many parallel agents. |
| Boundary | ORCA may own visual orchestration; RWAI owns local runtime and review evidence state. |

## Current state

The contract already describes projects, sessions, claims, worktrees, ports,
databases, and the configured review-board directory. That directory is the
persisted backing store for Review Workbench artifacts. Sessions can be
bootstrapped up front, and claims provide cooperative locking for session roles
plus the integrator role.

The first contract shape treated claim `agent` as a small closed enum. That was
useful for early examples, but it incorrectly made specific agent products look
like core RWAI concepts.

## Target state

RWAI core stays agent-agnostic. Agent-specific behavior belongs in adapters,
hooks, launchers, or shims around the core contract.

The target startup flow is:

1. The user starts their preferred agent normally.
2. A lightweight startup hook or selector checks the RWAI workspace state.
3. The user chooses an existing session, assumes a free role, or creates the next session.
4. RWAI records the claim and exposes the session context needed by the agent.
5. If the current process cannot safely change into the selected worktree, a transparent launcher or shim starts the agent in the right directory.

## Why hook plus launcher fallback

Hooks provide the best default experience because they meet users where they
already work: inside their chosen agent. They are also adapter-owned, so adding a
new agent does not require changing RWAI's core domain model.

A launcher or shim remains necessary because process working directories are not
equally mutable across agents, shells, and operating systems. When a hook cannot
reliably move the running process to the selected worktree, the launcher can start
a fresh process with the correct directory and environment.

## Claims purpose

Claims are cooperative workspace locks. They answer which external client is
currently using a session or the integrator role, when the claim started, and
when it expires.

Claims are not authentication, authorization, or AI token management. They exist
to prevent two parallel agents from accidentally editing or integrating through
the same role at the same time.

## Dynamic sessions

RWAI should not require teams to know the full worker count before starting.
Bootstrap can create an initial workspace, and later helpers can derive the next
session index from existing sessions and append a new schema-valid session.

Dynamic session creation is now split into two layers:

- The contract layer remains pure: it derives the next session index and appends a
  schema-valid session without touching the filesystem.
- The bootstrap layer performs only safe local filesystem orchestration: it
  creates or loads `agents.config.json`, ensures the configured review-board
  directory for Review Workbench artifacts exists, creates or reconciles
  `claims.json`, and returns session environment entries for hooks or launchers
  to consume later.

This bootstrap does not create git branches, git worktrees, databases, commits,
or agent processes. Those side effects remain future launcher, hook, or
provisioning responsibilities.

Manual testing is available through `rw prepare`. It prepares local RWAI state in
the current directory, and `rw prepare --append-session` appends the next dynamic
session before reconciling claims.

## Review Workbench backing store

The configured review-board directory is the persisted backing store for Review
Workbench artifacts. Sessions can publish handoff notes, evidence, and status
there without coupling the core contract to one agent product.

This keeps the workflow consistent whether one agent is active, several agents
are working in parallel, or a human integrator is reviewing and merging work.
