import { RELEASES_URL } from "../../site.config.mjs";

export interface PlatformCard {
  id: "windows" | "macos" | "linux";
  label: string;
  arch: string;
  status: "primary" | "beta";
  primary: { suffix: string; label: string };
  alternates: { suffix: string; label: string }[];
  note: string;
  installHref: string;
}

export const PLATFORMS: PlatformCard[] = [
  {
    id: "windows",
    label: "Windows",
    arch: "x64",
    status: "primary",
    primary: { suffix: "win-x64-setup.exe", label: "Installer (.exe)" },
    alternates: [{ suffix: "win-x64-portable.exe", label: "Portable (.exe)" }],
    note: "SmartScreen will warn on first launch: choose More info → Run anyway.",
    installHref: "/guide/getting-started/",
  },
  {
    id: "macos",
    label: "macOS",
    arch: "Apple Silicon / Intel",
    status: "beta",
    primary: { suffix: "mac-arm64.dmg", label: "Apple Silicon (.dmg)" },
    alternates: [{ suffix: "mac-x64.dmg", label: "Intel (.dmg)" }],
    note: "Unsigned and not notarized. First launch needs System Settings → Privacy & Security → Open Anyway. Updates are manual.",
    installHref: "/guide/getting-started/#installing-on-macos",
  },
  {
    id: "linux",
    label: "Linux",
    arch: "x64 / arm64",
    status: "beta",
    primary: { suffix: "linux-x86_64-appimage.AppImage", label: "AppImage (x64)" },
    alternates: [
      { suffix: "linux-amd64-deb.deb", label: ".deb (x64)" },
      { suffix: "linux-arm64-appimage.AppImage", label: "AppImage (arm64)" },
      { suffix: "linux-arm64-deb.deb", label: ".deb (arm64)" },
    ],
    note: "AppImage needs FUSE (or --appimage-extract-and-run). Install the .deb with sudo apt install ./file.deb, not dpkg -i.",
    installHref: "/guide/getting-started/#installing-on-linux",
  },
];

export const RELEASES_FALLBACK = RELEASES_URL;
