import { Room, type Schedule } from '@golix/room';
import { hostOnLobby, type LobbyHost, type LobbyHostOptions } from '@golix/room/host';
import { localConnect, type Connect } from './transport.ts';

export interface HostOptions extends LobbyHostOptions {
  password: string;
  /** Drives the room's tick loop; defaults to the page's own timers. */
  schedule?: Schedule;
}

export interface HostedRoom {
  readonly id: string;
  readonly room: Room;
  /** Joins the host's own client to the room in-process. */
  readonly connect: Connect;
  /** Asks joiners for a captcha where the lobby verifies them, else tightens the join limit; true when a captcha is asked. */
  setRequireRecaptcha(required: boolean): boolean;
  /** Ends the room for everyone and takes it off the room list. */
  close(): void;
}

/** Runs the room in this browser, registers it with the lobby and accepts joiners over WebRTC or the lobby relay. */
export async function hostRoom(options: HostOptions): Promise<HostedRoom> {
  let lobby: LobbyHost | null = null;
  const room = new Room({
    name: options.request.name,
    maxPlayers: options.request.maxPlayers,
    password: options.password,
    hooks: { onEvent: () => lobby?.update() },
  });
  lobby = await hostOnLobby(room, options);
  room.setCaptchaAvailable(lobby.captcha);
  room.start(options.schedule);
  const { id, close } = lobby;
  return {
    id,
    room,
    connect: localConnect(room),
    setRequireRecaptcha: (required) => {
      room.setRequireCaptcha(required);
      lobby.update();
      return room.captchaRequired;
    },
    close: () => {
      room.close();
      close();
    },
  };
}
