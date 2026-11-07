import { defineCollection } from "astro:content";
import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";

export const collections = {
  docs: defineCollection({
    // Release filenames contain version dots (`v0.7.2.md`). The default
    // generateId slugifies them to `v072`; keep the source basename so the
    // public URL is `/releases/v0.7.2/`.
    loader: docsLoader({ generateId: ({ entry }) => entry.replace(/\.[^.]+$/, "") }),
    schema: docsSchema(),
  }),
};
