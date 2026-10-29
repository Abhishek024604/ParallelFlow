// Ranks folder files for the chat's @ picker. Pure; the host lists the files, this orders them.

/** Best first: name starts with the query, name contains it, path contains it, then a fuzzy match. */
export function rankFiles(query: string, files: readonly string[], limit = 30): string[] {
  const q = query.trim().toLowerCase().replace(/\\/g, '/');
  if (!q)
    return [...files].sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, limit);
  const scored: { path: string; score: number }[] = [];
  for (const path of files) {
    const p = path.toLowerCase();
    const name = p.slice(p.lastIndexOf('/') + 1);
    let score: number;
    if (name.startsWith(q)) score = 0;
    else if (name.includes(q)) score = 1;
    else if (p.includes(q)) score = 2;
    else if (subsequence(q, p)) score = 3;
    else continue;
    scored.push({ path, score });
  }
  return scored
    .sort(
      (a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path),
    )
    .slice(0, limit)
    .map((s) => s.path);
}

function subsequence(q: string, s: string): boolean {
  let i = 0;
  for (const ch of s) if (ch === q[i] && ++i === q.length) return true;
  return false;
}
