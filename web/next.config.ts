import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3", "socket.io"],
  turbopack: {
    root: "..",
    resolveAlias: {
      "mapbox-gl": "mapbox-gl/dist/mapbox-gl.js",
    },
  },
  webpack: (config) => {
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    };
    return config;
  },
  // Proxy FastAPI through Next.js so the browser never has to talk to
  // http://localhost:8000 directly. Lets us demo over a single ngrok tunnel
  // without mixed-content blocks (HTTPS page → HTTP localhost is refused).
  async rewrites() {
    const target = process.env.FASTAPI_BASE_URL ?? "http://localhost:8000";
    return [
      { source: "/_api/:path*", destination: `${target}/:path*` },
    ];
  },
};

export default nextConfig;
