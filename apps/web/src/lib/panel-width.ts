// Width rules for the arena's resizable right panel (pure, so they can be unit tested).

export const PANEL_DEFAULT_WIDTH = 340;
export const PANEL_MIN_WIDTH = 300;

/** The widest the panel may get: 70% of the window, never below the minimum. */
export function panelMaxWidth(viewport: number): number {
  return Math.max(PANEL_MIN_WIDTH, Math.round(viewport * 0.7));
}

/** Wide mode: half the window. */
export function panelWideWidth(viewport: number): number {
  return Math.max(PANEL_MIN_WIDTH, Math.round(viewport * 0.5));
}

export function clampPanelWidth(width: number, viewport: number): number {
  if (!Number.isFinite(width)) return PANEL_DEFAULT_WIDTH;
  return Math.min(panelMaxWidth(viewport), Math.max(PANEL_MIN_WIDTH, Math.round(width)));
}

/** Whether the panel is in wide mode (within a few pixels of half the window, or wider). */
export function isPanelWide(width: number, viewport: number): boolean {
  return width >= panelWideWidth(viewport) - 8;
}
