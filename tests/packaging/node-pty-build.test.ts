import { describe, expect, it } from "vitest";

import { parseBuildArgs } from "../../scripts/build-node-pty.mjs";
import {
  isPtyPrebuildFresh,
  linuxPtyContainer,
  ptyBuildInfo,
} from "../../scripts/lib/node-pty-artifact.mjs";

const PREVIOUS_IMAGE = process.env.PI_PTY_IMAGE;

function withImageEnv<T>(value: string | undefined, run: () => T): T {
  if (value === undefined) delete process.env.PI_PTY_IMAGE;
  else process.env.PI_PTY_IMAGE = value;
  try {
    return run();
  } finally {
    if (PREVIOUS_IMAGE === undefined) delete process.env.PI_PTY_IMAGE;
    else process.env.PI_PTY_IMAGE = PREVIOUS_IMAGE;
  }
}

describe("parseBuildArgs", () => {
  it("defaults to the host arch and the bullseye image", () => {
    const options = withImageEnv(undefined, () => parseBuildArgs([]));
    expect(options).toMatchObject({
      arches: [process.arch],
      force: false,
      checkOnly: false,
      printPlan: false,
      image: "debian:bullseye",
    });
  });

  it("accepts both arches once, in order", () => {
    const options = withImageEnv(undefined, () =>
      parseBuildArgs(["--arch", "x64", "--arch", "arm64", "--arch", "x64", "--force"]),
    );
    expect(options.arches).toEqual(["x64", "arm64"]);
    expect(options.force).toBe(true);
  });

  it("supports the check-only and print-plan modes", () => {
    const options = withImageEnv(undefined, () => parseBuildArgs(["--check-only", "--print-plan"]));
    expect(options.checkOnly).toBe(true);
    expect(options.printPlan).toBe(true);
  });

  it("prefers --image and falls back to PI_PTY_IMAGE", () => {
    expect(
      withImageEnv(undefined, () => parseBuildArgs(["--image", "debian:bookworm"]).image),
    ).toBe("debian:bookworm");
    expect(withImageEnv("debian:bullseye@sha256:abc", () => parseBuildArgs([]).image)).toBe(
      "debian:bullseye@sha256:abc",
    );
    expect(
      withImageEnv(
        "debian:bullseye@sha256:abc",
        () => parseBuildArgs(["--image", "debian:trixie"]).image,
      ),
    ).toBe("debian:trixie");
  });

  it("rejects an unknown arch", () => {
    expect(() => withImageEnv(undefined, () => parseBuildArgs(["--arch", "ia32"]))).toThrow(
      /unsupported arch "ia32"/,
    );
  });
});

describe("linuxPtyContainer", () => {
  const base = {
    repoDir: "/repo",
    image: "debian:bullseye",
    moduleDir: "/work/node_modules/node-pty",
    nodePath: "/work/resources/runtime/node/linux-x64/bin/node",
    nodeGyp: "/work/node_modules/node-gyp/bin/node-gyp.js",
    nodeVersion: "24.22.2",
    outputDir: "/work/node_modules/node-pty/prebuilds/linux-x64",
  } as const;

  it("maps x64 to linux/amd64 and arm64 to linux/arm64", () => {
    expect(linuxPtyContainer({ ...base, arch: "x64" }).platform).toBe("linux/amd64");
    expect(linuxPtyContainer({ ...base, arch: "arm64" }).platform).toBe("linux/arm64");
  });

  it("mounts the repo, builds in /tmp and writes only the artifact back", () => {
    const container = linuxPtyContainer({ ...base, arch: "x64" });
    const args = container.args;
    expect(args.slice(0, 3)).toEqual(["run", "--rm", "--platform"]);
    expect(args).toContain("/repo:/work");
    expect(args).toContain("-e");
    expect(args).toContain("HOME=/tmp");
    expect(args).toContain("debian:bullseye");
    expect(args.at(-1)).toBe("/work/node_modules/node-pty/prebuilds/linux-x64");
    expect(args).toEqual(expect.arrayContaining([base.moduleDir, base.nodeVersion]));

    // The module is copied out of the workspace, so node-gyp leaves no root
    // build tree behind; only pty.node and the readelf report are written back.
    expect(container.script).toContain('cp -a "$module_dir" /tmp/node-pty');
    expect(container.script).toContain('"$node_path" "$node_gyp" rebuild --target="$node_version"');
    expect(container.script).toContain('cp build/Release/pty.node "$output_dir/pty.node"');
    expect(container.script).toContain("chmod 0755");
    expect(container.script).toContain("readelf --version-info");
    expect(container.script).toContain("build-essential python3 ca-certificates binutils");
    expect(container.script).toContain("apt-get update");
  });
});

describe("pty prebuild provenance", () => {
  const expected = ptyBuildInfo({
    nodePtyVersion: "1.1.0",
    nodeVersion: "24.22.2",
    image: "debian:bullseye",
    imageDigest: "debian:bullseye@sha256:abc",
    builtAt: "2026-11-08T00:00:00.000Z",
  });

  it("records the toolchain and the floor", () => {
    expect(expected).toMatchObject({
      nodePty: "1.1.0",
      node: "24.22.2",
      image: "debian:bullseye",
      imageDigest: "debian:bullseye@sha256:abc",
      floor: { glibc: "2.31", glibcxx: "3.4.28" },
      builtAt: "2026-11-08T00:00:00.000Z",
    });
  });

  it("is fresh only for the same node-pty, Node, image and floor", () => {
    expect(isPtyPrebuildFresh(expected, expected)).toBe(true);
    expect(isPtyPrebuildFresh({ ...expected, nodePty: "1.2.0" }, expected)).toBe(false);
    expect(isPtyPrebuildFresh({ ...expected, node: "24.23.0" }, expected)).toBe(false);
    expect(isPtyPrebuildFresh({ ...expected, image: "ubuntu:22.04" }, expected)).toBe(false);
    expect(
      isPtyPrebuildFresh({ ...expected, floor: { glibc: "2.35", glibcxx: "3.4.28" } }, expected),
    ).toBe(false);
    expect(isPtyPrebuildFresh(null, expected)).toBe(false);
  });
});
