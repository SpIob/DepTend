import { MetadataRoute } from "next";

const BASE_URL = "https://deptend.vercel.app";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  // Static routes
  const staticRoutes: MetadataRoute.Sitemap = [
    {
      url: BASE_URL,
      lastModified: now,
      changeFrequency: "daily",
      priority: 1.0,
    },
    {
      url: `${BASE_URL}/missions`,
      lastModified: now,
      changeFrequency: "daily",
      priority: 0.8,
    },
    {
      url: `${BASE_URL}/submit`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.5,
    },
  ];

  // Note: Dynamic routes (/repo/[owner]/[name], /mission/[id], /org/[login])
  // are intentionally NOT included here — they would require a DB connection
  // at build time. The robots.txt disallows /mission/* to avoid crawl budget
  // waste on near-duplicate pages. Repo/org pages can be discovered via
  // internal linking from the repo directory (/) and /missions.
  // If needed later, a separate dynamic sitemap endpoint can be added.

  return staticRoutes;
}
