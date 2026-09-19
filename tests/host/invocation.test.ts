import { describe, expect, it } from "vitest";
import { SERVICE_ENV, SERVICE_FLAG, classifyInvocation } from "../../src/host/index";

describe("classifyInvocation", () => {
  it("defaults to the pi CLI shape", () => {
    expect(classifyInvocation([], {})).toEqual({ mode: "cli", args: [] });
    expect(classifyInvocation(["--version"], {})).toEqual({ mode: "cli", args: ["--version"] });
  });

  it(`selects service mode only with ${SERVICE_FLAG}`, () => {
    expect(classifyInvocation([SERVICE_FLAG, "--session", "abc"], {})).toEqual({
      mode: "service",
      args: ["--session", "abc"],
    });
  });

  it(`selects service mode with ${SERVICE_ENV}=service`, () => {
    expect(classifyInvocation(["--cwd", "C:/p"], { [SERVICE_ENV]: "service" })).toEqual({
      mode: "service",
      args: ["--cwd", "C:/p"],
    });
    expect(classifyInvocation([], { [SERVICE_ENV]: "cli" })).toEqual({ mode: "cli", args: [] });
  });

  it("never swallows pi's own flags (the shim must stay transparent)", () => {
    // These are all real pi CLI arguments; none may be read as service mode.
    const piArgs = [
      "--session",
      "2026-09-19T00-00-00.uuid",
      "-c",
      "--mode",
      "json",
      "--cwd",
      "C:/project",
    ];

    expect(classifyInvocation(piArgs, {})).toEqual({ mode: "cli", args: piArgs });
  });

  it("strips the service flag from the forwarded arguments", () => {
    const invocation = classifyInvocation(["--service", "--port", "38618"], {});
    expect(invocation.args).not.toContain(SERVICE_FLAG);
    expect(invocation.args).toEqual(["--port", "38618"]);
  });

  it("does not mutate the caller's array", () => {
    const argv = [SERVICE_FLAG, "--x"];
    classifyInvocation(argv, {});
    expect(argv).toEqual([SERVICE_FLAG, "--x"]);
  });
});
