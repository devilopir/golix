import { css } from '../render/color.ts';
import type { Theme } from '../theme/index.ts';

/** Exposes the theme to the stylesheet so menus and the pitch share one palette. */
export function applyThemeVariables(el: HTMLElement, theme: Theme): void {
  const { ui } = theme;
  const vars: Record<string, string> = {
    '--dk-bg': ui.page,
    '--dk-surface': ui.surface,
    '--dk-panel': ui.surfaceAlt,
    '--dk-sunken': ui.sunken,
    '--dk-hover': ui.hover,
    '--dk-selected': ui.selected,
    '--dk-line': ui.line,
    '--dk-text': ui.text,
    '--dk-heading': ui.heading,
    '--dk-muted': ui.muted,
    '--dk-accent': ui.accent,
    '--dk-accent-hover': ui.accentHover,
    '--dk-secondary': ui.secondary,
    '--dk-secondary-hover': ui.secondaryHover,
    '--dk-success': ui.success,
    '--dk-danger': ui.danger,
    '--dk-highlight': ui.mention,
    '--dk-chat-rgb': ui.chat,
    '--dk-chat-input': ui.chatInput,
    '--dk-overlay': theme.hud.overlay,
    '--dk-red': css(theme.teams.red.colors[0]),
    '--dk-blue': css(theme.teams.blue.colors[0]),
    '--dk-font': ui.family,
  };
  for (const [name, value] of Object.entries(vars)) el.style.setProperty(name, value);
}
