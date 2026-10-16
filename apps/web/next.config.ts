import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Pin the monorepo root so Next does not pick up a stray lockfile above the repo.
  // pnpm and turbo run scripts from apps/web, so the root is two levels up.
  outputFileTracingRoot: path.join(process.cwd(), '../..'),
  // Workspace packages ship TypeScript source (NodeNext style: `./x.js` imports of `./x.ts`).
  transpilePackages: ['@saras/contracts'],
  // Lint runs once for the whole repo (`pnpm lint`), not again inside `next build`.
  eslint: { ignoreDuringBuilds: true },
  webpack(config: { resolve: { extensionAlias?: Record<string, string[]> } }) {
    config.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] };
    return config;
  },
};

export default nextConfig;
