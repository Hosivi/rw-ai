// Length-prefixed JSON framing for the observer daemon's pipe/socket transport:
// a 4-byte big-endian uint32 byte length, then that many UTF-8 bytes of JSON.
// A stream carries many frames; the decoder buffers partial reads and yields
// whole values only.

const HEADER_BYTES = 4;
// 8 MiB default cap: a status snapshot is tiny, so any larger declared length is
// a corrupt/hostile stream — reject it rather than buffer unboundedly (anti-OOM).
const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;

export const encodeFrame = (value: unknown): Buffer => {
  const json = Buffer.from(JSON.stringify(value), 'utf8');
  const header = Buffer.allocUnsafe(HEADER_BYTES);
  header.writeUInt32BE(json.length, 0);
  return Buffer.concat([header, json]);
};

export type FrameDecoder = {
  // Feed raw bytes; returns every complete frame that became available. A partial
  // trailing frame is retained for the next push. Throws on an over-cap length or
  // a non-JSON payload — the caller (the server) drops that connection.
  readonly push: (chunk: Buffer) => unknown[];
};

export const createFrameDecoder = (
  maxFrameBytes: number = DEFAULT_MAX_FRAME_BYTES,
): FrameDecoder => {
  // Annotated as the wide Buffer type: Buffer.alloc yields Buffer<ArrayBuffer>
  // while Buffer.concat yields Buffer<ArrayBufferLike>, and we reassign with both.
  let buffered: Buffer = Buffer.alloc(0);
  return {
    push(chunk) {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
      const out: unknown[] = [];
      while (buffered.length >= HEADER_BYTES) {
        const length = buffered.readUInt32BE(0);
        if (length > maxFrameBytes) {
          throw new Error(`frame too large: ${length} bytes exceeds cap ${maxFrameBytes}`);
        }
        if (buffered.length < HEADER_BYTES + length) {
          break; // frame not fully arrived yet
        }
        const payload = buffered.subarray(HEADER_BYTES, HEADER_BYTES + length);
        out.push(JSON.parse(payload.toString('utf8')));
        buffered = buffered.subarray(HEADER_BYTES + length);
      }
      return out;
    },
  };
};
