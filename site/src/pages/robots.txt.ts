import { absoluteUrl } from "../../site.config.mjs";

export const GET = () =>
  new Response(
    ["User-agent: *", "Allow: /", "", `Sitemap: ${absoluteUrl("/sitemap-index.xml")}`, ""].join(
      "\n",
    ),
    { headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
