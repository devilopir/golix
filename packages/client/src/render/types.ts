import type { GameState, RoomState } from '@golix/shared';

export interface ViewSettings {
  /** -1 dynamic, 0 restricted 840x410, 1 to 7 fixed zoom 1x to 2.5x. */
  viewMode: number;
  resolutionScale: number;
  showNames: boolean;
  showAvatars: boolean;
  /** False draws every team with the theme's default colors. */
  customTeamColors: boolean;
  showTypingIndicators: boolean;
  clampCamera: boolean;
  /** Pixels at the bottom covered by the chat; the camera centres on the area above them. */
  bottomInset: number;
}

export interface RenderFrame {
  prev: GameState;
  curr: GameState;
  /** 0 = prev, 1 = curr. */
  alpha: number;
  room: RoomState;
  localPlayerId: number | null;
  view: ViewSettings;
  typingPlayerIds: ReadonlySet<number>;
  /** The room menu covers the field; HUD labels that would sit under it are left out. */
  menuOpen: boolean;
}
