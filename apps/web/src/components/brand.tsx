// Brand assets (brand template §6), drawn with tokens only.

/** The logo tile: an "S" drawn as a swan's neck, cream on ink, with an orange point. */
export function LogoMark({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="9" fill="var(--ink)" />
      <path
        d="M19.5 9.6c-1.2-1.3-4.6-1.6-5.9.4-1.5 2.3.8 4 2.6 5.1 2 1.2 3.9 2.7 2.4 5.2-1.4 2.2-5.1 2-6.6.3"
        fill="none"
        stroke="var(--on-ink)"
        strokeWidth="2.1"
        strokeLinecap="round"
      />
      <circle cx="21.3" cy="9.4" r="1.6" fill="var(--acc)" />
    </svg>
  );
}

export function Logo({ size = 32, label = true }: { size?: number; label?: boolean }) {
  return (
    <span className="inline-flex items-center gap-3">
      <LogoMark size={size} />
      {label && <span className="text-[17px] font-bold tracking-[-0.02em] text-text">Saras</span>}
    </span>
  );
}

/** The swan on calm water. One per screen, on onboarding and empty states only. */
export function Illustration({ width = 168 }: { width?: number }) {
  return (
    <svg
      viewBox="0 0 168 112"
      width={width}
      height={(width * 112) / 168}
      role="img"
      aria-label="A swan resting on calm water beside reeds"
    >
      <circle cx="128" cy="30" r="13" fill="var(--acc)" opacity=".85" />
      <path
        d="M14 90h140 M34 98h96 M56 105h52"
        stroke="var(--line2)"
        strokeWidth="1.6"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M24 90c0-16 2-28 6-38 M33 90c-1-12 0-22 3-30 M18 90c1-10 0-16-3-22"
        stroke="var(--sage)"
        strokeWidth="1.8"
        strokeLinecap="round"
        fill="none"
      />
      <ellipse cx="30" cy="50" rx="2.6" ry="7" fill="var(--sage)" transform="rotate(14 30 50)" />
      <path
        d="M58 86c-5-14 8-24 27-22 10 1 18 6 29 3-4 13-17 21-35 21-9 0-17-1-21-2z"
        fill="var(--panel)"
        stroke="var(--ink)"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path
        d="M62 72c-7-10-7-25 2-31 6-4 15-1 15 6"
        fill="none"
        stroke="var(--ink)"
        strokeWidth="2.4"
        strokeLinecap="round"
      />
      <path d="M78.5 46.5l7 2.2-7 2" fill="var(--acc)" />
      <circle cx="73.5" cy="44.5" r="1.4" fill="var(--ink)" />
      <path
        d="M76 72c8-6 19-6 27-2"
        fill="none"
        stroke="var(--ink)"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
      <path d="M100 22l1.4 4.3 4.2 1.9-4.2 1.9-1.4 4.3-1.4-4.3-4.2-1.9 4.2-1.9z" fill="var(--ai)" />
    </svg>
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
