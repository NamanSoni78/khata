import type { MetadataRoute } from "next";

/** robots.txt — index the app shell; keep API + private routes out. */
export default function robots(): MetadataRoute.Robots {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "https://khata.namansoni.in";
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
