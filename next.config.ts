import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  distDir: process.env.NEXT_DIST_DIR?.trim() || ".next",
  // Pin the tracing root to this app folder. Without it, Next infers the
  // workspace root from outer lockfiles when the app is extracted inside
  // another repo, which buries standalone/server.js under a nested path and
  // breaks the self-update restart.
  outputFileTracingRoot: __dirname,
  // NOTE: do NOT add outputFileTracingExcludes here. Its patterns match
  // loosely (e.g. "data/**" also hit next/dist/lib/metadata/**, "runtime/**"
  // hit @edge-runtime/**) and stripped required Next server files, crashing
  // the packaged runtime on boot. Stray traced folders (artifacts,
  // .next-share-package) are pruned physically by
  // scripts/build-cfs-share-package.ps1 instead, and the zip build fails on
  // paths longer than 180 chars.
  webpack(config, { dev }) {
    if (dev) {
      config.watchOptions = {
        ...config.watchOptions,
        ignored: [
          "**/artifacts/**",
          "**/data/**",
          "**/*.log",
          "**/.next/cache/**",
          "**/playwright-report/**",
          "**/test-results/**",
        ],
      };
    }
    return config;
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
