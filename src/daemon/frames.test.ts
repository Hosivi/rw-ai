import { describe, expect, it } from 'vitest';
import { createFrameDecoder, encodeFrame } from './frames.js';

describe('encodeFrame / createFrameDecoder', () => {
  it('round-trips a single object', () => {
    const decoder = createFrameDecoder();
    const frames = decoder.push(encodeFrame({ hello: 'world', n: 42 }));
    expect(frames).toEqual([{ hello: 'world', n: 42 }]);
  });

  it('preserves unicode payloads byte-for-byte', () => {
    const decoder = createFrameDecoder();
    const value = { detail: 'café ✅ 汉字' };
    expect(decoder.push(encodeFrame(value))).toEqual([value]);
  });

  it('decodes several frames delivered in one chunk', () => {
    const decoder = createFrameDecoder();
    const chunk = Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: 2 }), encodeFrame({ c: 3 })]);
    expect(decoder.push(chunk)).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it('reassembles a frame split across chunks', () => {
    const decoder = createFrameDecoder();
    const framed = encodeFrame({ big: 'x'.repeat(1000) });
    const mid = 7; // split inside the header on purpose
    expect(decoder.push(framed.subarray(0, mid))).toEqual([]);
    expect(decoder.push(framed.subarray(mid, 20))).toEqual([]);
    expect(decoder.push(framed.subarray(20))).toEqual([{ big: 'x'.repeat(1000) }]);
  });

  it('holds a trailing partial frame until the rest arrives', () => {
    const decoder = createFrameDecoder();
    const first = encodeFrame({ a: 1 });
    const second = encodeFrame({ b: 2 });
    const chunk = Buffer.concat([first, second.subarray(0, 3)]);
    expect(decoder.push(chunk)).toEqual([{ a: 1 }]);
    expect(decoder.push(second.subarray(3))).toEqual([{ b: 2 }]);
  });

  it('rejects a frame whose declared length exceeds the cap (anti-OOM guard)', () => {
    const decoder = createFrameDecoder(16);
    const header = Buffer.alloc(4);
    header.writeUInt32BE(1_000_000, 0);
    expect(() => decoder.push(header)).toThrow(/frame too large/i);
  });

  it('throws on a corrupt (non-JSON) payload', () => {
    const decoder = createFrameDecoder();
    const header = Buffer.alloc(4);
    header.writeUInt32BE(5, 0);
    expect(() => decoder.push(Buffer.concat([header, Buffer.from('nojso', 'utf8')]))).toThrow();
  });
});
