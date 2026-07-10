-- Thin wrapper around the `rw` CLI, shared by the plugin modules. rw_cmd is a
-- list so `node /path/dist/cli.js` works as well as a `rw` on PATH.

local M = {}

local rw_cmd = { 'rw' }

function M.set_cmd(c)
  rw_cmd = type(c) == 'string' and { c } or c
end

function M.build(extra)
  local c = vim.deepcopy(rw_cmd)
  vim.list_extend(c, extra)
  return c
end

-- Run `rw <extra...>`. Returns (exit_code, stdout).
function M.run(extra)
  local out = vim.fn.system(M.build(extra))
  return vim.v.shell_error, out
end

-- Run and decode a --json command. Returns (decoded | nil, err_text).
function M.run_json(extra)
  local code, out = M.run(extra)
  if code ~= 0 then
    return nil, vim.trim(out)
  end
  local ok, decoded = pcall(vim.json.decode, out)
  if not ok then
    return nil, out
  end
  return decoded
end

-- Spawn a long-running rw subcommand detached (e.g. the daemon).
function M.spawn(extra)
  vim.fn.jobstart(M.build(extra), { detach = true })
end

return M
