-- :RwReview <id> — the review table (WU-3.3/3.4/3.5).
-- One `rw review-info` call gives the changed files (3.3), the evidence — board
-- dir, integrator report, prior decisions (3.4) — and the session's diff targets.
-- Keymaps open a changed file as a real editable buffer (LSP/keymaps intact) and
-- record approve/reject/comment decisions (3.5).

local cli = require('rw-ai.cli')

local M = {}

local state = { buf = nil, info = nil, file_lines = {} }

local function is_present(v)
  return v ~= nil and v ~= vim.NIL and v ~= ''
end

local function read_report(path)
  if is_present(path) and vim.fn.filereadable(path) == 1 then
    return vim.fn.readfile(path)
  end
  return nil
end

-- Returns (lines, file_map) where file_map[buffer_line] = absolute file path.
local function build_lines(info)
  local lines, file_map = {}, {}
  local function add(s)
    lines[#lines + 1] = s
  end

  add('rw-ai — review ' .. info.sessionId)
  add('')
  add('Branch: ' .. info.branch .. '  vs  ' .. info.integrationBranch)
  add('Worktree: ' .. info.worktree)
  add('')
  add('Changed files (' .. #info.changedFiles .. ')   [<CR> open  d diagram  a approve  r reject  c comment  q close]')
  if #info.changedFiles == 0 then
    add('  (none)')
  else
    for _, f in ipairs(info.changedFiles) do
      add('  ' .. f)
      file_map[#lines] = info.worktree .. '/' .. f
    end
  end
  add('')
  add('Decisions (' .. #info.decisions .. ')')
  if #info.decisions == 0 then
    add('  (none yet)')
  else
    for _, d in ipairs(info.decisions) do
      local comment = is_present(d.comment) and (' — ' .. d.comment) or ''
      add('  ' .. (d.decidedAt or '?') .. '  ' .. (d.verdict or '?') .. comment)
    end
  end
  add('')
  add('Integrator report:')
  local report = read_report(info.reportPath)
  if report then
    for _, l in ipairs(report) do
      add('  ' .. l)
    end
  else
    add('  (no report yet — run `rw check`)')
  end

  return lines, file_map
end

local function ensure_buffer()
  if state.buf and vim.api.nvim_buf_is_valid(state.buf) then
    return state.buf
  end
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'hide'
  vim.bo[buf].modifiable = false
  pcall(vim.api.nvim_buf_set_name, buf, 'rw-ai://review')
  state.buf = buf
  return buf
end

local function render()
  if not state.info then
    return
  end
  local buf = ensure_buffer()
  local lines, file_map = build_lines(state.info)
  state.file_lines = file_map
  vim.bo[buf].modifiable = true
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].modifiable = false
end

local function refresh()
  if not state.info then
    return
  end
  local info, err = cli.run_json({ 'review-info', state.info.sessionId, '--json' })
  if info then
    state.info = info
    render()
  else
    vim.notify('rw-ai: review-info failed: ' .. (err or ''), vim.log.levels.ERROR)
  end
end

local function open_file_under_cursor()
  local lnum = vim.api.nvim_win_get_cursor(0)[1]
  local file = state.file_lines[lnum]
  if file then
    -- A real file buffer in the previous window: full LSP, keymaps, gitsigns gutter.
    vim.cmd('wincmd p')
    vim.cmd('edit ' .. vim.fn.fnameescape(file))
  end
end

local function decide(verdict, comment)
  if not state.info then
    return
  end
  local extra = { 'decide', state.info.sessionId, verdict == 'approved' and '--approve' or '--reject' }
  if is_present(comment) then
    extra[#extra + 1] = '--comment'
    extra[#extra + 1] = comment
  end
  local code, out = cli.run(extra)
  vim.notify('rw-ai: ' .. vim.trim(out), code == 0 and vim.log.levels.INFO or vim.log.levels.ERROR)
  refresh()
end

-- Blast-radius diagram (WU-4.3): ASCII via `rw blast`, in a scratch split. The
-- image.nvim path (Kitty/WezTerm/sixel) can render the same data richer later.
local function show_diagram()
  if not state.info then
    return
  end
  local _, out = cli.run({ 'blast', state.info.sessionId })
  local buf = vim.api.nvim_create_buf(false, true)
  vim.bo[buf].buftype = 'nofile'
  vim.bo[buf].bufhidden = 'wipe'
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, vim.split(vim.trim(out), '\n', { plain = true }))
  vim.bo[buf].modifiable = false
  pcall(vim.api.nvim_buf_set_name, buf, 'rw-ai://blast')
  vim.cmd('botright split')
  vim.api.nvim_win_set_buf(0, buf)
end

local function set_keymaps(buf)
  local opts = { buffer = buf, silent = true, nowait = true }
  vim.keymap.set('n', '<CR>', open_file_under_cursor, opts)
  vim.keymap.set('n', 'd', show_diagram, opts)
  vim.keymap.set('n', 'a', function()
    decide('approved')
  end, opts)
  vim.keymap.set('n', 'r', function()
    decide('rejected')
  end, opts)
  vim.keymap.set('n', 'c', function()
    vim.ui.input({ prompt = 'Comment (approves): ' }, function(input)
      if input then
        decide('approved', input)
      end
    end)
  end, opts)
  vim.keymap.set('n', 'q', function()
    vim.cmd('close')
  end, opts)
end

function M.open(session_id)
  if not session_id or session_id == '' then
    vim.notify('rw-ai: usage :RwReview <session>', vim.log.levels.ERROR)
    return
  end
  local info, err = cli.run_json({ 'review-info', session_id, '--json' })
  if not info then
    vim.notify('rw-ai: review-info failed: ' .. (err or ''), vim.log.levels.ERROR)
    return
  end
  state.info = info
  local buf = ensure_buffer()
  vim.cmd('botright vsplit')
  vim.api.nvim_win_set_buf(0, buf)
  render()
  set_keymaps(buf)
end

return M
