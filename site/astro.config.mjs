import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";
import sitemap from "@astrojs/sitemap";
import { BASE_PATH, SITE_URL } from "./site.config.mjs";
import { remarkBase } from "./scripts/remark-base.mjs";
import { sidebar } from "./src/data/sidebar.mjs";

// GitHub Pages project site: the site URL is the user/org domain and the base
// is the repository name. Every internal link in Markdown goes through the
// remark-base plugin; every Astro component uses withBase().
export default defineConfig({
  site: SITE_URL,
  base: BASE_PATH,
  trailingSlash: "always",
  markdown: {
    remarkPlugins: [[remarkBase, { base: BASE_PATH }]],
  },
  integrations: [
    starlight({
      title: "Pi Desktop",
      description:
        "The desktop UI for the Pi coding agent: projects, sessions, editors, providers and extensions, using the same profile as terminal Pi.",
      logo: { src: "./src/assets/brand/pi-desktop-icon.svg", alt: "Pi Desktop" },
      favicon: "/favicon.svg",
      customCss: ["./src/styles/theme.css"],
      pagefind: true,
      lastUpdated: false,
      components: {
        Head: "./src/components/Head.astro",
        Header: "./src/components/Header.astro",
        Footer: "./src/components/Footer.astro",
        ThemeSelect: "./src/components/ThemeSelect.astro",
      },
      sidebar,
    }),
    sitemap(),
  ],
});
