import { pickActiveSection } from "../lib/scrollspy";

/**
 * Highlight the landing page's product-section menu entry while scrolling.
 *
 * Introduction, Features, Screenshots, Installation and FAQ are in-page
 * anchors; Docs is marked current by the server from the path. The script is a
 * progressive enhancement: without it the links still work and no nav item is
 * marked.
 *
 * It only runs when `.pi-landing` exists, so a docs heading whose slug matches
 * a section id can never clear the server-rendered Docs state.
 */
const landing = document.querySelector<HTMLElement>(".pi-landing");

if (landing) {
  const links = [...document.querySelectorAll<HTMLAnchorElement>(".pi-site-nav [data-spy]")];
  const sections = links.flatMap((link) => {
    const id = link.dataset.spy ?? "";
    const element = id ? landing.querySelector<HTMLElement>(`#${id}`) : null;
    return element ? [{ id, element }] : [];
  });

  if (sections.length > 0) {
    let frame = 0;

    // Anchor targets land at the document's scroll-padding-top (the fixed
    // header plus Starlight's 1.5rem breathing room). The reading line must sit
    // at or below that point, otherwise the section just navigated to is still
    // "above" the line and the previous menu item stays highlighted.
    const readingLine = (): number => {
      const padding = Number.parseFloat(
        getComputedStyle(document.documentElement).scrollPaddingTop,
      );
      if (Number.isFinite(padding) && padding > 0) return padding + 4;
      return (
        Math.round(document.querySelector(".pi-site-nav")?.getBoundingClientRect().bottom ?? 0) + 8
      );
    };

    const setCurrent = (id: string | null): void => {
      for (const link of links) {
        if (link.dataset.spy === id) link.setAttribute("aria-current", "location");
        else link.removeAttribute("aria-current");
      }
    };

    const update = (): void => {
      frame = 0;
      const line = readingLine();
      const current = pickActiveSection(
        sections.map(({ id, element }) => ({
          id,
          top: element.getBoundingClientRect().top,
        })),
        line,
      );
      setCurrent(current);
    };

    const schedule = (): void => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(update);
    };

    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
  }
}
