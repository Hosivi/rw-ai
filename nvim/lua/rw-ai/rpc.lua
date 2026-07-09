-- RPC client for the rw-ai observer daemon (WU-3.1).
-- Connects to the daemon's pipe/socket via libuv, frames requests, and dispatches
-- decoded server messages. All Neovim API access happens inside vim.schedule,
-- since libuv read callbacks run outside the main loop.

local frames = require('rw-ai.frames')

local uv = vim.uv or vim.loop

local M = {}

-- Connect to `address`. `handlers` may provide:
--   on_connect(client)  -- fired once the socket is up (subscribe from here)
--   on_snapshot(states, rev)
--   on_update(states, rev)
--   on_error(msg)
--   on_close()
-- Returns a client handle: { send, subscribe, get, close, is_connected }.
function M.connect(address, handlers)
  handlers = handlers or {}
  local pipe = uv.new_pipe(false)
  local decoder = frames.new_decoder()
  local connected = false
  local closed = false

  local client = {}

  local function fire(name, ...)
    local cb = handlers[name]
    if cb then
      local args = { ... }
      vim.schedule(function()
        cb(unpack(args))
      end)
    end
  end

  local function dispatch(msg)
    if type(msg) ~= 'table' then
      return
    end
    if msg.type == 'snapshot' then
      fire('on_snapshot', msg.states or {}, msg.rev)
    elseif msg.type == 'update' then
      fire('on_update', msg.states or {}, msg.rev)
    end
  end

  pipe:connect(address, function(err)
    if err then
      fire('on_error', err)
      return
    end
    connected = true
    fire('on_connect', client)
    pipe:read_start(function(read_err, chunk)
      if read_err then
        fire('on_error', read_err)
        return
      end
      if not chunk then
        fire('on_close')
        client.close()
        return
      end
      for _, msg in ipairs(decoder.push(chunk)) do
        dispatch(msg)
      end
    end)
  end)

  function client.send(value)
    if not closed and connected then
      pipe:write(frames.encode(value))
    end
  end

  function client.subscribe()
    client.send({ type = 'subscribe' })
  end

  function client.get()
    client.send({ type = 'get' })
  end

  function client.is_connected()
    return connected and not closed
  end

  function client.close()
    if closed then
      return
    end
    closed = true
    if not pipe:is_closing() then
      pipe:close()
    end
  end

  return client
end

return M
