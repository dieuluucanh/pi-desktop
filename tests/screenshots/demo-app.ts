import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakeProvider, type FakeProvider } from "../host/fixtures/fake-provider";
import { launchApp, type LaunchedApp } from "../e2e/fixtures/app";

export interface DemoApp extends LaunchedApp {
  provider: FakeProvider;
  projectDir: string;
  menuCommand(id: string): Promise<void>;
  shutdown(): Promise<void>;
}

const DEMO_FILES: Record<string, string> = {
  "README.md": "# Pi Desktop Demo\n\nA tiny project used for the public screenshots.\n",
  "src/app.ts": `import { theme } from "./theme";

export function renderShell() {
  return {
    title: "Pi Desktop",
    theme: theme.name,
    sections: ["projects", "sessions", "editor", "chat"],
  };
}
`,
  "src/theme.ts": `export const theme = {
  name: "parchment",
  accent: "#0A3D9C",
  gold: "#D9A00A",
  background: "#FDFBF3",
} as const;
`,
  "src/session.ts": `export type Session = {
  id: string;
  project: string;
  title: string;
};
`,
  "package.json": JSON.stringify(
    {
      name: "pi-desktop-demo",
      private: true,
      type: "module",
      scripts: { start: "node src/app.ts" },
    },
    null,
    2,
  ),
};

function demoRoot(): string {
  return process.platform === "win32" ? "C:\\Users\\Public\\PiDesktopDemo" : "/tmp/pi-desktop-demo";
}

function createDemoProject(): string {
  const root = demoRoot();
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, "src"), { recursive: true });
  for (const [name, contents] of Object.entries(DEMO_FILES)) {
    writeFileSync(join(root, name), contents, "utf8");
  }
  try {
    const env = {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Pi Desktop Demo",
      GIT_AUTHOR_EMAIL: "demo@example.com",
      GIT_COMMITTER_NAME: "Pi Desktop Demo",
      GIT_COMMITTER_EMAIL: "demo@example.com",
    };
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: root, encoding: "utf8", env, stdio: "ignore" });
    git(["init", "-b", "main"]);
    git(["config", "user.name", "Pi Desktop Demo"]);
    git(["config", "user.email", "demo@example.com"]);
    git(["config", "core.autocrlf", "false"]);
    git(["add", "-A"]);
    git(["commit", "-m", "chore: seed the demo project"]);
  } catch {
    // A machine without git simply misses the source-control screenshot state.
  }
  return root;
}

export async function launchDemoApp(): Promise<DemoApp> {
  const provider = await createFakeProvider();
  const projectDir = createDemoProject();
  const profileDir = `${projectDir}-profile`;
  const userDataDir = `${projectDir}-state`;
  rmSync(profileDir, { recursive: true, force: true });
  rmSync(userDataDir, { recursive: true, force: true });
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(userDataDir, { recursive: true });

  const launched = await launchApp({
    args: ["--force-device-scale-factor=2"],
    profileDir,
    userDataDir,
    settings: {
      defaultProvider: "fake",
      defaultModel: "demo-1",
      retry: { enabled: false },
    },
    models: {
      providers: {
        fake: {
          baseUrl: provider.baseUrl,
          api: "openai-completions",
          apiKey: "demo-key",
          compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
          models: [
            {
              id: "demo-1",
              name: "Pi Demo Model",
              input: ["text", "image"],
              contextWindow: 200000,
            },
          ],
        },
      },
    },
    appState: {
      projects: [{ path: projectDir, name: "Pi Desktop Demo", addedAt: 1, lastOpenedAt: 1 }],
      activeProject: projectDir,
    },
  });

  await launched.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setSize(1440, 900);
  });
  await launched.window.waitForTimeout(500);

  return {
    ...launched,
    provider,
    projectDir,
    async menuCommand(id) {
      await launched.app.evaluate(({ Menu }, commandId) => {
        Menu.getApplicationMenu()?.getMenuItemById(commandId)?.click();
      }, id);
    },
    async shutdown() {
      await launched.close();
      await provider.close();
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(profileDir, { recursive: true, force: true });
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}
