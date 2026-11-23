import { createServer, type GolixServer } from '@golix/server';
import type { ServerToHost } from '@golix/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { joinConnect, type ClientTransport } from '../../src/net/transport.ts';

/** A peer connection whose data channel the test opens by hand, with a settable connection state. */
function controlledPeerConnection() {
  const channel = { binaryType: 'blob', readyState: 'connecting', onopen: null as (() => void) | null, onclose: null as (() => void) | null, close() {}, send() {} };
  const pc = {
    localDescription: null as { sdp: string } | null,
    connectionState: 'new' as RTCPeerConnectionState,
    onconnectionstatechange: null as (() => void) | null,
    createDataChannel: () => channel,
    setLocalDescription: async () => {
      pc.localDescription = { sdp: 'v=0 controlled' };
    },
    setRemoteDescription: async () => {},
    addIceCandidate: async () => {},
    close() {},
    open() {
      channel.readyState = 'open';
      channel.onopen!();
    },
    setState(state: RTCPeerConnectionState) {
      pc.connectionState = state;
      pc.onconnectionstatechange!();
    },
  };
  return pc;
}

/** A host on the lobby's control socket that answers nothing. */
async function rawHost(lobby: string) {
  const ws = new WebSocket(`${lobby}/host`);
  const messages: ServerToHost[] = [];
  ws.onmessage = (e) => messages.push(JSON.parse(e.data as string) as ServerToHost);
  await new Promise((resolve) => (ws.onopen = resolve));
  ws.send(JSON.stringify({ type: 'register', name: 'Raw', maxPlayers: 4, public: true, country: '', lat: 0, lon: 0, hasPassword: false, secret: 'raw-host-secret-012345' }));
  await waitFor(() => messages.length > 0);
  const registered = messages.shift()!;
  if (registered.type !== 'registered') throw new Error(`unexpected ${registered.type}`);
  return { ws, id: registered.id, messages };
}

const relayOf = (messages: ServerToHost[]) => messages.find((m): m is Extract<ServerToHost, { type: 'relay' }> => m.type === 'relay');

function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = performance.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (cond()) resolve();
      else if (performance.now() - start > timeoutMs) reject(new Error('timed out'));
      else setTimeout(poll, 10);
    };
    poll();
  });
}

let server: GolixServer | null = null;
const transports: ClientTransport[] = [];

afterEach(async () => {
  for (const t of transports.splice(0)) t.close();
  await server?.close();
  server = null;
});

async function p2pJoiner() {
  server = await createServer({ port: 0, host: '127.0.0.1', hostGraceMs: 0 });
  const lobby = `ws://127.0.0.1:${server.port}`;
  const host = await rawHost(lobby);
  const pc = controlledPeerConnection();
  const closes: (string | undefined)[] = [];
  const transport = joinConnect({ createPeerConnection: () => pc as unknown as RTCPeerConnection })(`${lobby}/room/${host.id}`, { message: () => {}, close: (reason) => closes.push(reason) });
  transports.push(transport);
  await waitFor(() => host.messages.some((m) => m.type === 'offer'));
  pc.open();
  expect(transport.path).toBe('p2p');
  return { host, pc, closes };
}

describe('joiner transport', () => {
  it('learns from the lobby at once when the host of its data channel drops off', async () => {
    const { host, closes } = await p2pJoiner();
    await new Promise((r) => setTimeout(r, 50));
    expect(closes).toEqual([]);
    const at = performance.now();
    host.ws.close();
    await waitFor(() => closes.length > 0, 1000);
    expect(closes).toEqual(['host']);
    expect(performance.now() - at).toBeLessThan(500);
  });

  it('reopens its lobby socket after a lobby restart and still hears when the host drops off', { timeout: 10_000 }, async () => {
    const { host, closes } = await p2pJoiner();
    const { port } = server!;
    await server!.close();
    server = await createServer({ port, host: '127.0.0.1', hostGraceMs: 0 });
    await new Promise((r) => setTimeout(r, 1500));
    const back = await rawHost(`ws://127.0.0.1:${port}`);
    expect(back.id).toBe(host.id);
    await new Promise((r) => setTimeout(r, 2500));
    expect(closes).toEqual([]);
    back.ws.close();
    await waitFor(() => closes.length > 0, 1000);
    expect(closes).toEqual(['host']);
  });

  it('resumes its relay with the same token when the host comes back within the lobby grace period', { timeout: 10_000 }, async () => {
    server = await createServer({ port: 0, host: '127.0.0.1', hostGraceMs: 5000 });
    const lobby = `ws://127.0.0.1:${server.port}`;
    const host = await rawHost(lobby);
    const closes: (string | undefined)[] = [];
    const transport = joinConnect({ createPeerConnection: () => controlledPeerConnection() as unknown as RTCPeerConnection, iceTimeoutMs: 50 })(`${lobby}/room/${host.id}`, { message: () => {}, close: (reason) => closes.push(reason) });
    transports.push(transport);
    await waitFor(() => relayOf(host.messages) !== undefined);
    const { token } = relayOf(host.messages)!;

    host.ws.close();
    await waitFor(() => transport.resuming, 1000);
    await new Promise((r) => setTimeout(r, 1000));
    const back = await rawHost(lobby);
    await waitFor(() => relayOf(back.messages) !== undefined, 3000);
    expect(relayOf(back.messages)!.token).toBe(token);
    expect(transport.resuming).toBe(false);
    expect(closes).toEqual([]);
  });

  it('gives the host up when ICE fails, or stays disconnected for two seconds', async () => {
    const failed = await p2pJoiner();
    failed.pc.setState('failed');
    expect(failed.closes).toEqual(['host']);
    await server!.close();

    const blip = await p2pJoiner();
    blip.pc.setState('disconnected');
    await new Promise((r) => setTimeout(r, 1000));
    blip.pc.setState('connected');
    await new Promise((r) => setTimeout(r, 1500));
    expect(blip.closes).toEqual([]);
    blip.pc.setState('disconnected');
    await waitFor(() => blip.closes.length > 0, 3000);
    expect(blip.closes).toEqual(['host']);
  });
});
