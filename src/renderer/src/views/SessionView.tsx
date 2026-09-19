import { WelcomeView } from "./WelcomeView";
import { Badge } from "../ui/badge";
import { useAppStore } from "../state/app-store";

/**
 * Session view (plan step 1 shell).
 *
 * There is no session host yet, so this view's job is to be unambiguous: with no
 * project it shows the welcome state; with a project it states where a session
 * will start and what it will inherit, and never pretends a run is possible.
 * Steps 3–6 replace the body with the transcript and the composer.
 */

export function SessionView() {
  const project = useAppStore((state) => state.project);
  const info = useAppStore((state) => state.info);

  if (!project) return <WelcomeView />;

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col justify-center gap-5 px-8">
      <div className="flex items-center gap-2">
        <h1 className="text-lg font-semibold">{project.name}</h1>
        <Badge tone="neutral">{project.path}</Badge>
      </div>

      <p className="text-sm text-ink-muted">
        This project is open. Starting a session needs the Pi host process, which is wired in step 3
        (session service) — nothing is running yet, so there is no prompt box here on purpose.
      </p>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <dt className="text-ink-faint">Pi profile</dt>
        <dd className="truncate" title={info?.profileDir}>
          {info?.profileDir ?? "unavailable"}
        </dd>
        <dt className="text-ink-faint">Bundled runtime</dt>
        <dd>{info?.runtimeSource ?? "unavailable"}</dd>
        <dt className="text-ink-faint">Session storage</dt>
        <dd>JSONL under the Pi profile, one file per session (shared with terminal Pi)</dd>
      </dl>

      {info?.runtimeProblems.length ? (
        <p className="text-xs text-warn">{info.runtimeProblems.join(" · ")}</p>
      ) : null}
    </div>
  );
}
