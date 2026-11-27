import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Pi-agent watch workflow contract (2026-11-15 update-channels plan, step 11).
 *
 * The workflow itself can only be proven by running it, but the properties that
 * make it safe are textual: it cannot run on a push, it never bumps a major,
 * it proves the bump with the same gate a PR runs, and it cannot publish or
 * tag. Read as text, like `tests/packaging/release-workflow.test.ts`.
 */

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const workflowPath = ".github/workflows/pi-agent-watch.yml";
const yaml = readFileSync(join(repoRoot, workflowPath), "utf8").replace(/\r\n/g, "\n");
const nodeLock = JSON.parse(
  readFileSync(join(repoRoot, "resources", "runtime", "node.lock.json"), "utf8"),
) as { node: { version: string } };

const ACTION_PIN = /^ {6}- uses: [a-z-]+\/[a-z-]+@[0-9a-f]{40} # v\d+$/gm;
/** Comments mention `npm ci` and `--major`; structure assertions read code only. */
const code = yaml
  .split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

describe("pi-agent watch workflow", () => {
  it("runs on a schedule and by hand, never on a push", () => {
    expect(yaml).toMatch(/on:\n {2}schedule:/);
    expect(yaml).toContain('- cron: "17 5 * * *"');
    expect(yaml).toMatch(/\n {2}workflow_dispatch:/);
    expect(yaml).not.toMatch(/\n {2}push:/);
    expect(yaml).toMatch(/concurrency:\n {2}group: pi-agent-watch\n {2}cancel-in-progress: true/);
  });

  it("can push the branch and open the PR, and asks for nothing else", () => {
    expect(yaml).toMatch(
      /permissions:\n {2}contents: write # push the bump branch\n {2}pull-requests: write # open the PR\n/,
    );
    // The checkout credential is persisted on purpose: this job pushes.
    expect(yaml).toMatch(/persist-credentials: true/);
    expect(yaml).not.toMatch(/secrets\./i);
  });

  it("pins every action by commit and the bundled Node by the lock", () => {
    const pins = yaml.match(ACTION_PIN) ?? [];
    expect(pins.length).toBe(2);
    expect(yaml).toContain("actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5");
    expect(yaml).toContain("actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5");
    expect(yaml).toContain(`node-version: ${nodeLock.node.version}`);
  });

  it("checks before it installs, so a broken install cannot hide a stale agent", () => {
    const status = code.indexOf("node scripts/pi-agent.mjs --status --json");
    const install = code.indexOf("bash scripts/retry.sh 3 30 -- npm ci");
    expect(status).toBeGreaterThan(-1);
    expect(install).toBeGreaterThan(-1);
    expect(status).toBeLessThan(install);
  });

  it("bumps only a minor/patch, and only when the check says behind", () => {
    expect(code).toMatch(/if: steps\.status\.outputs\.status == 'behind'/);
    // Both the bump and the PR are behind the same gate.
    expect(code.match(/if: steps\.status\.outputs\.status == 'behind'/g)).toHaveLength(2);
    expect(code).toContain("node scripts/pi-agent.mjs --update");
    // A major is reported, never taken automatically.
    expect(code).toContain('echo "::warning::a major Pi agent release is available');
    expect(code).not.toContain("exit 1");
    expect(code).not.toContain("--update --major");
  });

  it("proves the bump with the same gates a pull request runs", () => {
    for (const command of [
      "npm run typecheck",
      "npm run lint",
      "npm test",
      "npm run build:host",
      "npm run pi:check",
    ]) {
      expect(yaml).toContain(command);
    }
  });

  it("opens a PR against main on a version-named branch, and can be re-run", () => {
    expect(yaml).toContain('branch="chore/pi-agent-$version"');
    expect(yaml).toContain("gh pr create");
    expect(yaml).toContain("--base main");
    expect(yaml).toContain('--head "$branch"');
    // A second run for the same version must not open a duplicate PR.
    expect(yaml).toContain('gh pr list --head "$branch" --state open');
    expect(yaml).toContain('git push --force-with-lease origin "$branch"');
  });

  it("cannot publish a package or move a tag", () => {
    expect(yaml).not.toMatch(/npm publish/);
    expect(yaml).not.toMatch(/git tag/);
    expect(yaml).not.toMatch(/git push[^\n]*\bmain\b/);
    expect(yaml).not.toMatch(/gh release/);
  });
});
