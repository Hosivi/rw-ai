-- Pure rendering for the :RwStatus dashboard (WU-3.2). Takes the daemon's
-- PublicSessionState array and returns buffer lines. Kept side-effect-free so it
-- can be snapshot-tested under `nvim --headless`.

local M = {}

local LIGHT_ICON = { red = '🔴', yellow = '🟡', green = '🟢' }

-- vim.json.decode maps JSON null to vim.NIL (a sentinel), NOT Lua nil — and
-- vim.NIL is truthy, so `x or default` would keep it. Normalize both to a default.
local function coalesce(value, default)
  if value == nil or value == vim.NIL then
    return default
  end
  return value
end

local function claim_label(claim)
  claim = claim or {}
  if claim.status == 'free' then
    return 'free'
  end
  if claim.expired then
    return 'expired'
  end
  return 'held'
end

local function git_label(git)
  git = git or {}
  local parts = {}
  if (git.ahead or 0) > 0 then
    parts[#parts + 1] = '+' .. git.ahead
  end
  if (git.behind or 0) > 0 then
    parts[#parts + 1] = '-' .. git.behind
  end
  if git.dirty then
    parts[#parts + 1] = 'dirty'
  end
  if #parts == 0 then
    return 'clean'
  end
  return table.concat(parts, ' ')
end

function M.render(states)
  if not states or #states == 0 then
    return {
      'rw-ai — no active sessions',
      '',
      'If this seems wrong, check the daemon: `rw daemon` in the repo.',
    }
  end
  local lines = { 'rw-ai — sessions', '' }
  for _, s in ipairs(states) do
    local icon = LIGHT_ICON[s.light] or '⚪'
    lines[#lines + 1] = string.format(
      '%s  %-8s  %-8s  %-14s  %-10s  %s',
      icon,
      coalesce(s.sessionId, '?'),
      claim_label(s.claim),
      git_label(s.git),
      coalesce(s.phase, '-'),
      coalesce(s.branch, '')
    )
  end
  return lines
end

return M
