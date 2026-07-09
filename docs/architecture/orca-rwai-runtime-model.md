# ORCA and RWAI Runtime Model

RWAI's redesigned target is a local runtime/control-plane for parallel
coding-agent workspaces. It is not an AI system, does not manage model tokens,
and should not compete with ORCA as an IDE or visual orchestration surface.

## Target architecture

RWAI owns the isolation and evidence needed to run, debug, test, and evaluate
many agent sessions safely on one machine. Visual multi-agent and worktree
orchestration can live in ORCA or another client that calls into RWAI.

```text
ORCA / agent CLI / human tool
        |
        v
RWAI control plane: sessions, claims, worktree adoption, runtime manifests
        |
        v
Per-session runtime: ports, DB/env, debug/test/deploy evaluation endpoint
        |
        v
Review Workbench backing store: evidence, summaries, diagrams, risks, links
```

## Responsibility split

| Area | ORCA / external clients | RWAI |
| --- | --- | --- |
| Product role | IDE, visual orchestration, multi-agent UX. | Local runtime/control-plane and evidence layer. |
| Worktrees | May create, display, and arrange worktrees. | Adopts external worktrees or creates managed ones later. |
| Sessions | Presents session assignment and activity. | Defines session identity, claims, runtime state, and manifests. |
| Runtime isolation | Shows status and entry points. | Allocates ports, DB/env, debug/test/deploy evaluation data. |
| Review | Can visualize or link artifacts. | Produces Review Workbench artifacts in the configured review-board directory. |
| Agent history | May provide rich navigation when available. | Indexes links/highlights without depending on deep UI control. |

## Worktree ownership modes

| Mode | Meaning | RWAI behavior |
| --- | --- | --- |
| `external` / adopted | ORCA, a human, or another tool created the worktree. | Validate path, bind it to a session, record provenance, and avoid recreating it. |
| `managed` | Future mode where RWAI may create the worktree. | Document only for slice 1 unless a tiny enum/schema placeholder already exists cleanly. Do not create worktrees. |

Slice 1 implements external adoption first. RWAI should not require worktree
creation before it can model runtime state.

## Runtime instance model

Each session maps to one runtime instance manifest:

```text
session
  -> worktree reference
  -> port assignments
  -> DB/env bindings
  -> debug/test commands and URLs
  -> deploy or preview evaluation target
  -> evidence outputs for the Review Workbench
```

The manifest is a machine-local contract between orchestration clients and
runtime tooling. It should be inspectable on the current machine and safe to
regenerate from the RWAI config plus current machine state. Secrets stay in
environment sources, not in manifests.

## MVP Runtime Manifest Contract

Slice 1 writes one manifest per adopted session at:

```text
<projectRoot>/<board.dir>/runtime-manifests/<session.id>.json
```

With current defaults, session `s1` writes to
`.review-board/runtime-manifests/s1.json`.

Required fields for slice 1:

| Field | Meaning |
| --- | --- |
| `version` | Manifest contract version, starting at `1`. |
| `generatedAt` | ISO timestamp for the last regeneration. |
| `projectRoot` | Absolute root used to resolve relative config paths. |
| `session.id` | Adopted RWAI session id, for example `s1`. |
| `session.branch` | Configured branch name for the session. |
| `worktree.mode` | `external` only in slice 1. |
| `worktree.path` | Adopted source worktree path from the current process or CLI option. |
| `worktree.resolvedPath` | Resolved local path after validation. |
| `worktree.branch` | Detected branch when the adopted path is a git worktree and branch detection succeeds. |
| `worktree.provenance` | `adopted` plus the source path/client when known. |
| `reviewBoardDir` | Resolved backing-store directory for Review Workbench artifacts. |
| `paths` | Manifest path, session artifact directory, claims file path, and intended `.env.local` path for the adopted worktree. |
| `ports` | Session port assignments from `agents.config.json`, when configured. |
| `db` | Non-secret DB runtime metadata: strategy, host, port, service, and session DB name when configured. |
| `env.entries` | Generated debug/evaluation environment entries such as `RW_SESSION`, `RW_BOARD_DIR`, ports, API URLs, and `DATABASE_URL` placeholders. |
| `tests` | Test capture settings from `agents.config.json`. |

Excluded from slice 1: secrets, claim tokens, managed worktree creation data,
debug/test/deploy command execution, evidence payloads, and transcript contents.
Generated env values may include placeholders such as `${RW_DB_PASSWORD}`; real
secret values remain in the caller environment and are not written to manifests.

Regeneration is deterministic: RWAI may overwrite the session manifest from
`agents.config.json` and current machine validation. Consumers must not store
manual edits there; add separate Review Workbench artifacts instead.

Review Workbench consumption: slice 1 stores the manifest in the Workbench backing
store for local inspection by humans and external clients, but runtime manifests
are not shareable review evidence. They contain local absolute paths and are
ignored from git. Review Workbench publishing should reference durable evidence
artifacts instead of committing these runtime manifests.

## Review Workbench

The Review Workbench remains part of RWAI. ORCA's design view does not replace
it; ORCA can consume or visualize it. The configured review-board directory is
the persisted backing store for Review Workbench artifacts, not a separate
product.

Workbench contents:

- runtime manifest references and per-session status;
- diagrams and architecture deltas;
- test, debug, and deploy/evaluation evidence;
- implementation summaries and handoff notes;
- decision, risk, and exception records;
- Conversation Ledger links and highlighted artifacts.

Boundary: the Workbench stores review evidence. It is not an IDE, chat UI, or
agent execution engine.

## Conversation Ledger

The Conversation Ledger indexes Claude, OpenCode, and other agent sessions at a
durable reference level.

Scope:

- links to session transcripts or native history locations;
- important highlights, artifacts, and resume commands;
- association between a conversation, session, claim, worktree, and review item;
- adapter-specific metadata when available.

Non-goals:

- replaying or controlling exact in-agent UI state;
- depending on precise navigation to every historical response;
- replacing native agent history stores.

## External tool posture

| Tool | Posture | Reason |
| --- | --- | --- |
| AXI | Inform CLI and agent-native UX. | Useful interaction patterns without becoming RWAI's core domain. |
| Lavish | Complement or replace visual artifacts where helpful. | Can improve diagrams/review visuals without changing runtime ownership. |
| no-mistakes | Complement verification. | Useful as an additional review/evaluation signal. |
| Treehouse | Not primary for now. | Overlaps orchestration/worktree flow. |
| gnhf | Not primary for now. | Overlaps orchestration/worktree flow. |
| firstmate | Not primary for now. | Overlaps orchestration/worktree flow. |
| OpenSuperWhisper | Complement input. | Helps human prompting and dictation; not a runtime primitive. |
| Herdr | Out of scope. | Not relevant to the current user flow. |

## Implementation sequence

1. **External worktree adoption + runtime instance manifest**: bind an existing
   worktree to a session and emit the local manifest. Do not create worktrees in
   this slice.
2. Session assignment and claims: make adoption safe for many agents and a human
   integrator.
3. Port and DB/env binding: populate the manifest with isolated runtime values.
4. Debug/test/deploy evaluation entries: expose commands, URLs, and evidence
   outputs for each session.
5. Review Workbench publishing: write manifests, summaries, risks, diagrams, and
   test evidence into durable Review Workbench artifacts.
6. Conversation Ledger adapters: link Claude/OpenCode sessions, highlights,
   artifacts, and resume commands.
7. Optional managed worktree provisioning: create worktrees only after adoption
   and runtime manifest semantics are stable.
