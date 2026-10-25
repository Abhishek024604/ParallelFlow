// Brand assets: the ParallelFlow mark and the wordmark.

/**
 * The mark: just the cube, never in a tile or box. public/logo-mark.png (the cube cut out of
 * docs/logo2.png, transparent) is used as a mask filled with the text colour, so it is ink on light
 * pages and white on dark ones (dark mode, the black sign-in panel). The favicon (app/icon.png)
 * keeps its tile so it reads in any browser tab.
 */
export function LogoMark({ size = 32 }: { size?: number }) {
  const mask = 'url(/logo-mark.png) center / contain no-repeat';
  return (
    <span
      aria-hidden="true"
      className="inline-block shrink-0 bg-current text-text"
      style={{ width: size, height: size, mask, WebkitMask: mask }}
    />
  );
}

export function Logo({ size = 32, label = true }: { size?: number; label?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2.5">
      <LogoMark size={size} />
      {label && (
        <span className="text-[17px] font-semibold tracking-[-0.03em] text-text">ParallelFlow</span>
      )}
    </span>
  );
}

/** "Riya Sharma" → "RS". */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length >= 2 ? [parts[0]?.[0], parts.at(-1)?.[0]] : [parts[0]?.[0]];
  return letters.filter(Boolean).join('').toUpperCase() || '?';
}

export function Avatar({ name, size = 32 }: { name: string; size?: number }) {
  return (
    <span
      className="av inline-flex shrink-0 items-center justify-center rounded-full text-[12px]"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {initialsOf(name)}
    </span>
  );
}

/** First name for greetings: "Abhishek Shakya" → "Abhishek". */
export function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}
