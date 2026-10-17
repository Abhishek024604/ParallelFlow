// Loading placeholders (loading.tsx and Suspense fallbacks): shown the moment a navigation starts,
// while the server fetches the page's data. Grey bars only; no text to read.

function Bar({ className }: { className: string }) {
  return <span aria-hidden="true" className={`block animate-pulse rounded bg-line ${className}`} />;
}

/** The sidebar's frame (arena or private) while its list loads. */
export function SidebarSkeleton({ label }: { label: string }) {
  return (
    <aside
      aria-label={label}
      aria-busy="true"
      className="flex w-[260px] shrink-0 flex-col gap-3 border-r border-line bg-side px-5 pb-3 pt-5"
    >
      <Bar className="h-5 w-24" />
      <Bar className="mt-4 h-4 w-16" />
      {[0, 1, 2, 3].map((i) => (
        <Bar key={i} className="h-7 w-full" />
      ))}
    </aside>
  );
}

/** A chat page (arena or private): header, a few messages, the composer. */
export function ChatSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" className="flex h-full min-h-0 flex-col">
      <span className="sr-only">{label}</span>
      <header className="flex items-center gap-4 border-b border-line px-6 py-4">
        <Bar className="h-10 w-10" />
        <span className="flex flex-col gap-2">
          <Bar className="h-4 w-48" />
          <Bar className="h-3 w-32" />
        </span>
      </header>
      <div className="flex min-h-0 flex-1 flex-col justify-end gap-5 px-6 py-5">
        {['w-2/3', 'w-1/2', 'w-3/5'].map((width) => (
          <div key={width} className="flex gap-3">
            <Bar className="h-8 w-8 shrink-0 rounded-full" />
            <span className="flex flex-1 flex-col gap-2">
              <Bar className="h-3 w-24" />
              <Bar className={`h-4 ${width}`} />
            </span>
          </div>
        ))}
      </div>
      <div className="px-6 pb-5">
        <Bar className="h-14 w-full" />
      </div>
    </div>
  );
}

/** A plain page (homes, files) while it loads. */
export function PageSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-busy="true" className="flex flex-col gap-4 px-8 py-10">
      <span className="sr-only">{label}</span>
      <Bar className="h-7 w-64" />
      <Bar className="h-4 w-96 max-w-full" />
      <Bar className="h-4 w-80 max-w-full" />
    </div>
  );
}
