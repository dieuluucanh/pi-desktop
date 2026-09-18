import { describe, expect, it } from "vitest";

import {
  manifestHostsToOfficeHosts,
  manifestMatchesPiForOffice,
  manifestSourceMatchesProd,
  parseManifest,
  sourceLocationMatchesHostedProd,
  sourceLocationMatchesPiForOffice,
} from "../../src/main/office/manifest";
import { fixtureText } from "./helpers";

const PI_MANIFEST = fixtureText("manifest.pi-for-office.xml");
const FOREIGN_MANIFEST = fixtureText("manifest.foreign.xml");

describe("parseManifest", () => {
  it("extracts the Pi for Office identity", () => {
    const manifest = parseManifest(PI_MANIFEST);
    expect(manifest.id).toBe("BC61CAF2-821A-47FD-9D6A-9D96C8F852FE");
    expect(manifest.displayName).toBe("Pi for Office");
    expect(manifest.version).toBe("1.0.0.0");
    expect(manifest.providerName).toBe("Pi for Office");
    expect(manifest.hosts).toEqual(["Workbook", "Document", "Presentation"]);
    expect(manifest.sourceLocations).toContain(
      "https://dieuluucanh.github.io/pi-for-office/src/taskpane.html",
    );
  });

  it("deduplicates source locations declared twice", () => {
    const manifest = parseManifest(PI_MANIFEST);
    expect(manifest.sourceLocations).toHaveLength(1);
  });

  it("survives malformed input", () => {
    const manifest = parseManifest("not xml at all");
    expect(manifest).toEqual({
      id: null,
      displayName: null,
      version: null,
      providerName: null,
      sourceLocations: [],
      hosts: [],
    });
  });
});

describe("manifestMatchesPiForOffice", () => {
  it("matches on the add-in id", () => {
    expect(manifestMatchesPiForOffice(parseManifest(PI_MANIFEST))).toBe(true);
  });

  it("matches case-insensitively with braces", () => {
    const xml = PI_MANIFEST.replace(
      "<Id>BC61CAF2-821A-47FD-9D6A-9D96C8F852FE</Id>",
      "<Id>{bc61caf2-821a-47fd-9d6a-9d96c8f852fe}</Id>",
    );
    expect(manifestMatchesPiForOffice(parseManifest(xml))).toBe(true);
  });

  it("matches a dev manifest that only points at a local pi-for-office task pane", () => {
    const xml = FOREIGN_MANIFEST.replace(
      "https://contoso.example.com/taskpane.html",
      "https://localhost:3141/pi-for-office/src/taskpane.html",
    );
    expect(manifestMatchesPiForOffice(parseManifest(xml))).toBe(true);
  });

  it("rejects unrelated add-ins", () => {
    const manifest = parseManifest(FOREIGN_MANIFEST);
    expect(manifestMatchesPiForOffice(manifest)).toBe(false);
    expect(manifestSourceMatchesProd(manifest)).toBe(false);
  });
});

describe("sourceLocationMatchesHostedProd", () => {
  it("accepts the hosted task pane", () => {
    expect(
      sourceLocationMatchesHostedProd(
        "https://dieuluucanh.github.io/pi-for-office/src/taskpane.html",
      ),
    ).toBe(true);
  });

  it("rejects other paths on a known host", () => {
    expect(sourceLocationMatchesHostedProd("https://dieuluucanh.github.io/other-app/")).toBe(false);
  });

  it("rejects unknown hosts", () => {
    expect(sourceLocationMatchesHostedProd("https://evil.example.com/pi-for-office/")).toBe(false);
  });

  it("rejects non-URLs", () => {
    expect(sourceLocationMatchesHostedProd("not a url")).toBe(false);
  });
});

describe("sourceLocationMatchesPiForOffice", () => {
  it("is loose about a local dev task pane but strict about prod", () => {
    const devUrl = "https://localhost:3141/pi-for-office/src/taskpane.html";
    expect(sourceLocationMatchesPiForOffice(devUrl)).toBe(true);
    expect(sourceLocationMatchesHostedProd(devUrl)).toBe(false);
  });

  it("still rejects unrelated localhost apps", () => {
    expect(sourceLocationMatchesPiForOffice("https://localhost:3141/index.html")).toBe(false);
  });
});

describe("manifestHostsToOfficeHosts", () => {
  it("maps Office host names to office hosts", () => {
    expect(manifestHostsToOfficeHosts(parseManifest(PI_MANIFEST))).toEqual([
      "excel",
      "word",
      "powerpoint",
    ]);
  });

  it("returns only declared hosts", () => {
    expect(manifestHostsToOfficeHosts(parseManifest(FOREIGN_MANIFEST))).toEqual(["excel"]);
  });
});
