-- Length-prefixed JSON framing — the Lua mirror of src/daemon/frames.ts.
-- A frame is a 4-byte big-endian uint32 byte length, then that many UTF-8 bytes
-- of JSON. LuaJIT (what Neovim embeds) has no string.pack, so the header is
-- packed/unpacked by hand.

local M = {}

local function u32_be(n)
  return string.char(
    math.floor(n / 16777216) % 256,
    math.floor(n / 65536) % 256,
    math.floor(n / 256) % 256,
    n % 256
  )
end

function M.encode(value)
  local json = vim.json.encode(value)
  return u32_be(#json) .. json
end

-- Stateful decoder: push raw chunks, get back every complete decoded value.
-- A partial trailing frame is retained for the next push. A corrupt (non-JSON)
-- payload is skipped without desyncing the stream (the length prefix keeps it
-- aligned).
function M.new_decoder()
  local buffer = ''
  return {
    push = function(chunk)
      buffer = buffer .. chunk
      local out = {}
      while #buffer >= 4 do
        local a, b, c, d = buffer:byte(1, 4)
        local length = ((a * 256 + b) * 256 + c) * 256 + d
        if #buffer < 4 + length then
          break
        end
        local payload = buffer:sub(5, 4 + length)
        buffer = buffer:sub(5 + length)
        local ok, decoded = pcall(vim.json.decode, payload)
        if ok then
          out[#out + 1] = decoded
        end
      end
      return out
    end,
  }
end

return M
