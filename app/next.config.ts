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
          {
            // Report-only for now: Next.js App Router ships inline scripts
            // that an enforced policy would block without a nonce-based
            // middleware. Violations surface in the browser console and any
            // reporting endpoint added later; flip to Content-Security-Policy
            // once the directive set is known-good against production.
            key: "Content-Security-Policy-Report-Only",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: https://github.com https://*.githubusercontent.com",
              "connect-src 'self'",
              "font-src 'self'",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
        ],
      },
    ]);
  },
};

export default config;
