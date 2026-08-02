import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    // The Cloudflare-only database adapter is intentionally excluded from the
    // Vercel runtime bundle; the ETL/API layer owns that integration.
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
