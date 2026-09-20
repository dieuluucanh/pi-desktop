import { useEffect } from "react";
import { useAppStore } from "../state/app-store";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";

/**
 * Skills and prompt templates browser (plan step 15).
 *
 * Skills show their description and license state and run by inserting
 * `/skill:<name>` into the active session's composer (arguments are the user's
 * to supply, so the command is inserted, not sent). Prompt templates show
 * their argument hints and insert `/name` the same way. Enable/disable stays
 * in the Extensions hub — this view is for discovery and running.
 */
export function SkillsSection() {
  const resources = useAppStore((state) => state.resources);
  const resourcesLoaded = useAppStore((state) => state.resourcesLoaded);
  const loadResources = useAppStore((state) => state.loadResources);
  const runSkill = useAppStore((state) => state.runSkill);
  const setDraft = useAppStore((state) => state.setDraft);
  const activeTabId = useAppStore((state) => state.activeTabId);
  const tabs = useAppStore((state) => state.tabs);
  const setView = useAppStore((state) => state.setView);

  useEffect(() => {
    void loadResources();
  }, [loadResources]);

  const skills = resources.resources.filter((entry) => entry.kind === "skills");
  const prompts = resources.resources.filter((entry) => entry.kind === "prompts");

  const insertCommand = (command: string): void => {
    const active = tabs.find((tab) => tab.id === activeTabId);
    if (!active || active.kind !== "session") {
      setView("skills");
      return;
    }
    setDraft(active.id, `${command} `);
    setView("session");
  };

  return (
    <>
      <section className="card flex flex-col gap-2" data-testid="skills">
        <div>
          <h2 className="text-sm font-semibold">Skills</h2>
          <p className="text-xs text-ink-muted">
            Run inserts <code className="font-mono">/skill:name</code> into the composer — the SDK
            expands it when sent.
          </p>
        </div>
        <Separator />
        {!resourcesLoaded ? (
          <p className="text-xs text-ink-faint">Reading skills from Pi…</p>
        ) : skills.length === 0 ? (
          <p className="text-xs text-ink-faint">No skills loaded.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {skills.map((skill) => (
              <li
                key={skill.id}
                className="flex items-center justify-between gap-3 rounded-sm border border-line px-3 py-2"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-ink">
                    {skill.name}
                    {!skill.enabled ? <Badge tone="warn">disabled</Badge> : null}
                    {skill.disableModelInvocation ? (
                      <Badge tone="neutral">explicit only</Badge>
                    ) : null}
                  </span>
                  {skill.description ? (
                    <span className="text-xs text-ink-muted">{skill.description}</span>
                  ) : null}
                  <span className="truncate font-mono text-[10px] text-ink-faint">
                    {skill.source} · {skill.path}
                  </span>
                </div>
                <Button size="sm" disabled={!skill.enabled} onClick={() => runSkill(skill.name)}>
                  Run
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="card flex flex-col gap-2" data-testid="prompts">
        <div>
          <h2 className="text-sm font-semibold">Prompt templates</h2>
          <p className="text-xs text-ink-muted">
            Invokable as <code className="font-mono">/name</code> with the arguments shown.
          </p>
        </div>
        <Separator />
        {!resourcesLoaded ? (
          <p className="text-xs text-ink-faint">Reading templates from Pi…</p>
        ) : prompts.length === 0 ? (
          <p className="text-xs text-ink-faint">No prompt templates loaded.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {prompts.map((prompt) => (
              <li
                key={prompt.id}
                className="flex items-center justify-between gap-3 rounded-sm border border-line px-3 py-2"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="flex flex-wrap items-center gap-1.5 text-xs font-medium text-ink">
                    /{prompt.name}
                    {!prompt.enabled ? <Badge tone="warn">disabled</Badge> : null}
                    {prompt.argumentHint ? (
                      <Badge tone="accent">{prompt.argumentHint}</Badge>
                    ) : null}
                  </span>
                  {prompt.description ? (
                    <span className="text-xs text-ink-muted">{prompt.description}</span>
                  ) : null}
                </div>
                <Button
                  size="sm"
                  disabled={!prompt.enabled}
                  onClick={() => insertCommand(`/${prompt.name}`)}
                >
                  Insert
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
