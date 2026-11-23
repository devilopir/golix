// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReplayStore, SavedReplayInfo } from '../../src/net/replayStore.ts';
import { openReplaysDialog } from '../../src/ui/replaysDialog.ts';
import { click } from './fakes.ts';

class MemoryReplays implements ReplayStore {
  private readonly saved: { info: SavedReplayInfo; data: Uint8Array<ArrayBuffer> }[] = [];

  async add(info: Omit<SavedReplayInfo, 'id'>, data: Uint8Array<ArrayBuffer>): Promise<void> {
    this.saved.push({ info: { ...info, id: this.saved.length + 1 }, data });
  }

  async list(): Promise<SavedReplayInfo[]> {
    return this.saved.map((s) => s.info).reverse();
  }

  async get(id: number): Promise<Uint8Array<ArrayBuffer> | null> {
    return this.saved.find((s) => s.info.id === id)?.data ?? null;
  }
}

describe('replays dialog', () => {
  let host: HTMLElement;
  const open = vi.fn<(load: () => Promise<ArrayBuffer>) => void>();
  const download = vi.fn<(name: string, data: Uint8Array<ArrayBuffer>) => void>();

  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    open.mockReset();
    download.mockReset();
  });

  afterEach(() => host.remove());

  it('lists saved matches newest first, to watch or download, and opens files too', async () => {
    const store = new MemoryReplays();
    await store.add({ roomName: 'Old', savedAt: Date.UTC(2026, 10, 1, 18, 0), seconds: 200 }, new Uint8Array([1]));
    await store.add({ roomName: 'Friday', savedAt: Date.UTC(2026, 10, 9, 7, 5), seconds: 185 }, new Uint8Array([2, 3]));
    openReplaysDialog(host, { store, open, download });
    await vi.waitFor(() => expect(host.querySelectorAll('.dk-saved-replays li')).toHaveLength(2));
    const rows = [...host.querySelectorAll('.dk-saved-replays li')];
    expect(rows.map((r) => r.querySelector('.dk-saved-replay-name')!.textContent)).toEqual(['Friday', 'Old']);
    expect(rows[0].querySelector('.dk-saved-replay-meta')!.textContent).toContain('03:05');
    expect(host.querySelector<HTMLInputElement>('input[type=file]')!.accept).toBe('.glx');

    click(rows[0] as HTMLElement, 'Download');
    await vi.waitFor(() => expect(download).toHaveBeenCalledOnce());
    expect(download.mock.calls[0][1]).toEqual(new Uint8Array([2, 3]));
    click(rows[1] as HTMLElement, 'Watch');
    expect(host.querySelector('.dk-dialog')).toBeNull();
    expect(new Uint8Array(await open.mock.calls[0][0]())).toEqual(new Uint8Array([1]));
  });

  it('says how saving works when nothing is saved, and when the browser keeps nothing', async () => {
    openReplaysDialog(host, { store: new MemoryReplays(), open, download });
    await vi.waitFor(() => expect(host.textContent).toContain('Matches you play are saved here'));
    click(host, 'Close');
    openReplaysDialog(host, { store: null, open, download });
    expect(host.textContent).toContain('This browser does not keep replays');
  });
});
