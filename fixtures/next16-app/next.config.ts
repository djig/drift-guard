import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    ppr: true,
    dynamicIO: true,
    turbo: { rules: {} },
    serverActions: { bodySizeLimit: '2mb' },
  },
};

export default nextConfig;
