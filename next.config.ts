import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    webpackBuildWorker: true,
  },
  serverExternalPackages: ["three"],
  typescript: {
    ignoreBuildErrors: false,
  },
};

export default nextConfig;