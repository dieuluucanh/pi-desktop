export interface ScrollspySection {
  id: string;
  /** The section's distance from the top of the viewport at the current scroll. */
  top: number;
}

/**
 * The section whose start has passed the reading line most recently.
 *
 * The landing groups several headed blocks under one menu anchor (Features
 * contains the profile block, Installation contains download/install/updates),
 * so containment would only mark the inner block. Taking the last section whose
 * top is above the line keeps the group highlighted until the next group starts.
 */
export function pickActiveSection(
  sections: readonly ScrollspySection[],
  line: number,
): string | null {
  let active: string | null = null;
  for (const section of sections) {
    if (section.top <= line) active = section.id;
  }
  return active;
}
