import type { NextConfig } from 'next';

/** Where the web server reaches the API on the private network (never exposed to browsers). */
const api = (process.env.API_INTERNAL_URL ?? 'http://localhost:4000').replace(/\/+$/, '');

const config: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  output: 'standalone',
  async rewrites() {
    return [
      // The browser talks to one origin: /api/* is forwarded to the API, so session cookies stay first-party.
      { source: '/api/:path*', destination: `${api}/api/:path*` },
      // Channel addresses look like /@handle.
      { source: '/@:handle', destination: '/channel/:handle' },
    ];
  },
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      ],
    }];
  },
};

export default config;
