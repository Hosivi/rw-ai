-- rw-ai.nvim — the cockpit as a Neovim plugin (Phase 3).
-- WU-3.1 (RPC client) + WU-3.2 (:RwStatus dashboard). Review/evidence/decisions
-- (3.3–3.5) build on this connection.

local rpc = require('rw-ai.rpc')
local status = require('rw-ai.status')

local M = {}

-- rw_cmd is a LIST so `node /path/dist/cli.js` works as well as a `rw` on PATH.
local config = {
  rw_cmd = { 'rw' },
  connect_retries = 15,
  connect_delay_ms = 200,
  split = 'botright 15split',
}

local state = { client = nil, buf = nil, states = {}, address = nil }

local function notify(msg, level)
  vim.notify('rw-ai: ' .. msg, level or vim.log.levels.INFO)
end

local function cmd(extra)
  local c = vim.deepcopy(config.rw_cmd)
  vim.list_extend(c, extra)
  return c
end

-- Address from the CLI — the single source of truth, so Lua never re-derives the
-- sha256 address the daemon uses.
local function daemon_address()
  local out = vim.fn.system(cmd({ 'daemon', '--address' }))
  if vim.v.shell_error ~= 0 then
    return nil, vim.trim(out)
  end
  return vim.trim(out)
end

-- Spawn the daemon detached. Harmless if one already runs: the CLI single-instance
-- guard makes the second invocation a no-op.
local function ensure_daemon()
  vim.fn.jobstart(cmd({ 'daemon' }), { detach = true })
end

local function ensure_buffer()
  if state.buf and vim.api.nvim_buf_is_valid(state.buf) then
    return state.buf
  end
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'hide'
  vim.bo[buf].swapfile = false
  vim.bo[buf].modifiable = false
  pcall(vim.api.nvim_buf_set_name, buf, 'rw-ai://status')
  state.buf = buf
  return buf
end

local function render()
  local buf = ensure_buffer()
  if not vim.api.nvim_buf_is_valid(buf) then
    return
  end
  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, status.render(state.states))
  vim.bo[buf].modifiable = false
end

local function connect(address, attempt)
  attempt = attempt or 1
  state.client = rpc.connect(address, {
    on_connect = function(client)
      client.subscribe()
    end,
    on_snapshot = function(states)
      state.states = states
      render()
    end,
    on_update = function(states)
      state.states = states
      render()
    end,
    on_error = function(err)
      if attempt < config.connect_retries then
        -- The daemon may still be coming up after ensure_daemon(); back off and retry.
        vim.defer_fn(function()
          connect(address, attempt + 1)
        end, config.connect_delay_ms)
      else
        notify('could not connect to the daemon: ' .. tostring(err), vim.log.levels.ERROR)
      end
    end,
  })
end

function M.open_status()
  local address, err = daemon_address()
  if not address or address == '' then
    notify('could not get the daemon address (are you inside an rw repo?): ' .. (err or ''), vim.log.levels.ERROR)
    return
  end
  state.address = address
  ensure_daemon()

  local buf = ensure_buffer()
  vim.cmd(config.split)
  vim.api.nvim_win_set_buf(0, buf)
  render()

  if state.client then
    state.client.close()
    state.client = nil
  end
  connect(address, 1)
end

function M.close()
  if state.client then
    state.client.close()
    state.client = nil
  end
end

function M.setup(opts)
  opts = opts or {}
  if opts.rw_cmd then
    config.rw_cmd = type(opts.rw_cmd) == 'string' and { opts.rw_cmd } or opts.rw_cmd
  end
  if opts.split then
    config.split = opts.split
  end
  vim.api.nvim_create_user_command('RwStatus', function()
    M.open_status()
  end, { desc = 'rw-ai: live session status dashboard' })
end

return M
