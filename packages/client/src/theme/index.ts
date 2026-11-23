import type { TeamColors } from '@golix/shared';

export interface TextStyle {
  weight: number;
  family: string;
  color: string;
  outline: string;
  outlineWidth: number;
}

export interface Theme {
  letterbox: string;
  /** Menu and chat palette, exposed to the stylesheet as CSS variables. */
  ui: {
    page: string;
    surface: string;
    surfaceAlt: string;
    sunken: string;
    hover: string;
    selected: string;
    line: string;
    text: string;
    heading: string;
    muted: string;
    accent: string;
    accentHover: string;
    secondary: string;
    secondaryHover: string;
    success: string;
    danger: string;
    mention: string;
    chat: string;
    chatInput: string;
    family: string;
  };
  teams: { red: TeamColors; blue: TeamColors };
  lines: { color: string; width: number; centerSpotRadius: number };
  grass: {
    /** World units per mowed band; bands run horizontally across the pitch. */
    bandHeight: number;
    bandLighten: number;
    surroundDarken: number;
  };
  hockey: {
    ice: string;
    iceBand: string;
    bandHeight: number;
    surround: string;
    boards: string;
    boardsWidth: number;
    centerLine: string;
    redLine: string;
    blueLine: string;
  };
  disc: { outline: string; outlineWidth: number };
  ball: { outline: string; outlineWidth: number };
  segment: { width: number };
  joint: { width: number };
  player: {
    outline: string;
    kickOutline: string;
    outlineWidth: number;
    /** Avatar font size as a fraction of the disc radius. */
    avatarScale: number;
    /** Largest width or height of the avatar's glyphs, in disc radii. */
    avatarMaxExtent: number;
    avatarFamily: string;
    avatarWeight: number;
    name: TextStyle;
    nameSize: number;
    nameGap: number;
  };
  local: { ring: string; ringWidth: number; ringGap: number; arrow: string; arrowOutline: string; arrowSize: number; arrowMargin: number };
  typing: { bubble: string; dot: string };
  hud: {
    panel: string;
    panelRadius: number;
    family: string;
    score: string;
    clock: string;
    /** Clock color in the last seconds before the time limit. */
    clockWarn: string;
    overtime: string;
    overlay: string;
    scoreSize: number;
    clockSize: number;
    banner: TextStyle;
    bannerSize: number;
    pausedSize: number;
  };
}

const sans = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Noto Sans', 'Helvetica Neue', Arial, sans-serif";

export const defaultTheme: Theme = {
  letterbox: '#2d4735',
  ui: {
    page: '#2d4735',
    surface: '#161a1e',
    surfaceAlt: '#1d2227',
    sunken: '#101316',
    hover: '#252b31',
    selected: '#3a3220',
    line: '#2c3339',
    text: '#e4e7e2',
    heading: '#f4f5f1',
    muted: '#8d9893',
    accent: '#e3a33b',
    accentHover: '#efb758',
    secondary: '#2a3138',
    secondaryHover: '#353e46',
    success: '#4caf6e',
    danger: '#e0564a',
    mention: '#e3a33b',
    chat: '16 19 22',
    chatInput: '#22282d',
    family: sans,
  },
  teams: {
    red: { angle: 0, textColor: 0xfff8ee, colors: [0xf0563c] },
    blue: { angle: 0, textColor: 0xf2f8ff, colors: [0x2a86d8] },
  },
  lines: { color: 'rgba(246, 242, 228, 0.82)', width: 2.5, centerSpotRadius: 3.5 },
  grass: { bandHeight: 34, bandLighten: 0.06, surroundDarken: 0.28 },
  hockey: {
    ice: '#e4eef2',
    iceBand: '#dbe7ec',
    bandHeight: 46,
    surround: '#2a3138',
    boards: '#f4d35e',
    boardsWidth: 4,
    centerLine: '#c94a5a',
    redLine: '#e8846f',
    blueLine: '#6fa4e8',
  },
  disc: { outline: '#0c1015', outlineWidth: 2 },
  ball: { outline: '#0c1015', outlineWidth: 2.5 },
  segment: { width: 3 },
  joint: { width: 2 },
  player: {
    outline: '#0c1015',
    kickOutline: '#fff4c9',
    outlineWidth: 2,
    // The original draws avatars at 34px on a 64px disc pattern.
    avatarScale: 34 / 32,
    avatarMaxExtent: 1.5,
    avatarFamily: sans,
    avatarWeight: 900,
    name: { weight: 700, family: sans, color: '#f7f7f2', outline: 'rgba(8, 10, 14, 0.75)', outlineWidth: 3 },
    nameSize: 10,
    nameGap: 12,
  },
  local: {
    ring: 'rgba(255, 244, 201, 0.55)',
    ringWidth: 2,
    ringGap: 5,
    arrow: '#fff4c9',
    arrowOutline: '#0c1015',
    arrowSize: 14,
    arrowMargin: 22,
  },
  typing: { bubble: 'rgba(16, 19, 22, 0.9)', dot: '#e4e7e2' },
  hud: {
    panel: 'rgba(16, 19, 22, 0.88)',
    panelRadius: 8,
    family: sans,
    score: '#f7f7f2',
    clock: '#e4e7e2',
    clockWarn: '#f2786a',
    overtime: '#e3a33b',
    overlay: 'rgba(0, 0, 0, 0.35)',
    scoreSize: 22,
    clockSize: 17,
    banner: { weight: 800, family: sans, color: '#f7f7f2', outline: '#0c1015', outlineWidth: 6 },
    bannerSize: 64,
    pausedSize: 48,
  },
};
