/**
 * Scroll-spy for the landing page's Features/Screenshots menu entries.
 *
 * Download, Releases and Docs are marked current by the server from the path;
 * only the two in-page anchors need JavaScript. The script is a progressive
 * enhancement: without it the links still work and no nav item is marked.
 */
const links = [...document.querySelectorAll<HTMLAnchorElement>(".pi-site-nav [data-spy]")];
const sections = links
  .map((link) => document.getElementById(link.dataset.spy ?? ""))
  .filter((section): section is HTMLElement => section != null);

if (sections.length > 0) {
  let frame = 0;

  const navBottom = (): number =>
    Math.round(document.querySelector(".pi-site-nav")?.getBoundingClientRect().bottom ?? 0) + 8;

  const setCurrent = (id: string | null): void => {
    for (const link of links) {
      if (link.dataset.spy === id) link.setAttribute("aria-current", "location");
      else link.removeAttribute("aria-current");
    }
  };

  const update = (): void => {
    frame = 0;
    const line = navBottom();
    let current: string | null = null;
    for (const section of sections) {
      const rect = section.getBoundingClientRect();
      if (rect.top <= line && rect.bottom > line) current = section.id;
    }
    // Past the last watched section: keep the last one current rather than
    // clearing the highlight while the visitor reads the rest of the page.
    if (!current) {
      for (const section of sections) {
        if (section.getBoundingClientRect().top <= line) current = section.id;
      }
    }
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
