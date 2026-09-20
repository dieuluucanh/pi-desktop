import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderLoginDialog } from "../../src/renderer/src/connections/ProviderLoginDialog";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { DEFAULT_PREFS } from "../../src/shared/prefs";
import { PROVIDER_LOGIN_EVENT, type ProviderLoginEvent } from "../../src/shared/providers";
import { CONTROL_TAB_ID, type SessionEventEntry } from "../../src/shared/session-ipc";
import { installBridge } from "./fixtures";

/**
 * Provider sign-in (plan step 9, slice 3): the renderer half.
 *
 * Control-host events drive the dialog — an auth URL is opened in the system
 * browser, a device code is shown, a prompt becomes an `oi.respond` answer, and
 * Cancel aborts the flow. The key never appears here by construction (this path
 * only ever receives progress, never a credential).
 */

function deliver(events: SessionEventEntry[]): void {
  useAppStore.getState().applySessionEvents({ tabId: CONTROL_TAB_ID, seq: 1, events });
}

function loginEvent(payload: ProviderLoginEvent): SessionEventEntry {
  return { event: PROVIDER_LOGIN_EVENT, payload };
}

function stubRequest() {
  const request = vi.fn(async () => ({}));
  (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;
  return request;
}

beforeEach(() => {
  installBridge();
  useAppStore.setState({
    prefs: { ...DEFAULT_PREFS },
    providers: [],
    providersLoaded: false,
    providersError: null,
    providerLogin: null,
    hint: null,
  });
});

describe("provider login store", () => {
  it("starts a login against the control host and tracks its events", async () => {
    const request = vi.fn(async () => ({ loginId: "login-1", providerId: "claude-max" }));
    (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;

    await useAppStore.getState().startProviderLogin("claude-max");
    expect(request).toHaveBeenCalledWith({
      tabId: CONTROL_TAB_ID,
      method: "providers.login",
      params: { providerId: "claude-max" },
    });

    deliver([
      loginEvent({
        phase: "progress",
        loginId: "login-1",
        providerId: "claude-max",
        event: { type: "auth_url", url: "https://example.test/oauth" },
      }),
    ]);
    const withUrl = useAppStore.getState().providerLogin;
    expect(withUrl?.url).toBe("https://example.test/oauth");
    expect(withUrl?.status).toBe("running");

    deliver([
      loginEvent({ phase: "done", loginId: "login-1", providerId: "claude-max", provider: null }),
    ]);
    expect(useAppStore.getState().providerLogin?.status).toBe("done");
  });

  it("ignores an event for a different (stale) login", async () => {
    useAppStore.setState({
      providerLogin: {
        loginId: "login-2",
        providerId: "claude-max",
        status: "running",
        message: null,
        url: null,
        deviceCode: null,
        prompt: null,
      },
    });
    deliver([loginEvent({ phase: "cancelled", loginId: "login-1", providerId: "claude-max" })]);
    expect(useAppStore.getState().providerLogin?.loginId).toBe("login-2");
    expect(useAppStore.getState().providerLogin?.status).toBe("running");
  });

  it("turns an oi.request into a pending prompt and answers it", async () => {
    useAppStore.setState({
      providerLogin: {
        loginId: "login-1",
        providerId: "claude-max",
        status: "running",
        message: null,
        url: null,
        deviceCode: null,
        prompt: null,
      },
    });
    deliver([
      {
        event: "oi.request",
        payload: {
          id: "ui-1",
          method: "input",
          params: {
            source: "provider-login",
            loginId: "login-1",
            providerId: "claude-max",
            prompt: { type: "manual_code", message: "Paste the code" },
          },
        },
      },
    ]);
    expect(useAppStore.getState().providerLogin?.prompt?.id).toBe("ui-1");

    const request = stubRequest();
    await useAppStore.getState().answerProviderLogin("code-42");
    expect(request).toHaveBeenCalledWith({
      tabId: CONTROL_TAB_ID,
      method: "oi.respond",
      params: { id: "ui-1", value: "code-42" },
    });
    expect(useAppStore.getState().providerLogin?.prompt).toBeNull();
  });

  it("dismissing cancels a running flow and hides the dialog", async () => {
    useAppStore.setState({
      providerLogin: {
        loginId: "login-1",
        providerId: "claude-max",
        status: "running",
        message: null,
        url: null,
        deviceCode: null,
        prompt: null,
      },
    });
    const request = stubRequest();
    useAppStore.getState().dismissProviderLogin();
    await vi.waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        tabId: CONTROL_TAB_ID,
        method: "providers.cancel",
        params: { loginId: "login-1" },
      }),
    );
    await vi.waitFor(() => expect(useAppStore.getState().providerLogin).toBeNull());
  });
});

describe("ProviderLoginDialog", () => {
  it("shows a device code and the auth URL", () => {
    useAppStore.setState({
      providerLogin: {
        loginId: "login-1",
        providerId: "claude-max",
        status: "running",
        message: "Enter code ABCD-1234",
        url: "https://example.test/oauth",
        deviceCode: { userCode: "ABCD-1234", verificationUri: "https://example.test/device" },
        prompt: null,
      },
    });
    render(<ProviderLoginDialog />);

    expect(screen.getByTestId("provider-login-code")).toHaveTextContent("ABCD-1234");
    expect(screen.getByText(/example\.test\/oauth/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("submits a text prompt", async () => {
    const request = stubRequest();
    useAppStore.setState({
      providerLogin: {
        loginId: "login-1",
        providerId: "claude-max",
        status: "running",
        message: null,
        url: null,
        deviceCode: null,
        prompt: { id: "ui-9", prompt: { type: "manual_code", message: "Paste the code" } },
      },
    });
    render(<ProviderLoginDialog />);

    await userEvent.type(screen.getByLabelText("Paste the code"), "code-7");
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));

    expect(request).toHaveBeenCalledWith({
      tabId: CONTROL_TAB_ID,
      method: "oi.respond",
      params: { id: "ui-9", value: "code-7" },
    });
  });

  it("closes a finished sign-in without cancelling", async () => {
    const request = stubRequest();
    useAppStore.setState({
      providerLogin: {
        loginId: "login-1",
        providerId: "claude-max",
        status: "done",
        message: "Signed in.",
        url: null,
        deviceCode: null,
        prompt: null,
      },
    });
    render(<ProviderLoginDialog />);

    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(request).not.toHaveBeenCalled();
    expect(useAppStore.getState().providerLogin).toBeNull();
  });
});
