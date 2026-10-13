import type { NextConfig } from 'next';
import path from 'node:path';

type WebpackConfig = {
  output?: {
    hashFunction?: string;
  };
};

const shouldForceCryptoHashFunction = (() => {
  if (process.platform !== 'win32') return false;
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);
  return major === 22;
})();

const nextConfig: NextConfig = {
  reactStrictMode: true,
  outputFileTracingRoot: path.resolve(__dirname, '..', '..'),
  productionBrowserSourceMaps: true,
  webpack: (config: WebpackConfig): WebpackConfig => {
    if (shouldForceCryptoHashFunction) {
      config.output = config.output ?? {};
      config.output.hashFunction = 'sha256';
    }
    return config;
  },
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
