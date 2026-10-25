import { normalize } from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryFsPort } from "../../src/main/fs-port";
import { createTrustFile } from "../../src/main/trust-file";

const key = (target: string): string => normalize(target);
const AGENT = "C:/profile";
const PROJECT = "C:/work/app";

function makeFs(initial: { files?: Record<string, string>; dirs?: readonly string[] } = {}) {
  return createMemoryFsPort({
    dirs: [PROJECT, ...(initial.dirs ?? [])],
    files: initial.files ?? {},
  });
}

describe("createTrustFile", () => {
  it("trusts a project with no trust-requiring resources", async () => {
    const trust = createTrustFile({ fs: makeFs(), agentDir: AGENT });
    await expect(trust.isProjectTrusted(PROJECT)).resolves.toBe(true);
  });

  it("requires a decision once .pi/settings.json exists", async () => {
    const fs = makeFs({ files: { [`${PROJECT}/.pi/settings.json`]: "{}" } });
    const trust = createTrustFile({ fs, agentDir: AGENT });
    await expect(trust.isProjectTrusted(PROJECT)).resolves.toBe(false);

    await fs.writeTextFile(`${AGENT}/trust.json`, JSON.stringify({ [key(PROJECT)]: true }));
    await expect(trust.isProjectTrusted(PROJECT)).resolves.toBe(true);
  });

  it("honours the nearest parent decision", async () => {
    const fs = makeFs({
      files: {
        [`${PROJECT}/.pi/settings.json`]: "{}",
        [`${AGENT}/trust.json`]: JSON.stringify({ [key("C:/work")]: true }),
      },
    });
    const trust = createTrustFile({ fs, agentDir: AGENT });
    await expect(trust.isProjectTrusted(PROJECT)).resolves.toBe(true);
  });

  it("treats a malformed trust file as no decision", async () => {
    const fs = makeFs({
      files: {
        [`${PROJECT}/.pi/settings.json`]: "{}",
        [`${AGENT}/trust.json`]: "{",
      },
    });
    const trust = createTrustFile({ fs, agentDir: AGENT });
    await expect(trust.isProjectTrusted(PROJECT)).resolves.toBe(false);
  });

  it("recognises a project resource directory as trust-requiring", async () => {
    const fs = makeFs({ dirs: [`${PROJECT}/.pi/extensions`] });
    const trust = createTrustFile({ fs, agentDir: AGENT });
    await expect(trust.isProjectTrusted(PROJECT)).resolves.toBe(false);
  });
});
