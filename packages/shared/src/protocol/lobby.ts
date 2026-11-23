export interface RoomLocation {
  /** Lowercase ISO 3166-1 alpha-2 code, empty when the creator has no location. */
  country: string;
  lat: number;
  lon: number;
}

export interface CreateRoomRequest extends RoomLocation {
  name: string;
  maxPlayers: number;
  public: boolean;
}

/** One row of GET /rooms. */
export interface RoomListing extends RoomLocation {
  id: string;
  name: string;
  players: number;
  maxPlayers: number;
  hasPassword: boolean;
  /** Joiners must solve a captcha. */
  captcha: boolean;
  /** The room's script listens to the action keys. */
  actionKeys: boolean;
}

/** What a host tells the lobby about its room for the list; hosts older than `captcha`, `actionKeys`, `name` and `maxPlayers` leave them out. */
export interface ListedState {
  name: string;
  maxPlayers: number;
  players: number;
  hasPassword: boolean;
  captcha: boolean;
  actionKeys: boolean;
}

/** GET /lobby. */
export interface LobbyInfo {
  /** The visitor's lowercase ISO 3166-1 alpha-2 code as Cloudflare saw it, empty when unknown. */
  country: string;
  /** Server announcement shown above the room list, empty for none. */
  notice: string;
  /** Turnstile site key for rooms that ask joiners for a captcha; empty when the lobby has none. */
  captchaSiteKey: string;
}

/** The fields of RTCIceCandidateInit that are relayed. */
export interface IceCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
}

/** An RTCIceServer as the lobby hands it out; TURN entries carry short-lived credentials. */
export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/** JSON text frames a host sends on /host; binary frames are a 4-byte big-endian peer id and the game bytes for it. */
export type HostMessage =
  /** The room id is derived from `secret`, so registering again with it brings the same room back after a lobby restart. */
  /** `token` is a room token from POST /token, needed the first time a room id registers with a lobby that asks for one. */
  | ({ type: 'register'; secret: string; token?: string } & Omit<ListedState, 'players'> & CreateRoomRequest)
  | ({ type: 'update' } & ListedState)
  | { type: 'answer'; peer: number; sdp: string }
  | { type: 'candidate'; peer: number; candidate: IceCandidate }
  /** Ends a relayed peer's connection. */
  | { type: 'close'; peer: number };

/** `conn` is the joiner's network address as the server saw it; `captcha` whether the lobby verified a captcha token with the connection. */
export type ServerToHost =
  /** `captcha`: the lobby can verify captchas, so the room may ask joiners for one. */
  /** `verifyKey` is the base64url P-256 point the lobby signs verified identities with. */
  | { type: 'registered'; id: string; captcha: boolean; verifyKey: string }
  /** Auths banned from every room by the lobby's operators; sent after registering and whenever the list changes. */
  | { type: 'bans'; auths: string[] }
  | { type: 'offer'; peer: number; conn: string; captcha: boolean; sdp: string; iceServers: IceServer[] }
  | { type: 'candidate'; peer: number; candidate: IceCandidate }
  /** From now on the peer's game bytes come and go through this socket; a known `token` resumes a relayed peer. */
  | { type: 'relay'; peer: number; conn: string; captcha: boolean; token: string }
  | { type: 'leave'; peer: number };

/** Close code of a relayed joiner's socket when its host lost the control socket but may register again. */
export const HOST_AWAY_CLOSE = 4001;

/** JSON text frames a joiner sends on /room/<id>; binary frames are game bytes once relayed. */
export type JoinerMessage = { type: 'offer'; sdp: string } | { type: 'candidate'; candidate: IceCandidate } | { type: 'relay'; token: string };

export type ServerToJoiner =
  /** Sent first when a browser hosts the room: offer a data channel to it. */
  | { type: 'webrtc'; iceServers: IceServer[] }
  | { type: 'answer'; sdp: string }
  | { type: 'candidate'; candidate: IceCandidate }
  /** Sent first when the room runs on the server: game bytes go through this socket. */
  | { type: 'relay' }
  /** The host's control socket closed without a new registration taking its place. */
  | { type: 'hostLost' }
  /** Sent first when the joiner solved the room's captcha: proof for its auth that later joins carry instead of a captcha. */
  | { type: 'verified'; value: string }
  /** The host's control socket just closed; it may still register again, so a joiner on a data channel waits for its game bytes to stop. */
  | { type: 'hostAway' };

/** What the lobby signs to vouch that `auth` solved a captcha, valid until `expires` (unix seconds). */
export function verifiedMessage(auth: string, expires: number): string {
  return `golix-verified.${auth}.${expires}`;
}
