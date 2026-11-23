/** Matches recorded on their own, kept in this browser; the oldest go once there are more than KEPT_REPLAYS. */
export const KEPT_REPLAYS = 50;

export interface SavedReplayInfo {
  id: number;
  roomName: string;
  /** Milliseconds since the epoch at the end of the match. */
  savedAt: number;
  seconds: number;
}

export interface ReplayStore {
  add(info: Omit<SavedReplayInfo, 'id'>, data: Uint8Array<ArrayBuffer>): Promise<void>;
  /** Newest first. */
  list(): Promise<SavedReplayInfo[]>;
  get(id: number): Promise<Uint8Array<ArrayBuffer> | null>;
}

const DB_NAME = 'golix-replays';
const INFO = 'info';
const DATA = 'data';

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function open(factory: IDBFactory): Promise<IDBDatabase> {
  const request = factory.open(DB_NAME, 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore(INFO, { keyPath: 'id', autoIncrement: true });
    request.result.createObjectStore(DATA);
  };
  return done(request);
}

/** The info and the file live in separate stores, so listing never reads the files. */
export function indexedDbReplays(factory: IDBFactory): ReplayStore {
  let db: Promise<IDBDatabase> | null = null;
  const connect = () => (db ??= open(factory));
  return {
    async add(info, data) {
      const tx = (await connect()).transaction([INFO, DATA], 'readwrite');
      const infos = tx.objectStore(INFO);
      const added = infos.add(info);
      added.onsuccess = () => tx.objectStore(DATA).put(data, added.result);
      // Requests in one transaction run in order, so the keys include the one just added.
      const keys = infos.getAllKeys();
      keys.onsuccess = () => {
        for (const old of keys.result.slice(0, Math.max(keys.result.length - KEPT_REPLAYS, 0))) {
          infos.delete(old);
          tx.objectStore(DATA).delete(old);
        }
      };
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },
    async list() {
      const all = (await done((await connect()).transaction(INFO).objectStore(INFO).getAll())) as SavedReplayInfo[];
      return all.reverse();
    },
    async get(id) {
      const data = (await done((await connect()).transaction(DATA).objectStore(DATA).get(id))) as Uint8Array<ArrayBuffer> | undefined;
      return data ?? null;
    },
  };
}
