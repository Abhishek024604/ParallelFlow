import { describe, expect, it } from 'vitest';
import { clampPanelWidth, isPanelWide, panelWideWidth } from './panel-width';

describe('arena panel width', () => {
  it('clamps between the minimum and 70% of the window', () => {
    expect(clampPanelWidth(100, 1400)).toBe(300);
    expect(clampPanelWidth(500, 1400)).toBe(500);
    expect(clampPanelWidth(5000, 1400)).toBe(980);
    expect(clampPanelWidth(Number.NaN, 1400)).toBe(340);
  });

  it('treats half the window as wide mode', () => {
    expect(panelWideWidth(1400)).toBe(700);
    expect(isPanelWide(700, 1400)).toBe(true);
    expect(isPanelWide(340, 1400)).toBe(false);
  });
});
