import { describe, expect, it, vi } from "vitest";
import { createProjectTrust, resolveTrust, type TrustDecision } from "../../src/host/project-trust";

function store(initial: Record<string, TrustDecision> = {}) {
  const decisions = new Map(Object.entries(initial));
  return {
    decisions,
    get: (cwd: string): TrustDecision => decisions.get(cwd) ?? null,
    set: (cwd: string, decision: TrustDecision): void => {
      decisions.set(cwd, decision);
    },
  };
}

describe("resolveTrust", () => {
  it("trusts a project that needs no trust at all", () => {
    expect(resolveTrust({ cwd: "/p", requiresTrust: false, decision: null })).toMatchObject({
      trusted: true,
      needsPrompt: false,
    });
  });

  it("prompts when project resources exist and nothing was decided", () => {
    expect(resolveTrust({ cwd: "/p", requiresTrust: true, decision: null })).toMatchObject({
      trusted: false,
      needsPrompt: true,
      requiresTrust: true,
    });
  });

  it("honours a remembered decision", () => {
    expect(resolveTrust({ cwd: "/p", requiresTrust: true, decision: true }).trusted).toBe(true);
    const never = resolveTrust({ cwd: "/p", requiresTrust: true, decision: false });
    expect(never.trusted).toBe(false);
    expect(never.needsPrompt).toBe(false);
  });

  it("honours a session-only grant even when the store says nothing", () => {
    expect(
      resolveTrust({ cwd: "/p", requiresTrust: true, decision: null, sessionTrusted: true }),
    ).toMatchObject({
      trusted: true,
      needsPrompt: false,
    });
  });
});

describe("createProjectTrust", () => {
  it("answers 'trust' by persisting the decision", () => {
    const trustStore = store();
    const trust = createProjectTrust({ store: trustStore, requiresTrust: () => true });

    const status = trust.answer("/p", "trust");

    expect(status.trusted).toBe(true);
    expect(trustStore.decisions.get("/p")).toBe(true);
    expect(trust.isTrusted("/p")).toBe(true);
  });

  it("answers 'never' by persisting a refusal", () => {
    const trustStore = store();
    const trust = createProjectTrust({ store: trustStore, requiresTrust: () => true });

    const status = trust.answer("/p", "never");

    expect(status.trusted).toBe(false);
    expect(trustStore.decisions.get("/p")).toBe(false);
  });

  it("answers 'session' without touching the store", () => {
    const trustStore = store();
    const trust = createProjectTrust({ store: trustStore, requiresTrust: () => true });

    expect(trust.answer("/p", "session").trusted).toBe(true);
    expect(trustStore.decisions.has("/p")).toBe(false);
    expect(trust.status("/p").needsPrompt).toBe(false);
  });

  it("never throws when the store or the detector fails", () => {
    const trust = createProjectTrust({
      store: {
        get: () => {
          throw new Error("unreadable trust.json");
        },
        set: () => {
          throw new Error("read-only profile");
        },
      },
      requiresTrust: () => {
        throw new Error("cwd vanished");
      },
    });

    expect(trust.status("/p")).toMatchObject({
      requiresTrust: false,
      trusted: true,
      needsPrompt: false,
    });
    expect(trust.answer("/p", "trust").trusted).toBe(true);
  });

  it("asks the detector once per status call and passes the cwd through", () => {
    const requiresTrust = vi.fn(() => true);
    const trust = createProjectTrust({ store: store(), requiresTrust });

    trust.status("/work");
    trust.status("/work");

    expect(requiresTrust).toHaveBeenCalledWith("/work");
    expect(requiresTrust).toHaveBeenCalledTimes(2);
  });
});
