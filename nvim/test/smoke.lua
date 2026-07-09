-- Headless smoke test for the pure plugin pieces (frames + status render).
-- These need no running daemon. Run from the repo root:
--
--   nvim --headless -u NONE -c "set rtp+=nvim" -c "luafile nvim/test/smoke.lua" -c "qa!"
--
-- Exits non-zero if any check fails.

local ok_all = true
local function check(name, cond)
  if cond then
    print('ok   - ' .. name)
  else
    ok_all = false
    print('FAIL - ' .. name)
  end
end

local frames = require('rw-ai.frames')
local status = require('rw-ai.status')

-- frames: round-trip a single value
local dec = frames.new_decoder()
local out = dec.push(frames.encode({ type = 'snapshot', rev = 1, states = {} }))
check('frames round-trip single', #out == 1 and out[1].type == 'snapshot' and out[1].rev == 1)

-- frames: several frames in one chunk
local dec_multi = frames.new_decoder()
local chunk = frames.encode({ a = 1 }) .. frames.encode({ b = 2 })
local multi = dec_multi.push(chunk)
check('frames two-in-one-chunk', #multi == 2 and multi[1].a == 1 and multi[2].b == 2)

-- frames: a frame split across chunks reassembles
local dec_split = frames.new_decoder()
local framed = frames.encode({ hello = 'world' })
local first = dec_split.push(framed:sub(1, 3))
local rest = dec_split.push(framed:sub(4))
check('frames split-then-complete', #first == 0 and #rest == 1 and rest[1].hello == 'world')

-- status render: empty
local empty = status.render({})
check('render empty', empty[1]:find('no active sessions') ~= nil)

-- status render: one session, all fields
local lines = status.render({
  {
    sessionId = 's1',
    branch = 'feat/s1',
    light = 'red',
    claim = { status = 'claimed', expired = false },
    phase = 'blocked',
    git = { dirty = true, ahead = 2, behind = 0 },
  },
})
local body = table.concat(lines, '\n')
check('render shows session id', body:find('s1') ~= nil)
check('render shows claim held', body:find('held') ~= nil)
check('render shows git ahead+dirty', body:find('%+2') ~= nil and body:find('dirty') ~= nil)
check('render shows phase', body:find('blocked') ~= nil)

if ok_all then
  print('ALL PASS')
else
  vim.cmd('cquit 1')
end
