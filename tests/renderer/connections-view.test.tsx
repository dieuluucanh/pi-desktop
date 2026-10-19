import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionsView } from "../../src/renderer/src/views/ConnectionsView";
import { useAppStore } from "../../src/renderer/src/state/app-store";
import { appInfoFixture, installBridge } from "./fixtures";
import type { ProviderSummary } from "../../src/shared/providers";

/**
 * Connections view (plan step 9, slice 4).
 *
 * The load-bearing behaviours: providers are grouped by how they are paid for,
 * signing in starts the OAuth flow against the control host, and the API-key
 * form sends the key once without ever rendering it back.
 */

const PROVIDERS: ProviderSummary[] = [
  {
    id: "claude-max",
    label: "Claude Max",
    authTypes: ["oauth"],
    subscription: true,
    configured: true,
    source: "stored",
    modelCount: 4,
    envVars: [],
    envAvailable: false,
  },
  {
    id: "anthropic",
    label: "Anthropic",
    authTypes: ["api_key", "oauth"],
    subscription: false,
    configured: false,
    modelCount: 12,
    envVars: ["ANTHROPIC_API_KEY"],
    envAvailable: false,
  },
  {
    id: "ollama",
    label: "Ollama",
    authTypes: ["api_key"],
    subscription: false,
    configured: true,
    source: "environment",
    modelCount: 2,
    envVars: [],
    envAvailable: false,
  },
];

function stubRequest(impl?: (method: string, params?: unknown) => Promise<unknown>) {
  const request = vi.fn(async (input: { method: string; params?: unknown }) => {
    if (input.method === "providers.list") {
      return { providers: PROVIDERS };
    }
    if (input.method === "providers.custom") return { providers: [] };
    if (input.method === "providers.setKey") return { provider: PROVIDERS[1] };
    return impl ? impl(input.method, input.params) : {};
  });
  (window.pi as unknown as { sessions: { request: unknown } }).sessions.request = request;
  return request;
}

beforeEach(() => {
  installBridge({ appInfo: appInfoFixture() });
  useAppStore.setState({
    providers: [],
    providersLoaded: false,
    providersError: null,
    providerLogin: null,
    info: appInfoFixture(),
    hint: null,
  });
});

describe("ConnectionsView", () => {
  it("groups providers by payment model", async () => {
    stubRequest();
    render(<ConnectionsView />);

    await waitFor(() => expect(screen.getByTestId("group-subscription")).toBeInTheDocument());
    expect(screen.getByTestId("group-apiKey")).toBeInTheDocument();
    expect(screen.getByTestId("group-local")).toBeInTheDocument();

    const subscriptions = within(screen.getByTestId("group-subscription"));
    expect(subscriptions.getByText("Claude Max")).toBeInTheDocument();
    expect(within(screen.getByTestId("group-local")).getByText("Ollama")).toBeInTheDocument();
  });

  it("shows the credential status and starts sign-in from the sheet", async () => {
    const request = stubRequest();
    render(<ConnectionsView />);
    await waitFor(() => expect(screen.getByTestId("group-apiKey")).toBeInTheDocument());

    const apiKeyGroup = within(screen.getByTestId("group-apiKey"));
    await userEvent.click(apiKeyGroup.getByRole("button", { name: "Manage" }));

    const sheet = within(screen.getByTestId("provider-sheet"));
    expect(sheet.getByText("not set up")).toBeInTheDocument();

    await userEvent.click(sheet.getByRole("button", { name: "Sign in" }));
    expect(request).toHaveBeenCalledWith({
      tabId: "control",
      method: "providers.login",
      params: { providerId: "anthropic" },
    });
  });

  it("sends an API key once and never renders it back", async () => {
    const request = stubRequest();
    render(<ConnectionsView />);
    await waitFor(() => expect(screen.getByTestId("group-apiKey")).toBeInTheDocument());
    await userEvent.click(
      within(screen.getByTestId("group-apiKey")).getByRole("button", { name: "Manage" }),
    );

    const input = screen.getByTestId("provider-key-input") as HTMLInputElement;
    await userEvent.type(input, "sk-secret-value");
    await userEvent.click(screen.getByRole("button", { name: "Save key" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        tabId: "control",
        method: "providers.setKey",
        params: { providerId: "anthropic", apiKey: "sk-secret-value" },
      }),
    );
    // The field is cleared and the key appears nowhere in the DOM.
    await waitFor(() => expect(input.value).toBe(""));
    expect(document.body.textContent ?? "").not.toContain("sk-secret-value");
  });

  it("offers sign out for a configured subscription", async () => {
    const request = stubRequest();
    render(<ConnectionsView />);
    await waitFor(() => expect(screen.getByTestId("group-subscription")).toBeInTheDocument());
    await userEvent.click(
      within(screen.getByTestId("group-subscription")).getByRole("button", { name: "Manage" }),
    );

    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        tabId: "control",
        method: "providers.logout",
        params: { providerId: "claude-max" },
      }),
    );
  });

  it("adds a custom gateway through providers.custom and keeps the key write-only", async () => {
    const request = stubRequest();
    render(<ConnectionsView />);
    await waitFor(() => expect(screen.getByTestId("group-custom")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /Add gateway/ }));
    await userEvent.type(screen.getByLabelText("Provider id"), "my-gateway");
    await userEvent.type(screen.getByLabelText("Base URL"), "https://gateway.example.com/v1");
    await userEvent.type(screen.getByLabelText("Model ids"), "gpt-5, gpt-5-mini");
    await userEvent.type(screen.getByLabelText("Gateway API key"), "sk-gateway-secret");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        tabId: "control",
        method: "providers.custom",
        params: {
          action: "set",
          provider: {
            id: "my-gateway",
            baseUrl: "https://gateway.example.com/v1",
            api: "openai-completions",
            apiKey: "sk-gateway-secret",
            models: [{ id: "gpt-5" }, { id: "gpt-5-mini" }],
          },
        },
      }),
    );
    expect(document.body.textContent ?? "").not.toContain("sk-gateway-secret");
  });

  // The bug this feature fixes: a real gateway model id (HuggingFace form) was
  // refused by a package-name charset Pi does not apply.
  it("submits a rich model id verbatim", async () => {
    const request = stubRequest();
    render(<ConnectionsView />);
    await waitFor(() => expect(screen.getByTestId("group-custom")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /Add gateway/ }));
    await userEvent.type(screen.getByLabelText("Provider id"), "hf-router");
    await userEvent.type(screen.getByLabelText("Base URL"), "https://router.huggingface.co/v1");
    await userEvent.type(
      screen.getByLabelText("Model ids"),
      "hf:deepseek-ai/DeepSeek-V4.1-Flash, ~anthropic/claude-opus-latest",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith({
        tabId: "control",
        method: "providers.custom",
        params: {
          action: "set",
          provider: {
            id: "hf-router",
            baseUrl: "https://router.huggingface.co/v1",
            api: "openai-completions",
            models: [
              { id: "hf:deepseek-ai/DeepSeek-V4.1-Flash" },
              { id: "~anthropic/claude-opus-latest" },
            ],
          },
        },
      }),
    );
  });

  it("refuses a bad provider id before calling the host", async () => {
    const request = stubRequest();
    render(<ConnectionsView />);
    await waitFor(() => expect(screen.getByTestId("group-custom")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /Add gateway/ }));
    await userEvent.type(screen.getByLabelText("Provider id"), "my/fleet");
    await userEvent.type(screen.getByLabelText("Base URL"), "https://gateway.example.com/v1");
    await userEvent.type(screen.getByLabelText("Model ids"), "gpt-5");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    // The message is the shared rule's, naming the actual problem.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/first slash/i);
    // A `list` call is the normal mount load; a `set` must never happen.
    expect(
      request.mock.calls.some(
        (call) =>
          (call[0] as { method?: string; params?: { action?: string } }).params?.action === "set",
      ),
    ).toBe(false);
  });

  it("refuses a model id with a space before calling the host", async () => {
    // A comma cannot reach an id here: the field splits on it, so `gpt-5,mini`
    // is two models. The shared rule still refuses commas for API callers
    // (pinned in tests/shared/custom-providers.test.ts).
    const request = stubRequest();
    render(<ConnectionsView />);
    await waitFor(() => expect(screen.getByTestId("group-custom")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: /Add gateway/ }));
    await userEvent.type(screen.getByLabelText("Provider id"), "my-gateway");
    await userEvent.type(screen.getByLabelText("Base URL"), "https://gateway.example.com/v1");
    await userEvent.type(screen.getByLabelText("Model ids"), "gpt 5");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/model id/i);
    expect(
      request.mock.calls.some(
        (call) =>
          (call[0] as { method?: string; params?: { action?: string } }).params?.action === "set",
      ),
    ).toBe(false);
  });

  it("shows the id rules next to the fields", async () => {
    stubRequest();
    render(<ConnectionsView />);
    await waitFor(() => expect(screen.getByTestId("group-custom")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /Add gateway/ }));

    expect(screen.getByTestId("model-ids-hint").textContent).toMatch(/comma-separated/i);
    expect(screen.getByTestId("model-ids-hint").textContent).toMatch(/200 characters/i);
    expect(screen.getByTestId("provider-id-hint").textContent).toMatch(/first slash/i);
  });
});
