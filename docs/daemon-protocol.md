# rw-ai observer daemon — client protocol

The observer daemon is a **read/notify** service over the per-session read model.
Any local process — the Neovim plugin, a status TUI, or an external agent/server —
can connect and observe workspace state. It is **read-only**: there is no mutation
verb. To mutate claims, use the MCP tools or the `rw` CLI (both go through the
single owner, `engine/identity.ts`).

## 1. Discover the address

The daemon is per-repo, addressed by a pipe/socket derived from the repo path.
Ask the CLI instead of re-deriving it:

```
rw daemon --address
# Windows: \\.\pipe\rw-ai-<hash>
# Unix:    <tmpdir>/rw-ai-<hash>.sock
```

`rw daemon` (no flag) starts the daemon if needed; it self-shuts-down when idle.

## 2. Connect

Open the pipe/socket with your platform's normal client (Node `net`, libuv,
Python `socket`, etc.). The Unix socket is `chmod 0600` (owner only).

## 3. Framing

Every message is a **length-prefixed JSON frame**: a 4-byte big-endian `uint32`
byte length, then that many UTF-8 bytes of JSON. A stream carries many frames;
buffer partial reads. Reject a frame whose declared length is absurdly large.

## 4. Messages

**Client → daemon** (the only two verbs):

```json
{ "type": "subscribe" }   // snapshot now + an update on every change
{ "type": "get" }         // one snapshot, no further updates
```

**Daemon → client:**

```json
{ "type": "snapshot", "rev": 1, "states": [ /* PublicSessionState */ ] }
{ "type": "update",   "rev": 2, "states": [ /* PublicSessionState */ ] }
```

`rev` is a monotonic revision. An `update` is pushed only when the state actually
changes. `states` is always the **wire-safe** projection — it never contains the
claim token.

### PublicSessionState

```jsonc
{
  "sessionId": "s1",
  "branch": "feat/s1",
  "areas": ["src/a/**"],
  "light": "green",           // "red" | "yellow" | "green"
  "claim": { "status": "free", "expired": false },  // NO token
  "phase": null,              // "idle"|"working"|"blocked"|"review" | null
  "tests": null,              // "passed"|"failed"|"unknown" | null
  "git": { "dirty": false, "ahead": 0, "behind": 0 }
}
```

## 5. Rules

- **Send a request promptly.** A connection that stays silent past the handshake
  window is dropped (so a muted client can't pin the daemon alive).
- **One malformed frame closes your connection** — keep framing correct.
- **Read-only.** Any request other than `subscribe`/`get` closes the connection.
  Mutations (claim/release/finish/decide) go through MCP tools or the `rw` CLI.
