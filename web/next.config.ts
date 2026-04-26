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
};

export default nextConfig;
