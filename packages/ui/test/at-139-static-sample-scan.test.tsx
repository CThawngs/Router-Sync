import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * AT-139 - R14 static guard, extended by R16-3.
 *
 * Rule (DECISIONS 2026-10-17-12 item 6): a screen is a pure function of its
 * view-model, so prototype sample content (model names, combo names, sample
 * numbers) lives in packages/ui/src/api/mock.ts only. No other module under
 * `packages/ui/src` may carry one of those literals.
 *
 * R16-3 widened the scope:
 *  - the scan covers EVERY `.ts` / `.tsx` file under `packages/ui/src`
 *    (the shell included), not only `src/screens/**`;
 *  - the list of forbidden literals grew with the values that the R16
 *    screenshots showed on the shell (a hard-coded chip, a hard-coded scan
 *    age, a made-up sample count, ...).
 *
 * An exemption is possible, but only per file AND per literal, and only with
 * a hand-written reason. The exemptions are printed with every failure, so
 * a hole cannot hide.
 */
const FORBIDDEN_LITERALS = [
  // --- R14 list -------------------------------------------------------
  "coding-fast",
  "free-all",
  "smart-cascade",
  "my-old-combo",
  "nova-vision",
  "claude-3-5-sonnet",
  "gpt-4o-mini",
  // R17-4: the tier labels are written with escaped middle dots so that a
  // different encoding of the same text cannot slip past the scan.
  "T1 \u00b7 API",
  "T2 \u00b7 File",
  "T3 \u00b7 SQLite",
  "4 / 4",
  "3 / 4",
  // --- R16-3 list -----------------------------------------------------
  "2 active",
  "1 preview",
  "background service alive",
  "scanned 2 min",
  "Vữa xong",
  "412",
  "4/6",
  "nova-",
  "kite",
  "zeta",
  "zenith-",
  "apex-",
  "vortex-",
  "T1 \u00b7",
  "T2 \u00b7",
  "T3 \u00b7",
  // --- R17-4 list: every provider prefix the R17 sample data uses ------
  "acme-",
  "lumen-",
  "orbit-",
];

/** Literals that must exist in the mock, so the sample data really lives there. */
const SAMPLE_LITERALS = [
  "coding-fast",
  "free-all",
  "smart-cascade",
  "my-old-combo",
  "nova-vision",
] as const;

/**
 * The only holes the guard allows. Every entry names the file (relative to
 * `packages/ui/src`), the literal and a hand-written reason.
 */
const FILE_EXEMPTIONS: ReadonlyArray<{
  file: string;
  literal: string;
  reason: string;
}> = [
  {
    file: path.join("screens", "CombosScreen.tsx"),
    literal: "kite",
    reason:
      "Internal id of the UI-0 simulation toggle (SimState). The text the user sees comes from the i18n key ui0_sim_kite, not from this identifier.",
  },
];

const testDir = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(testDir, "..", "src");
const screensDir = path.join(srcDir, "screens");
const mockFile = path.join(srcDir, "api", "mock.ts");
const i18nCatalog = path.join(srcDir, "i18n", "translations.json");

interface Hit {
  file: string;
  line: number;
  literal: string;
  text: string;
}

function listFiles(dir: string, keep: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, keep));
    else if (keep(full)) out.push(full);
  }
  return out;
}

/** Scans a text for the forbidden literals. */
function scanText(file: string, text: string): Hit[] {
  const hits: Hit[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    for (const literal of FORBIDDEN_LITERALS) {
      if (raw.includes(literal)) {
        hits.push({ file, line: index + 1, literal, text: raw.trim() });
      }
    }
  });
  return hits;
}

function scan(file: string): Hit[] {
  return scanText(file, fs.readFileSync(file, "utf8"));
}

/** True when the hit is covered by a hand-written exemption. */
function isExempted(hit: Hit): boolean {
  const relative = path.relative(srcDir, hit.file);
  return FILE_EXEMPTIONS.some(
    (entry) => entry.file === relative && entry.literal === hit.literal,
  );
}

function report(hits: Hit[]): string {
  if (hits.length === 0) return "no hit";
  return hits
    .map(
      (h) =>
        `${path.relative(srcDir, h.file)}:${h.line} contains "${h.literal}" -> ${h.text}`,
    )
    .join("\n");
}

function exemptionReport(): string {
  return FILE_EXEMPTIONS.map(
    (e) => `${e.file} / "${e.literal}": ${e.reason}`,
  ).join("\n");
}

describe("AT-139: prototype sample data lives in api/mock.ts, not in the app", () => {
  it("no .tsx file under src/screens/ contains a prototype sample literal", () => {
    const files = listFiles(screensDir, (f) => f.endsWith(".tsx"));
    expect(files.length).toBeGreaterThan(0);
    const hits = files.flatMap(scan).filter((hit) => !isExempted(hit));
    expect(
      hits.length,
      `${report(hits)}\n\nexemptions:\n${exemptionReport()}`,
    ).toBe(0);
  });

  it("the sample data really lives in api/mock.ts", () => {
    const content = fs.readFileSync(mockFile, "utf8");
    for (const literal of SAMPLE_LITERALS) {
      expect(
        content.includes(literal),
        `${literal} must exist in packages/ui/src/api/mock.ts`,
      ).toBe(true);
    }
  });

  it("no other module under src/ (outside screens/ and the i18n catalog) contains a literal", () => {
    const files = listFiles(srcDir, (f) => {
      if (f === mockFile || f === i18nCatalog) return false;
      if (f.startsWith(screensDir + path.sep)) return false;
      return f.endsWith(".ts") || f.endsWith(".tsx");
    });
    const hits = files.flatMap(scan).filter((hit) => !isExempted(hit));
    expect(
      hits.length,
      `${report(hits)}\n\nexemptions:\n${exemptionReport()}`,
    ).toBe(0);
  });

  it("R16-3: the shell (src/components, src/api) carries no sample literal either", () => {
    // The R16 shell is outside src/screens, so this test states the R16-3
    // scope explicitly: the top bar, the sidebar and the api layer are
    // scanned for the same literals.
    const files = listFiles(srcDir, (f) => {
      if (f === mockFile || f === i18nCatalog) return false;
      return f.endsWith(".ts") || f.endsWith(".tsx");
    });
    expect(files.length).toBeGreaterThan(5);
    const hits = files.flatMap(scan).filter((hit) => !isExempted(hit));
    expect(
      hits.length,
      `${report(hits)}\n\nexemptions:\n${exemptionReport()}`,
    ).toBe(0);
  });

  it("every exemption names a hand-written reason", () => {
    for (const entry of FILE_EXEMPTIONS) {
      expect(entry.reason.trim().length).toBeGreaterThan(20);
      expect(entry.literal.trim().length).toBeGreaterThan(0);
      expect(FORBIDDEN_LITERALS).toContain(entry.literal);
    }
  });

  it("positive control: the scanner really detects a forbidden literal", () => {
    // Without this test the guard could pass for the wrong reason (an empty
    // file list, a broken path, a literal that never matches).
    const synthetic = scanText(
      path.join(srcDir, "__positive_control__.tsx"),
      [
        "const chip = '2 active · 1 preview';",
        "const count = 412;",
        'const name = "kite";',
      ].join("\n"),
    );
    const literals = synthetic.map((hit) => hit.literal);
    expect(literals).toContain("2 active");
    expect(literals).toContain("1 preview");
    expect(literals).toContain("412");
    expect(literals).toContain("kite");
    expect(synthetic.length).toBeGreaterThanOrEqual(4);

    // R17-4: the widened literals are detected too, otherwise the guard
    // could pass simply because a literal never matches anything.
    const widened = scanText(
      path.join(srcDir, "__positive_control__.tsx"),
      [
        "const a = 'acme-coder-2';",
        "const b = 'lumen-flash-2';",
        "const c = 'orbit-pro-1';",
        "const tier = `T1 \u00b7 API`;",
      ].join("\n"),
    );
    const widenedLiterals = widened.map((hit) => hit.literal);
    expect(widenedLiterals).toContain("acme-");
    expect(widenedLiterals).toContain("lumen-");
    expect(widenedLiterals).toContain("orbit-");
    expect(widenedLiterals).toContain("T1 \u00b7 API");

    // A clean file is clean.
    const clean = scanText(
      path.join(srcDir, "__positive_control__.tsx"),
      "const ok = 1;",
    );
    expect(clean.length).toBe(0);
  });
});
