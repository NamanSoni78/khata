import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // pdfkit + pdf-parse must stay external (Node-only, dynamic imports in route handlers)
  serverExternalPackages: ["pdfkit", "pdf-parse", "bcryptjs", "@libsql/client", "@prisma/adapter-libsql"],
  typescript: {
    ignoreBuildErrors: false,
  },
  reactStrictMode: true,
  images: {
    unoptimized: true,
  },
  allowedDevOrigins: ["localhost:3000", "*.space-z.ai"],
  // hide the dev-tools indicator (cleaner screenshots; it also intercepts
  // pointer events in the bottom-left corner during automated testing)
  devIndicators: false,
};

export default nextConfig;
