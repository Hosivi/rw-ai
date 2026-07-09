# rw-ai.nvim

The rw-ai cockpit as a Neovim plugin (v0.5 Phase 3). It connects to the per-repo
observer daemon and shows every session's live state, right in Neovim.

Status: **WU-3.1 (RPC client) + WU-3.2 (`:RwStatus` dashboard)**. Review, evidence,
and decision actions (3.3–3.5) build on this.

## Requirements

- **Neovim 0.10+** (uses `vim.uv`; falls back to `vim.loop`).
- The **`rw` CLI** available — either on `PATH`, or point the plugin at it
  (see `rw_cmd` below). Build it first from the repo root: `pnpm install && pnpm build`
  (produces `dist/cli.js`).

## Install

The plugin lives in-repo under `nvim/`. Install it by pointing your plugin manager
at that directory.

**lazy.nvim** (local checkout):

```lua
{
  dir = '/absolute/path/to/rw-ai/nvim',
  config = function()
    require('rw-ai').setup({
      -- If `rw` is on your PATH, omit this. Otherwise point at the built CLI:
      rw_cmd = { 'node', '/absolute/path/to/rw-ai/dist/cli.js' },
    })
  end,
}
```

`rw_cmd` is a list so `node dist/cli.js` works as well as a `rw` binary on `PATH`.

## Use

From anywhere inside an rw-ai repo:

```
:RwStatus
```

It opens a split with one line per session — light (🔴/🟡/🟢), session id, claim,
git (ahead/behind/dirty), phase, branch — and **updates live** as claims, markers,
and git state change. The plugin starts the daemon for you (detached) if it isn't
already running; the daemon self-shuts-down when idle.

## How it works

- `rw daemon --address` gives the plugin the daemon's pipe/socket address (no sha256
  re-derivation in Lua — one source of truth).
- `lua/rw-ai/rpc.lua` connects over `vim.uv`, frames requests with the same
  length-prefixed JSON protocol as the daemon (`lua/rw-ai/frames.lua`), and
  `subscribe`s for a snapshot + live updates.
- `lua/rw-ai/status.lua` renders the snapshot into buffer lines (pure, snapshot-testable).

## Test

Pure pieces (framing + rendering), no daemon needed — from the repo root:

```
nvim --headless -u NONE -c "set rtp+=nvim" -c "luafile nvim/test/smoke.lua" -c "qa!"
```

It prints `ok`/`FAIL` per check and exits non-zero on any failure.

End-to-end: build the CLI, open Neovim inside a configured rw repo, run `:RwStatus`,
and you should see your sessions. `:RwStatus` again re-renders; changing a claim
(`rw claim …`) or a marker should update the buffer within ~2s.
