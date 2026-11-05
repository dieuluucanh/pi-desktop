/**
 * The docs information architecture. Source paths are the only place a doc is
 * named for navigation; the generated manifest supplies its title and route.
 * `site/tests/nav.test.ts` and the root contract test fail if a docs page is
 * missing from this list.
 */

export const DOCS_INDEX_SOURCE = "docs/README.md";

export const NAV_GROUPS = [
  {
    label: "Getting started",
    sources: ["docs/guide/getting-started.md"],
  },
  {
    label: "User guide",
    sources: [
      "docs/guide/projects.md",
      "docs/guide/sessions-and-tabs.md",
      "docs/guide/providers-and-auth.md",
      "docs/guide/models-and-thinking.md",
      "docs/guide/extensions-and-packages.md",
      "docs/guide/settings.md",
      "docs/guide/skills-themes-keybindings.md",
      "docs/guide/office-setup.md",
      "docs/guide/git-and-checkpoints.md",
      "docs/guide/plannotator-web-tabs.md",
      "docs/guide/troubleshooting.md",
      "docs/guide/faq.md",
      "docs/guide/branding.md",
    ],
  },
  {
    label: "Architecture",
    sources: [
      "docs/architecture/app-shell.md",
      "docs/architecture/terminal.md",
      "docs/architecture/editor-and-explorer.md",
      "docs/architecture/host-protocol.md",
      "docs/architecture/extension-ui.md",
      "docs/architecture/session-parity.md",
      "docs/architecture/source-control.md",
      "docs/architecture/office-integration.md",
      "docs/architecture/runtime.md",
      "docs/architecture/release-pipeline.md",
      "docs/architecture/versions.md",
    ],
  },
  {
    label: "Project",
    sources: ["docs/product/parity.md", "docs/product/backlog.md", "docs/product/traceability.md"],
  },
];
