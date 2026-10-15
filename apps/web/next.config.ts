import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pin the monorepo root so Next does not pick up a stray lockfile above the repo.
  // pnpm and turbo run scripts from apps/web, so the root is two levels up.
  outputFileTracingRoot: path.join(process.cwd(), '../..'),
};

export default nextConfig;
