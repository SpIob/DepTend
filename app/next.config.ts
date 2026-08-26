import type { NextConfig } from "next";

const config: NextConfig = {
  // Enforce strict mode to catch potential issues early
  reactStrictMode: true,

  // Transpile shared workspace packages
  transpilePackages: ["@deptend/core"],

  // Security headers (applied to all routes). The Content-Security-Policy
  // is NOT here — it needs a per-request nonce, which only middleware can
  // provide for App Router inline scripts. See app/src/middleware.ts and
  // ADR 0037; the enforced flip lives there too (CSP_ENFORCED).
  headers() {
    return Promise.resolve([
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
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
