import { MAX_MESSAGE_BYTES } from '@golix/shared';
import { describe, expect, it } from 'vitest';
import { chunkReader, sendChunked } from '../src/channel.ts';

describe('sendChunked', () => {
  it('does not throw when the channel closes between the state check and the send', () => {
    const channel = {
      readyState: 'open',
      send: () => {
        throw new Error('DataChannel is closed');
      },
    } as unknown as RTCDataChannel;
    expect(() => sendChunked(channel, new Uint8Array(10))).not.toThrow();
  });
});

describe('chunkReader', () => {
  /** Collects what sendChunked puts on the wire, as the data channel would deliver it. */
  const wire = (data: Uint8Array<ArrayBuffer>): MessageEvent[] => {
    const sent: MessageEvent[] = [];
    const channel = { readyState: 'open', send: (chunk: Uint8Array) => sent.push({ data: chunk.slice().buffer } as MessageEvent) } as unknown as RTCDataChannel;
    sendChunked(channel, data);
    return sent;
  };

  it('reassembles chunked messages and drops one over the size limit without buffering it', () => {
    const delivered: Uint8Array[] = [];
    const read = chunkReader((data) => delivered.push(data));
    const small = Uint8Array.from({ length: 200_000 }, (_, i) => i % 251);
    for (const e of wire(small)) read(e);
    expect(delivered).toEqual([small]);

    const more = new Uint8Array(64 * 1024);
    more[0] = 1;
    for (let sent = 0; sent <= MAX_MESSAGE_BYTES; sent += more.length - 1) read({ data: more.buffer } as MessageEvent);
    read({ data: new Uint8Array([0, 7]).buffer } as MessageEvent);
    for (const e of wire(new Uint8Array([1, 2, 3]))) read(e);
    expect(delivered).toEqual([small, new Uint8Array([1, 2, 3])]);
  });
});
