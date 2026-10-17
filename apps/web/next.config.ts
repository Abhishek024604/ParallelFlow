import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // `pnpm demo` builds into .next-demo, so a production build never overwrites a running `next dev`.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // Pin the monorepo root so Next does not pick up a stray lockfile above the repo.
  // pnpm and turbo run scripts from apps/web, so the root is two levels up.
  outputFileTracingRoot: path.join(process.cwd(), '../..'),
  // Workspace packages ship TypeScript source (NodeNext style: `./x.js` imports of `./x.ts`).
  transpilePackages: ['@saras/contracts'],
  // Uploads (POST /v1/private/files, /v1/projects/{id}/files) go through the /v1 proxy as a raw
  // body of up to 10 MB (Phase A). Next buffers proxied request bodies with a 10 MB default; 11 MB
  // leaves room so the API's own 10 MB check gives the error. SLICE_DEBT Demo 3 / Demo 6.
  experimental: { middlewareClientMaxBodySize: '11mb' },
  // Lint runs once for the whole repo (`pnpm lint`), not again inside `next build`.
  eslint: { ignoreDuringBuilds: true },
  // Same-origin API proxy: the browser calls /v1/* on the web origin and Next forwards it to the API
  // (method, body, headers and cookies in; status, Location and Set-Cookie out, redirects not
  // followed). The API's cookies are therefore set for the web origin. The middleware skips /v1/*.
  async rewrites() {
    const api = (process.env.API_URL || 'http://localhost:4000').replace(/\/+$/, '');
    // `fallback`, not the default `afterFiles`: afterFiles rewrites run before dynamic routes, so they
    // would shadow the streaming route handler at app/v1/projects/[projectId]/arena/turns/[turnId]/
    // events (this proxy buffers and times out at 30 s). Fallback runs after every app route.
    return {
      beforeFiles: [],
      afterFiles: [],
      fallback: [{ source: '/v1/:path*', destination: `${api}/v1/:path*` }],
    };
  },
  webpack(config: { resolve: { extensionAlias?: Record<string, string[]> } }) {
    config.resolve.extensionAlias = { '.js': ['.ts', '.tsx', '.js'] };
    return config;
  },
};

export default nextConfig;
