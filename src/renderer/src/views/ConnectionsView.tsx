import { Button } from "../ui/button";
import { useAppStore } from "../state/app-store";

/**
 * Connections view (plan step 1 stub with real facts; full provider management
 * lands in step 9). It already answers the question users ask first — *where do
 * credentials live, and can terminal Pi see them?* — with the real paths.
 */
export function ConnectionsView() {
  const info = useAppStore((state) => state.info);

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-6 overflow-y-auto px-8 py-6">
      <header>
        <h1 className="text-lg font-semibold">Connections</h1>
        <p className="text-sm text-ink-muted">
          Providers are shared with terminal Pi: a subscription signed in through{" "}
          <code className="font-mono text-xs">/login</code>, or an API key written to{" "}
          <code className="font-mono text-xs">auth.json</code>, is immediately usable in both.
        </p>
      </header>

      <section className="card flex flex-col gap-3">
        <h2 className="text-sm font-semibold">What step 9 adds</h2>
        <ul className="list-disc pl-5 text-xs text-ink-muted">
          <li>Every provider from the model runtime, with real auth status and model counts.</li>
          <li>
            Sign in / sign out: OAuth opens the provider's page; API keys are written through the
            SDK and never rendered back.
          </li>
          <li>Custom models and gateways (models.json) plus proxy and offline toggles.</li>
        </ul>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="text-ink-faint">Credentials</dt>
          <dd className="truncate" title={info?.authFile}>
            {info?.authFile ?? "unavailable"}
          </dd>
          <dt className="text-ink-faint">Custom models</dt>
          <dd className="truncate" title={info?.modelsFile}>
            {info?.modelsFile ?? "unavailable"}
          </dd>
        </dl>
        {info?.authFile ? (
          <div>
            <Button size="sm" onClick={() => void window.pi?.revealPath(info.authFile)}>
              Reveal auth.json
            </Button>
          </div>
        ) : null}
      </section>
    </div>
  );
}
