import { useEffect, useMemo, useState } from "react";
import { Plus, Search, Trash2 } from "lucide-react";
import {
  modelIdError,
  providerIdError,
  type CustomProviderSummary,
} from "../../../shared/custom-providers";
import type { ProviderSummary } from "../../../shared/providers";
import { useAppStore } from "../state/app-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { Separator } from "../ui/separator";
import {
  canAddKey,
  canSignIn,
  groupProviders,
  statusLabel,
  statusTone,
} from "../connections/provider-groups";

/**
 * Connections (plan step 9, slice 4).
 *
 * Providers grouped by how they are paid for, with one sheet per provider:
 * status, sign in / sign out, a **write-only** key form, and the note that the
 * same `auth.json` is what terminal Pi reads. The key is sent once and never
 * rendered back — the UI cannot show what it never receives.
 */
export function ConnectionsView() {
  const providers = useAppStore((state) => state.providers);
  const loaded = useAppStore((state) => state.providersLoaded);
  const error = useAppStore((state) => state.providersError);
  const loadProviders = useAppStore((state) => state.loadProviders);
  const customProviders = useAppStore((state) => state.customProviders);
  const customProvidersLoaded = useAppStore((state) => state.customProvidersLoaded);
  const loadCustomProviders = useAppStore((state) => state.loadCustomProviders);
  const connectionsFocus = useAppStore((state) => state.connectionsFocus);
  const clearConnectionsFocus = useAppStore((state) => state.clearConnectionsFocus);
  const [localQuery, setLocalQuery] = useState("");
  const [localSelectedId, setLocalSelectedId] = useState<string | null>(null);
  const [gatewayOpen, setGatewayOpen] = useState(false);

  useEffect(() => {
    void loadProviders();
    void loadCustomProviders();
  }, [loadProviders, loadCustomProviders]);

  // `/login <provider>` either opens that provider's sheet or seeds the search.
  // The focus overrides the local state until the user touches the view; then
  // it is released so the controls become editable again. `setView` also
  // releases it when the user navigates away.
  const query = connectionsFocus?.query ?? localQuery;
  const selectedId = connectionsFocus?.providerId ?? localSelectedId;
  const releaseFocus = (): void => {
    if (connectionsFocus) clearConnectionsFocus();
  };

  const groups = useMemo(() => groupProviders(providers), [providers]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return groups;
    return groups
      .map((group) => ({
        ...group,
        providers: group.providers.filter((provider) =>
          `${provider.id} ${provider.label}`.toLowerCase().includes(needle),
        ),
      }))
      .filter((group) => group.providers.length > 0);
  }, [groups, query]);

  const selected = providers.find((provider) => provider.id === selectedId) ?? null;

  return (
    <div className="mx-auto flex h-full max-w-4xl flex-col gap-4 overflow-y-auto px-8 py-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Connections</h1>
          <p className="text-sm text-ink-muted">
            Providers are shared with terminal Pi: a signed-in subscription, or a key written to{" "}
            <code className="font-mono text-xs">auth.json</code>, is usable in both immediately.
          </p>
        </div>
        <Button size="sm" onClick={() => void loadProviders()}>
          Refresh
        </Button>
      </header>

      <label className="flex items-center gap-2 rounded-sm border border-line px-2 py-1">
        <Search className="size-3 text-ink-faint" aria-hidden />
        <input
          aria-label="Search providers"
          value={query}
          onChange={(event) => {
            releaseFocus();
            setLocalQuery(event.target.value);
          }}
          placeholder="Search providers"
          className="w-full bg-transparent text-xs text-ink outline-none"
        />
      </label>

      {error ? (
        <p className="banner banner--error text-xs" role="alert">
          {error}
        </p>
      ) : null}

      {!loaded ? (
        <p className="text-xs text-ink-faint">Reading providers from the Pi runtime…</p>
      ) : providers.length === 0 && !error ? (
        <p className="text-xs text-ink-faint">
          The Pi runtime reported no providers. Check the profile and try Refresh.
        </p>
      ) : null}

      {filtered.map((group) => (
        <section
          key={group.id}
          className="card flex flex-col gap-2"
          data-testid={`group-${group.id}`}
        >
          <div>
            <h2 className="text-sm font-semibold">{group.label}</h2>
            <p className="text-xs text-ink-muted">{group.description}</p>
          </div>
          <Separator />
          <ul className="flex flex-col">
            {group.providers.map((provider) => (
              <li
                key={provider.id}
                className="flex items-center justify-between gap-3 rounded-sm px-2 py-1.5 hover:bg-raised"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-xs text-ink">{provider.label}</span>
                  <Badge tone={statusTone(provider)}>{statusLabel(provider)}</Badge>
                  <span className="shrink-0 text-[10px] text-ink-faint">
                    {provider.modelCount} models
                  </span>
                </div>
                <Button
                  size="sm"
                  onClick={() => {
                    releaseFocus();
                    setLocalSelectedId(provider.id);
                  }}
                >
                  Manage
                </Button>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <p className="text-[11px] text-ink-faint">
        Credentials live in the shared Pi profile, so anything added here also shows up in{" "}
        <code className="font-mono">pi</code> in a terminal.
      </p>

      <section className="card flex flex-col gap-2" data-testid="group-custom">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold">Custom gateways</h2>
            <p className="text-xs text-ink-muted">
              Any OpenAI-compatible endpoint, stored in Pi's{" "}
              <code className="font-mono">models.json</code>. The entry is validated with Pi before
              it is kept.
            </p>
          </div>
          <Button size="sm" onClick={() => setGatewayOpen(true)}>
            <Plus className="size-3" aria-hidden />
            Add gateway
          </Button>
        </div>
        <Separator />
        {!customProvidersLoaded ? (
          <p className="text-xs text-ink-faint">Reading models.json…</p>
        ) : customProviders.length === 0 ? (
          <p className="text-xs text-ink-faint">No custom gateways yet.</p>
        ) : (
          <ul className="flex flex-col">
            {customProviders.map((gateway) => (
              <li key={gateway.id} className="flex items-center justify-between gap-3 px-2 py-1.5">
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate text-xs text-ink">{gateway.name}</span>
                  <span className="truncate text-[10px] text-ink-faint">
                    {gateway.baseUrl ?? ""}
                  </span>
                  <Badge tone={gateway.hasApiKey ? "ok" : "neutral"}>
                    {gateway.hasApiKey ? "key stored" : "no key"}
                  </Badge>
                  <span className="shrink-0 text-[10px] text-ink-faint">
                    {gateway.modelIds.length} models
                  </span>
                </div>
                <Button
                  size="sm"
                  onClick={() => {
                    releaseFocus();
                    setLocalSelectedId(`custom:${gateway.id}`);
                  }}
                >
                  Edit
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {selected ? (
        <ProviderSheet
          provider={selected}
          onClose={() => {
            releaseFocus();
            setLocalSelectedId(null);
          }}
        />
      ) : null}

      {gatewayOpen || selectedId?.startsWith("custom:") ? (
        <CustomGatewaySheet
          gateway={customProviders.find((entry) => `custom:${entry.id}` === selectedId) ?? null}
          onClose={() => {
            setGatewayOpen(false);
            releaseFocus();
            setLocalSelectedId(null);
          }}
        />
      ) : null}
    </div>
  );
}

function ProviderSheet({ provider, onClose }: { provider: ProviderSummary; onClose: () => void }) {
  const setProviderKey = useAppStore((state) => state.setProviderKey);
  const logoutProvider = useAppStore((state) => state.logoutProvider);
  const startProviderLogin = useAppStore((state) => state.startProviderLogin);
  const revealPath = useAppStore((state) => state.info?.authFile ?? null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const submitKey = async (): Promise<void> => {
    if (key.length === 0) return;
    setBusy(true);
    setFormError(null);
    try {
      await setProviderKey(provider.id, key);
      // The key is dropped immediately: it is never kept in renderer state.
      setKey("");
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent aria-label={`${provider.label} settings`} data-testid="provider-sheet">
        <DialogTitle>{provider.label}</DialogTitle>
        <DialogDescription>
          <span className="mr-2 font-mono text-[11px] text-ink-faint">{provider.id}</span>
          <Badge tone={statusTone(provider)}>{statusLabel(provider)}</Badge>
          <span className="ml-2">{provider.modelCount} models</span>
        </DialogDescription>

        <div className="flex flex-col gap-4 px-4 pb-4">
          {provider.envVars.length > 0 ? (
            <p className="text-xs text-ink-muted">
              Environment: <code className="font-mono">{provider.envVars.join(", ")}</code>
              {provider.envAvailable ? " (set)" : ""}
            </p>
          ) : null}

          {canSignIn(provider) ? (
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-xs text-ink">Subscription</div>
                <div className="text-[11px] text-ink-faint">
                  Opens the provider's sign-in page in your browser.
                </div>
              </div>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy}
                  onClick={() => void startProviderLogin(provider.id)}
                >
                  Sign in
                </Button>
                {provider.configured ? (
                  <Button
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      void logoutProvider(provider.id).finally(() => setBusy(false));
                    }}
                  >
                    Sign out
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {canAddKey(provider) ? (
            <form
              className="flex flex-col gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void submitKey();
              }}
            >
              <div className="text-xs text-ink">API key</div>
              <div className="flex items-center gap-2">
                <input
                  type="password"
                  aria-label={`API key for ${provider.label}`}
                  autoComplete="off"
                  spellCheck={false}
                  value={key}
                  onChange={(event) => setKey(event.target.value)}
                  placeholder="Paste the key — it is written by Pi and never shown again"
                  className="min-w-0 flex-1 rounded-sm border border-line bg-transparent px-2 py-1 text-xs text-ink outline-none"
                  data-testid="provider-key-input"
                />
                <Button
                  size="sm"
                  variant="primary"
                  type="submit"
                  disabled={busy || key.length === 0}
                >
                  Save key
                </Button>
              </div>
              <p className="text-[11px] text-ink-faint">
                Write-only: the app never reads a key back, and it is stored in{" "}
                <code className="font-mono">auth.json</code> (mode 0600) through Pi.
              </p>
            </form>
          ) : null}

          {formError ? (
            <p className="text-xs text-danger" role="alert">
              {formError}
            </p>
          ) : null}

          {!canSignIn(provider) && !canAddKey(provider) ? (
            <p className="text-xs text-ink-muted">
              This provider is configured through its environment or a local server; nothing to set
              up here.
            </p>
          ) : null}

          <Separator />
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px] text-ink-faint">
              Visible to terminal Pi — same <code className="font-mono">auth.json</code>.
            </p>
            <Button
              size="sm"
              disabled={!revealPath}
              onClick={() => void window.pi?.revealPath(revealPath ?? "")}
            >
              Reveal auth.json
            </Button>
          </div>

          <div className="flex justify-end">
            <Button size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Add/edit a gateway in `models.json` (plan step 9, slice 5). The key is
 * write-only, and Pi validates the entry before the app keeps the file.
 */
function CustomGatewaySheet({
  gateway,
  onClose,
}: {
  gateway: CustomProviderSummary | null;
  onClose: () => void;
}) {
  const saveCustomProvider = useAppStore((state) => state.saveCustomProvider);
  const deleteCustomProvider = useAppStore((state) => state.deleteCustomProvider);
  const [id, setId] = useState(gateway?.id ?? "");
  const [name, setName] = useState(gateway?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(gateway?.baseUrl ?? "");
  const [api, setApi] = useState(gateway?.api ?? "openai-completions");
  const [models, setModels] = useState(gateway?.modelIds.join(", ") ?? "");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    // Pre-check with the same shared rules the host enforces, so an obviously
    // bad id is refused here with a specific message instead of costing a host
    // round trip. The host stays the authority (it validates again).
    const providerProblem = providerIdError(id);
    if (providerProblem) {
      setError(providerProblem);
      return;
    }
    const modelIds = models
      .split(",")
      .map((model) => model.trim())
      .filter((model) => model.length > 0);
    const modelProblem = modelIds.map(modelIdError).find((message) => message !== null);
    if (modelProblem) {
      setError(modelProblem);
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await saveCustomProvider({
        id: id.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
        baseUrl: baseUrl.trim(),
        ...(api.trim() ? { api: api.trim() } : {}),
        ...(apiKey.length > 0 ? { apiKey } : {}),
        models: modelIds.map((model) => ({ id: model })),
      });
      setApiKey("");
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const field =
    "min-w-0 flex-1 rounded-sm border border-line bg-transparent px-2 py-1 text-xs text-ink outline-none";

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent aria-label="Custom gateway" data-testid="gateway-sheet">
        <DialogTitle>{gateway ? `Edit ${gateway.name}` : "Add a custom gateway"}</DialogTitle>
        <DialogDescription>
          Stored in Pi's <code className="font-mono">models.json</code> and validated with Pi before
          it is kept.
        </DialogDescription>
        <form
          className="flex flex-col gap-3 px-4 pb-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="flex items-center gap-2">
            <span className="w-24 text-xs text-ink-muted">Provider id</span>
            <input
              aria-label="Provider id"
              value={id}
              disabled={gateway !== null}
              onChange={(event) => setId(event.target.value)}
              placeholder="my-gateway"
              className={field}
            />
          </label>
          <p className="text-[11px] text-ink-faint" data-testid="provider-id-hint">
            No spaces and no &quot;/&quot; — Pi splits provider/model at the first slash. Up to 64
            characters.
          </p>
          <label className="flex items-center gap-2">
            <span className="w-24 text-xs text-ink-muted">Name</span>
            <input
              aria-label="Name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className={field}
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="w-24 text-xs text-ink-muted">Base URL</span>
            <input
              aria-label="Base URL"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://gateway.example.com/v1"
              className={field}
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="w-24 text-xs text-ink-muted">API family</span>
            <input
              aria-label="API family"
              value={api}
              onChange={(event) => setApi(event.target.value)}
              className={field}
            />
          </label>
          <label className="flex items-center gap-2">
            <span className="w-24 text-xs text-ink-muted">Model ids</span>
            <input
              aria-label="Model ids"
              value={models}
              onChange={(event) => setModels(event.target.value)}
              placeholder="gpt-5, hf:deepseek-ai/DeepSeek-V4.1-Flash"
              className={field}
            />
          </label>
          <p className="text-[11px] text-ink-faint" data-testid="model-ids-hint">
            Comma-separated. An id may contain &quot;/&quot;, &quot;:&quot;, &quot;~&quot; or
            &quot;@&quot; (e.g.{" "}
            <code className="font-mono">hf:deepseek-ai/DeepSeek-V4.1-Flash</code>) — but no spaces
            and no commas, and up to 200 characters.
          </p>
          <label className="flex items-center gap-2">
            <span className="w-24 text-xs text-ink-muted">API key</span>
            <input
              aria-label="Gateway API key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={gateway?.hasApiKey ? "stored — leave blank to keep" : "optional"}
              className={field}
            />
          </label>

          {error ? (
            <p className="text-xs text-danger" role="alert">
              {error}
            </p>
          ) : null}

          <div className="flex justify-between gap-2 pt-1">
            {gateway ? (
              <Button
                size="sm"
                variant="danger"
                type="button"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void deleteCustomProvider(gateway.id).finally(() => {
                    setBusy(false);
                    onClose();
                  });
                }}
              >
                <Trash2 className="size-3" aria-hidden />
                Delete
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button size="sm" type="button" onClick={onClose}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" type="submit" disabled={busy}>
                Save
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
