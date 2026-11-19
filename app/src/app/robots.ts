import { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        // Disallow near-duplicate mission permalinks from eating crawl budget
        disallow: ["/mission/*"],
      },
    ],
    sitemap: "https://deptend.vercel.app/sitemap.xml",
  };
}
