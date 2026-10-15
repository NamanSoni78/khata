import type { MetadataRoute } from "next";
import { appBaseUrl } from "@/lib/app-url";

/** robots.txt — index the app shell; keep API + private routes out. */
export default function robots(): MetadataRoute.Robots {
  const base = appBaseUrl();
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/api/", "/admin", "/dashboard"],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
