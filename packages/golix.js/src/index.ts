import { HBInit, JoinError, joinRoom } from '@golix/headless';
import { decodeReplay, encodeReplay, trimReplay } from '@golix/replay';

export type { JoinRoomOptions, JoinedRoom, PlayerObject, RoomConfigObject, RoomObject, ScoresObject, TeamID } from '@golix/headless';
export type { Replay } from '@golix/replay';

export interface Golix {
  /** Resolves to HBInit, as haxball.js does: `require('golix.js')().then((HBInit) => …)`. */
  (): Promise<typeof HBInit>;
  HBInit: typeof HBInit;
  joinRoom: typeof joinRoom;
  JoinError: typeof JoinError;
  decodeReplay: typeof decodeReplay;
  encodeReplay: typeof encodeReplay;
  trimReplay: typeof trimReplay;
}

const golix: Golix = Object.assign(() => Promise.resolve(HBInit), { HBInit, joinRoom, JoinError, decodeReplay, encodeReplay, trimReplay });

export default golix;
