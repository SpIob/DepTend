import type { NextConfig } from "next";

const config: NextConfig = {
  // Enforce strict mode to catch potential issues early
  reactStrictMode: true,

  // Transpile shared workspace packages
  transpilePackages: ["@deptend/core"],

  // Security headers (applied to all routes)
  headers() {
    return Promise.resolve([
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-XSS-Protection", value: "1; mode=block" },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
    ]);
  },
};

export default config;
