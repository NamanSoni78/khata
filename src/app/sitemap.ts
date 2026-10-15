import type { MetadataRoute } from "next";
import { appBaseUrl } from "@/lib/app-url";

/** Sitemap — landing + legal pages (everything else is private/auth-gated). */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = appBaseUrl();
  return [
    {
      url: base,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
    {
      url: `${base}/terms`,
      lastModified: new Date(),
      changeFrequency: "yearly",
      priority: 0.3,
    },
    {
      url: `${base}/privacy`,
      lastModified: new Date(),
      changeFrequency: "yearly",
      priority: 0.3,
    },
  ];
}
