import type { MetadataRoute } from "next";

/** Minimal sitemap — the app IS one page. No FAQ clutter. */
export default function sitemap(): MetadataRoute.Sitemap {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? "https://khata.namansoni.in";
  return [
    {
      url: base,
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 1,
    },
  ];
}
