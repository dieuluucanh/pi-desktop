import { describe, expect, it } from "vitest";
import { pickActiveSection } from "../src/lib/scrollspy";

const sections = [
  { id: "introduction", top: 0 },
  { id: "features", top: 1000 },
  { id: "screenshots", top: 2500 },
  { id: "installation", top: 4000 },
  { id: "faq", top: 7000 },
];

describe("landing scroll-spy", () => {
  it("picks the section whose top has passed the reading line", () => {
    expect(pickActiveSection(sections, 0)).toBe("introduction");
    expect(pickActiveSection(sections, 999)).toBe("introduction");
    expect(pickActiveSection(sections, 1000)).toBe("features");
    expect(pickActiveSection(sections, 2500)).toBe("screenshots");
    expect(pickActiveSection(sections, 7000)).toBe("faq");
    expect(pickActiveSection(sections, 9000)).toBe("faq");
  });

  it("keeps the Installation group active across its subsections", () => {
    expect(pickActiveSection(sections, 4000)).toBe("installation");
    expect(pickActiveSection(sections, 5000)).toBe("installation");
    expect(pickActiveSection(sections, 6999)).toBe("installation");
  });

  it("returns null above the first section and for an empty list", () => {
    expect(pickActiveSection(sections, -1)).toBeNull();
    expect(pickActiveSection([], 100)).toBeNull();
  });
});
