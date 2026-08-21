import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  distDir: process.env.NEXT_DIST_DIR?.trim() || ".next",
  // Pin the tracing root to this app folder. Without it, Next infers the
  // workspace root from outer lockfiles when the app is extracted inside
  // another repo, which buries standalone/server.js under a nested path and
  // breaks the self-update restart.
  outputFileTracingRoot: __dirname,
  // Dynamic reads like path.join(appDir, ".cfs-build-info.json") make the file
  // tracer glob the whole project; without these excludes it copied previous
  // package staging folders into .next/standalone, growing zip paths past the
  // Windows 260-char extraction limit.
  outputFileTracingExcludes: {
    "*": [
      "./artifacts/**",
      "./.next-share-package/**",
      "./data/**",
      "./runtime/**",
      "./Manual/**",
      "./test-results/**",
      "./playwright-report/**",
    ],
  },
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
