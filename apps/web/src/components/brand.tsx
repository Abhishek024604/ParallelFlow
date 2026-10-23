// Brand assets: the ParallelFlow mark (public/logo.png, from docs/logo2.png) and the wordmark.

/**
 * The logo tile: a white box on a black rounded square. It reads on both canvases: a solid tile on
 * white, and on black the tile melts into the page and the box stands alone.
 */
export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    // A static brand image at a fixed size (like google.svg); next/image adds nothing here.
    <img
      src="/logo.png"
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded-[22%]"
      style={{ width: size, height: size }}
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
