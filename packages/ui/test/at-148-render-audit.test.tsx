import React, { act } from "react";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { render, fireEvent, cleanup, within } from "@testing-library/react";
import { createDaemonServer, clearProbeCache } from "@routersync/daemon";
import {
  setupDaemonFixture,
  type DaemonFixture,
} from "../../../test/harness/daemon-fixture.js";
import {
  containsToken,
  findTokenHits,
  formatAuditLine,
  formatViolation,
  normalizeText,
  isAllowed,
  readAllowList,
  REPO_ROOT,
  type AllowList,
} from "../../../test/ui/render-audit-helpers.js";
import { ApiProvider } from "../src/api";
import { HttpApi } from "../src/api/http";
import { MockApi } from "../src/api/mock";
import { App } from "../src/App";
import { hasTranslation, setLanguage, t, type Language } from "../src/i18n";
import type { ScreenId } from "../src/components/Sidebar";
import translations from "../src/i18n/translations.json";

/**
 * AT-148 (R16-3): the render audit.
 *
 * Every other UI test in this repo looked at ONE end of the wire: the daemon
 * tests looked at raw payloads, the UI tests ran on a MockApi. A screenshot of
 * the running app then showed the shell painting hard-coded sample content
 * ("2 active · 1 preview", "416 models", "4/6 active", "3 targets") while the
 * daemon had nothing to say. The static guard AT-139 only scanned
 * `packages/ui/src/screens/**`, so the shell (top bar, sidebar, banners) was
 * never scanned either.
 *
 * This test closes the gap:
 *
 *  1. it renders the REAL `<App>` with the REAL `HttpApi` in three daemon
 *     states (`daemon_down`, `all_unavailable`, `live_fixture`) and in both
 *     languages, and prints what is actually on screen — one line per
 *     (route, state, language);
 *  2. it computes the poison set from the MockApi at runtime (no hand-written
 *     token list) and asserts that NO sample value survives in the DOM while
 *     the daemon is down or while every envelope is `unavailable`.
 *
 * The product code is owned by another agent; this file only observes it.
 */

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

type AuditState = "daemon_down" | "all_unavailable" | "live_fixture";

/** Stable state order of the printed audit. */
const STATES: readonly AuditState[] = [
  "daemon_down",
  "all_unavailable",
  "live_fixture",
];

/** Stable language order of the printed audit. */
const LANGUAGES: readonly Language[] = ["vi", "en"];

/** Every screen of the app, in the order of `ScreenId`. */
const ROUTES: readonly ScreenId[] = [
  "overview",
  "changes",
  "combos",
  "providers",
  "targets",
  "models",
  "health",
  "agents",
  "guide",
  "settings",
  "setup",
];

/** Sidebar label key per screen. `setup` has no sidebar entry. */
const NAV_KEYS: Partial<Record<ScreenId, string>> = {
  overview: "nav_overview",
  changes: "nav_changes",
  combos: "nav_combos",
  providers: "nav_providers",
  targets: "nav_targets",
  models: "nav_models",
  health: "nav_health",
  agents: "nav_agents",
  guide: "nav_guide",
  settings: "nav_settings",
};

/**
 * Ready markers per screen. A screen may render several of them depending on
 * the state, so the audit waits until ANY of them shows up.
 */
const READY_SELECTOR: Record<ScreenId, readonly string[]> = {
  overview: [
    '[data-testid="overview-unavailable"]',
    '[data-testid="metric-tile"]',
  ],
  changes: ['[data-testid="changes-empty"]', '[data-testid="plan-diff"]'],
  combos: [
    '[data-testid="combos-unavailable"]',
    '[data-testid="combos-empty-state"]',
    '[data-testid="combo-ladder"]',
    '[role="tablist"]',
  ],
  providers: ['[data-testid="providers-screen"]'],
  targets: ['[data-testid="targets-screen"]'],
  models: ['[data-testid="models-screen"]'],
  health: ['[data-testid="health-screen"]'],
  agents: ['[data-testid="agents-screen"]'],
  guide: ['[data-testid="guide-screen"]'],
  settings: ['[data-testid="settings-screen"]'],
  setup: ['[data-testid="setup-wizard-screen"]'],
};

const CATALOG = translations as unknown as {
  vi: Record<string, string>;
  en: Record<string, string>;
};

/** `node:sqlite` is only available through `createRequire` under vitest. */
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (p: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...args: unknown[]): void };
    close(): void;
  };
};

/** Where the human-readable copy of the audit is written. */
const REPORT_PATH = path.join(
  REPO_ROOT,
  "test",
  "ui",
  "render-audit-report.txt",
);

/* ------------------------------------------------------------------ *
 * DOM helpers
 * ------------------------------------------------------------------ */

/** Every text node of `root`, whitespace-normalised, in document order. */
function collectTextNodes(root: Element): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node !== null) {
    const text = normalizeText(node.nodeValue ?? "");
    if (text.length > 0) out.push(text);
    node = walker.nextNode();
  }
  return out;
}

/** Every text node of `root` that contains at least one digit. */
function collectDigitTextNodes(root: Element): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const text of collectTextNodes(root)) {
    if (/\d/.test(text) && !seen.has(text)) {
      seen.add(text);
      out.push(text);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Fetch bookkeeping — "the app has settled"
 * ------------------------------------------------------------------ */

let pendingFetches = 0;
const realFetch = globalThis.fetch;

/**
 * Counts the fetches that are in flight, so the audit can wait for the app
 * to settle instead of sleeping.
 */
function installFetchCounter(): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    pendingFetches += 1;
    return realFetch(input, init).finally(() => {
      pendingFetches -= 1;
    });
  }) as typeof fetch;
}

/**
 * Polls until `predicate` is true. A plain loop (instead of
 * `waitFor`) keeps the whole settle inside ONE `act` scope, so React does
 * not warn about a state update that happened outside of `act`.
 */
async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 10000,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `[AT-148] timed out after ${timeoutMs}ms while waiting for the app`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Waits until every fetch that was started has settled.
 *
 * The click already ran inside React's own act scope, so the effect that
 * starts the fetch has run and `pendingFetches` is already > 0. The async
 * act scope below stays open until the fetch resolves, so the state update
 * it triggers happens inside `act` as well.
 */
async function waitForSettled(): Promise<void> {
  await act(async () => {
    await waitUntil(() => pendingFetches === 0);
  });
}

/* ------------------------------------------------------------------ *
 * Navigation (same approach as at-147-i18n-runtime.test.tsx)
 * ------------------------------------------------------------------ */

/** Finds the sidebar button carrying the given translated label. */
function navButton(container: HTMLElement, label: string): HTMLElement {
  const nav = within(container).getByRole("navigation");
  const buttons = within(nav).getAllByRole("button");
  const found = buttons.find((button) => {
    const text = normalizeText(button.textContent ?? "");
    if (text === label) return true;
    // The "changes" entry carries a badge right after its label ("Changes5").
    return (
      text.startsWith(label) && /^\d+$/.test(text.slice(label.length).trim())
    );
  });
  if (!found) {
    const labels = buttons.map((b) => normalizeText(b.textContent ?? ""));
    throw new Error(
      `Sidebar has no button labelled "${label}". Found: ${labels.join(" | ")}`,
    );
  }
  return found;
}

/** Clicks the sidebar entry of a screen. `setup` is reached from the guide. */
async function openScreen(container: HTMLElement, id: ScreenId): Promise<void> {
  const key = NAV_KEYS[id];
  if (key === undefined) {
    await openScreen(container, "guide");
    fireEvent.click(
      within(container).getByRole("button", { name: t("g_open") }),
    );
  } else {
    const button = navButton(container, t(key));
    fireEvent.click(button);
    expect(
      button.getAttribute("aria-current"),
      `sidebar entry "${id}" is not active`,
    ).toBe("page");
  }
  await waitForSettled();
  await waitUntil(() =>
    READY_SELECTOR[id].some(
      (selector) => container.querySelector(selector) !== null,
    ),
  );
}

/* ------------------------------------------------------------------ *
 * The three daemon states
 * ------------------------------------------------------------------ */

/** Binds an ephemeral loopback port and closes it again -> nothing listens. */
async function reserveClosedLoopbackPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      server.close(() => resolve(address.port));
    });
  });
}

/**
 * A tiny HTTP server that answers EVERY `/api/v1/*` route with an
 * `unavailable` envelope and an empty list. This is the deterministic
 * `all_unavailable` state: the daemon IS reachable, but nothing was
 * measured, so the UI must show "-" / empty, never a sample value.
 */
async function startUnavailableServer(): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const meta = {
      source: "unavailable",
      reason: "db_not_found",
      generatedAt: new Date().toISOString(),
    };
    let body: unknown;
    switch (pathname) {
      case "/api/v1/overview":
        body = { meta };
        break;
      case "/api/v1/health":
        body = {
          meta,
          daemon: "routersync",
          status: "unavailable",
          readOnly: true,
          uptime: 0,
          routers: {},
        };
        break;
      case "/api/v1/targets":
        body = [];
        break;
      case "/api/v1/combos":
        body = { meta, combos: [] };
        break;
      case "/api/v1/providers":
        body = { meta, data: [] };
        break;
      case "/api/v1/models":
        body = { meta, data: [] };
        break;
      case "/api/v1/doctor":
        body = { meta, conditions: [] };
        break;
      default:
        body = {
          meta,
          code: "slice_s1_deferred_to_p3a",
          resource: (pathname.split("/").pop() ?? "unknown").toLowerCase(),
          data: [],
        };
        break;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/* ------------------------------------------------------------------ *
 * The poison set — computed at runtime from the MockApi
 * ------------------------------------------------------------------ */

interface SampleTokens {
  strings: string[];
  numbers: string[];
}

/** Every number of 10 or more inside a string (e.g. "… error 401 …"). */
const NUMBER_IN_TEXT = /(?<![0-9.])[0-9]+(?![0-9.])/g;

/**
 * Runs the MockApi and collects every piece of sample content it can hand
 * out: strings of 4 characters or more and numbers of 10 or more.
 *
 * The list is NEVER hand-written — it is derived from the mock itself, so a
 * new sample value in `mock.ts` is covered without touching this test.
 */
async function collectMockSampleTokens(): Promise<SampleTokens> {
  const api = new MockApi();
  const payloads = await Promise.all([
    api.getOverview(),
    api.getPipelineModules(),
    api.getHeartbeat(),
    api.getDaemonHealth(),
    api.getProviders(),
    api.getModels(),
    api.getUnmatchedNames(),
    api.getUnknownTraits(),
    api.getCombos(),
    api.getTargets(),
    api.getPendingPlan(),
    api.getSnapshots(),
    api.getHealthSummary(),
    api.getDoctor(),
  ]);

  const strings = new Set<string>();
  const numbers = new Set<string>();

  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      const text = value.trim();
      if (text.length >= 4) strings.add(text);
      const scanner = new RegExp(NUMBER_IN_TEXT.source, "g");
      let match: RegExpExecArray | null;
      while ((match = scanner.exec(text)) !== null) {
        if (Number(match[0]) >= 10) numbers.add(match[0]);
      }
      return;
    }
    if (typeof value === "number") {
      if (Number.isFinite(value) && value >= 10) numbers.add(String(value));
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value && typeof value === "object") {
      for (const item of Object.values(value)) walk(item);
    }
  };

  for (const payload of payloads) walk(payload);

  return {
    strings: [...strings].sort((a, b) => a.localeCompare(b, "en")),
    numbers: [...numbers].sort((a, b) => Number(a) - Number(b)),
  };
}

/** Pulls poison candidates out of a plain list of rendered text nodes. */
function tokensFromTexts(texts: readonly string[]): SampleTokens {
  const strings = new Set<string>();
  const numbers = new Set<string>();
  for (const raw of texts) {
    const text = raw.trim();
    if (text.length >= 4) strings.add(text);
    const scanner = new RegExp(NUMBER_IN_TEXT.source, "g");
    let match: RegExpExecArray | null;
    while ((match = scanner.exec(text)) !== null) {
      if (Number(match[0]) >= 10) numbers.add(match[0]);
    }
  }
  return {
    strings: [...strings].sort((a, b) => a.localeCompare(b, "en")),
    numbers: [...numbers].sort((a, b) => Number(a) - Number(b)),
  };
}

/**
 * R17-4: the poison set is also computed from what the MockApi actually PAINTS,
 * in Vietnamese AND in English.
 *
 * The R16 audit only walked the payload, which is language-independent, so an
 * English-only sample string ("2 min ago") never became a poison token and an
 * English leak was invisible. Rendering the app twice and collecting both DOMs
 * closes that hole.
 */
/**
 * R17-4: the sample payload in BOTH languages.
 *
 * A payload value is often a translation KEY ("ago2"), so the Vietnamese text
 * never looked like the English one and an English-only leak was invisible.
 * Every payload string that resolves through the catalog is therefore expanded
 * to its Vietnamese AND English value; numbers and plain strings are already
 * language-independent.
 */
function expandTokensWithCatalog(sample: SampleTokens): SampleTokens {
  const strings = new Set<string>(sample.strings);
  for (const value of sample.strings.slice()) {
    if (!hasTranslation(value)) continue;
    for (const lang of ["vi", "en"] as const) {
      setLanguage(lang);
      const translated = t(value);
      if (translated.length >= 4 && !translated.includes("{"))
        strings.add(translated);
    }
  }
  setLanguage("vi");
  return {
    strings: [...strings].sort((a, b) => a.localeCompare(b, "en")),
    numbers: [...sample.numbers],
  };
}

/** Cheap pre-filter + exact whole-identifier check. */
function mentions(text: string, token: string): boolean {
  return text.includes(token) && containsToken(text, token);
}

/**
 * Builds the poison token set.
 *
 * A token from the MockApi is EXEMPT when the app's own static copy (the
 * i18n catalog) says it on its own — then it is vocabulary, not sample data.
 *
 * The rule is deliberately strict: a catalog value only excuses a token when
 * it mentions THAT token and no other sample token. A value that mentions
 * several sample tokens is prototype sample copy itself (NOW.md 6b) and must
 * not excuse any of them. That is what keeps the sample provider names
 * (`nova`, `orbit`, `acme`) and the sample combo names (`coding-fast`)
 * detectable even though the catalog still mentions them somewhere.
 *
 * A number that legitimately appears in static copy (a safety cap, an HTTP
 * status, a router port) is either excused by this rule or has to be listed
 * in `test/ui/render-audit-allow.json` with a hand-written reason.
 */
function buildPoisonTokens(sample: SampleTokens, allow: AllowList): string[] {
  const catalogValues = [
    ...Object.values(CATALOG.vi),
    ...Object.values(CATALOG.en),
  ].filter((value): value is string => typeof value === "string");

  const candidates = [...sample.strings, ...sample.numbers];

  // Which candidates does every catalog value mention?
  const mentionedBy = catalogValues.map((value) =>
    candidates.filter((token) => mentions(value, token)),
  );

  const exempt = new Set<string>();
  for (const token of candidates) {
    const excused = mentionedBy.some(
      (list) => list.includes(token) && list.every((other) => other === token),
    );
    if (excused) exempt.add(token);
  }

  return candidates
    .filter((token) => !exempt.has(token))
    .filter((token, index, all) => all.indexOf(token) === index)
    .sort((a, b) => a.localeCompare(b, "en"));
}

/* ------------------------------------------------------------------ *
 * The audit run
 * ------------------------------------------------------------------ */

/** AT-156: where the status-claim vocabulary lives. */
const LEXICON_PATH = path.join(
  REPO_ROOT,
  "test",
  "ui",
  "status-claim-lexicon.json",
);

interface StatusClaimLexicon {
  tokens: string[];
  allow: Array<{ route: string; token: string; reason: string }>;
}

function readStatusClaimLexicon(): StatusClaimLexicon {
  return JSON.parse(fs.readFileSync(LEXICON_PATH, "utf8")) as StatusClaimLexicon;
}

/**
 * AT-156: which claim tokens a block of rendered text carries.
 *
 * A Vietnamese phrase is matched as a substring; an ASCII word is matched on a
 * word boundary, so "found" does not fire on "not found" inside a word such as
 * "unfounded" and, more importantly, does not fire on unrelated longer words.
 */
function scanStatusClaims(text: string, tokens: readonly string[]): string[] {
  const hits: string[] = [];
  for (const token of tokens) {
    const isAsciiWord = /^[A-Za-z][A-Za-z -]*$/.test(token);
    const found = isAsciiWord
      ? new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text)
      : text.toLowerCase().includes(token.toLowerCase());
    if (found) hits.push(token);
  }
  return hits;
}

interface AuditRow {
  route: ScreenId;
  state: AuditState;
  lang: Language;
  /** Text nodes that carry a digit (the printed audit column). */
  digitTexts: string[];
  /** Every text node of the screen (used by the poison check). */
  textNodes: string[];
}

async function runAudit(
  baseUrl: string,
  state: AuditState,
  lang: Language,
): Promise<AuditRow[]> {
  setLanguage(lang);
  const api = new HttpApi(baseUrl);
  const { container } = render(
    <ApiProvider value={api}>
      <App />
    </ApiProvider>,
  );

  await waitForSettled();
  await waitUntil(() =>
    READY_SELECTOR.overview.some(
      (selector) => container.querySelector(selector) !== null,
    ),
  );

  const rows: AuditRow[] = [];
  for (const route of ROUTES) {
    await openScreen(container, route);
    rows.push({
      route,
      state,
      lang,
      digitTexts: collectDigitTextNodes(container),
      textNodes: collectTextNodes(container),
    });
  }
  cleanup();
  return rows;
}

/* ------------------------------------------------------------------ *
 * Test suite
 * ------------------------------------------------------------------ */

describe("AT-148: render audit (real app, real HttpApi, 3 daemon states x 2 languages)", () => {
  let allow: AllowList;
  let poisonTokens: string[] = [];
  let rows: AuditRow[] = [];
  let auditLines: string[] = [];
  let daemonOverview = "";

  /* ---- fixtures ------------------------------------------------- */

  let closedPort = 0;
  let unavailableServer:
    { baseUrl: string; close: () => Promise<void> } | undefined;
  let daemon: http.Server | undefined;
  let daemonPort = 0;
  let upRouter: http.Server | undefined;
  let fixture: DaemonFixture | undefined;

  const originalMatchMedia = window.matchMedia;

  beforeAll(async () => {
    // jsdom has no `window.matchMedia`; the shell asks for the colour scheme
    // on every render. Same stub as at-147-i18n-runtime.test.tsx.
    window.matchMedia = (query: string): MediaQueryList =>
      ({
        matches: false,
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList;

    installFetchCounter();

    allow = readAllowList();

    // 1. `daemon_down`: a loopback port that nothing listens on.
    closedPort = await reserveClosedLoopbackPort();

    // 2. `all_unavailable`: a tiny server that answers every route with an
    //    `unavailable` envelope.
    unavailableServer = await startUnavailableServer();

    // 3. `live_fixture`: the real hermetic daemon on an ephemeral port.
    upRouter = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
    });
    const upServer = upRouter;
    await new Promise<void>((resolve) =>
      upServer.listen(0, "127.0.0.1", () => resolve()),
    );
    const upPort = (upRouter.address() as AddressInfo).port;

    fixture = await setupDaemonFixture({ probePorts: { nine: upPort } });
    shapeFixtureDatabases(fixture);

    clearProbeCache();
    daemon = createDaemonServer({ host: "127.0.0.1" });
    const server = daemon;
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    daemonPort = (server.address() as AddressInfo).port;

    // The raw daemon answer, kept as evidence of what the live state is.
    try {
      const res = await fetch(`http://127.0.0.1:${daemonPort}/api/v1/overview`);
      daemonOverview = await res.text();
    } catch (err) {
      daemonOverview = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }

    // 4. The poison set, computed from the MockApi at runtime.
    // 4. The sample content of the MockApi, in both languages.
    poisonTokens = buildPoisonTokens(
      expandTokensWithCatalog(await collectMockSampleTokens()),
      allow,
    );
    setLanguage("vi");

    // 5. The audit itself: 3 states x 2 languages x 10 routes.
    const baseUrls: Record<AuditState, string> = {
      daemon_down: `http://127.0.0.1:${closedPort}`,
      all_unavailable: unavailableServer.baseUrl,
      live_fixture: `http://127.0.0.1:${daemonPort}`,
    };

    const collected: AuditRow[] = [];
    for (const state of STATES) {
      for (const lang of LANGUAGES) {
        const stateRows = await runAudit(baseUrls[state], state, lang);
        collected.push(...stateRows);
      }
    }
    rows = collected;

    auditLines = rows.map((row) =>
      formatAuditLine(row.route, row.state, row.lang, row.digitTexts),
    );

    const header = [
      "# AT-148 render audit",
      "# route | state | lang | text node(s) that contain a digit",
      `# rows: ${auditLines.length}`,
      `# poison tokens: ${poisonTokens.length} (computed from the MockApi at runtime)`,
      `# daemon /api/v1/overview: ${daemonOverview}`,
      "",
    ].join("\n");

    const appendix = [
      "",
      "# poison tokens (computed from the MockApi at runtime)",
      ...poisonTokens,
      "",
    ].join("\n");

    const report = `${header}${auditLines.join("\n")}${appendix}`;
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, report, "utf8");

    // Printed so the evidence file (stdout) carries the whole audit.
    console.log(report);
  }, 900000);

  afterAll(async () => {
    window.matchMedia = originalMatchMedia;
    globalThis.fetch = realFetch;
    const server = daemon;
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    const up = upRouter;
    if (up) await new Promise<void>((resolve) => up.close(() => resolve()));
    if (unavailableServer) await unavailableServer.close();
    fixture?.restore();
  });

  afterEach(() => {
    cleanup();
    setLanguage("vi");
  });

  /* ---- the audit ------------------------------------------------ */

  it("renders every route in every state and language", () => {
    expect(rows.length).toBe(STATES.length * LANGUAGES.length * ROUTES.length);
    expect(auditLines.length).toBe(rows.length);
    // The printed order is stable: state -> language -> route.
    expect(auditLines[0]).toMatch(/^overview \| daemon_down \| vi \| /);
    expect(auditLines[auditLines.length - 1]).toMatch(
      /^setup \| live_fixture \| en \| /,
    );
  });

  it("writes the audit to test/ui/render-audit-report.txt", () => {
    const report = fs.readFileSync(REPORT_PATH, "utf8");
    for (const line of auditLines) {
      expect(report).toContain(line);
    }
  });

  /* ---- the poison rule ------------------------------------------ */

  const poisonedStates: readonly AuditState[] = [
    "daemon_down",
    "all_unavailable",
  ];

  for (const state of poisonedStates) {
    it(`paints no sample value while ${state}`, () => {
      const violations: string[] = [];
      for (const row of rows) {
        if (row.state !== state) continue;
        for (const textNode of row.textNodes) {
          for (const token of findTokenHits(textNode, poisonTokens)) {
            // R17-4: an exception is scoped to ONE route. A token excused on
            // the health ladder cannot excuse the same value on Providers.
            if (isAllowed(allow, row.route, token)) continue;
            violations.push(
              formatViolation(row.route, row.state, row.lang, token, textNode),
            );
          }
        }
      }
      expect(
        violations,
        `sample content found in the DOM while ${state}:\n${violations.join("\n")}`,
      ).toEqual([]);
    });
  }

  /* ---- positive control ----------------------------------------- */

  it("detects an ENGLISH sample token in a synthetic DOM (R17-4 positive control)", async () => {
    // R17-4: the poison set must carry ENGLISH sample content too, not only
    // the Vietnamese half of the same mock. Vietnamese text always contains a
    // diacritic in practice, so an ASCII sentence with a space is the English
    // side of the sample data.
    const englishTokens = poisonTokens.filter(
      (token) =>
        /^[\x20-\x7E]+$/.test(token) &&
        /\s/.test(token) &&
        /[A-Za-z]/.test(token),
    );
    expect(
      englishTokens.length,
      "the poison set must contain English sample content, not only Vietnamese",
    ).toBeGreaterThan(0);

    const synthetic = document.createElement("div");
    synthetic.textContent = englishTokens[0] ?? "";
    expect(findTokenHits(synthetic.textContent, poisonTokens)).toContain(
      englishTokens[0],
    );
  });

  it("detects a known poison token in a synthetic DOM (the check is not vacuous)", () => {
    const synthetic = document.createElement("div");
    synthetic.textContent = "coding-fast — 412 models, provider acme";
    const hits = findTokenHits(synthetic.textContent ?? "", poisonTokens);
    expect(hits).toContain("412");
    expect(hits.length).toBeGreaterThan(0);

    const clean = document.createElement("div");
    clean.textContent = "Daemon unreachable — no measurement";
    expect(findTokenHits(clean.textContent ?? "", poisonTokens)).toEqual([]);
  });

  /* ---- AT-156: the status-claim vocabulary ---------------------- */

  it("AT-156: paints no measured-status claim while nothing was measured", () => {
    const lexicon = readStatusClaimLexicon();
    expect(lexicon.tokens.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const row of rows) {
      if (row.state !== "daemon_down" && row.state !== "all_unavailable") continue;
      for (const node of row.textNodes) {
        for (const token of scanStatusClaims(node, lexicon.tokens)) {
          // One exception excuses one token on ONE route, with a written reason.
          if (lexicon.allow.some((a) => a.route === row.route && a.token === token)) {
            continue;
          }
          violations.push(
            `${row.route} | ${row.state} | ${row.lang} | ${token} | ${node.replace(/\s+/g, " ").slice(0, 160)}`,
          );
        }
      }
    }

    expect(
      violations,
      `status-claim violations (route | state | lang | token):\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("AT-156: the check is not vacuous (a synthetic status claim is caught)", () => {
    const lexicon = readStatusClaimLexicon();

    // The exact shape the owner saw on the real screenshot: a tick next to a
    // target name. It must be caught, and it must be caught only when it is
    // really there.
    const claimed = document.createElement("div");
    claimed.textContent = "✓ OmniRoute";
    expect(scanStatusClaims(claimed.textContent ?? "", lexicon.tokens)).toContain("✓");

    const scanned = document.createElement("div");
    scanned.textContent = "RouterSync đã tìm thấy 3 nơi trên máy bạn.";
    expect(scanStatusClaims(scanned.textContent ?? "", lexicon.tokens)).toContain(
      "đã tìm thấy",
    );

    const clean = document.createElement("div");
    clean.textContent = "Chưa dò được nơi áp dụng nào trên máy này.";
    expect(scanStatusClaims(clean.textContent ?? "", lexicon.tokens)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Fixture shaping — the temp databases of the harness, never a real router
 * ------------------------------------------------------------------ */

const BIG_MODELS = Array.from(
  { length: 60 },
  (_, i) => `m${String(i + 1).padStart(2, "0")}`,
);
const SMALL_MODELS = ["m59", "m60", "m61"];
const OMNI_MODELS = ["omni-only-model"];

/**
 * Writes a real-router-shaped set of combos into the THROWAWAY databases the
 * harness hands over (same pattern as at-145-daemon-ui-roundtrip.test.tsx).
 * A real router DB is never touched.
 */
function shapeFixtureDatabases(target: DaemonFixture): void {
  const nineDb = new DatabaseSync(target.nineDbPath);
  try {
    nineDb.exec(`DELETE FROM combos;`);
    const now = new Date().toISOString();
    const insert = nineDb.prepare(
      `INSERT INTO combos (id, name, kind, models, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insert.run(
      "routersync-big",
      "Big Combo",
      "managed",
      JSON.stringify(BIG_MODELS),
      now,
      now,
    );
    insert.run(
      "routersync-small",
      "Small Combo",
      "custom",
      JSON.stringify(SMALL_MODELS),
      now,
      now,
    );
    nineDb.prepare("UPDATE settings SET data = ? WHERE id = 1").run(
      JSON.stringify({
        theme: "dark",
        port: 20128,
        comboStrategies: {
          "Big Combo": "priority",
          "Small Combo": { fallbackStrategy: "fallback" },
        },
      }),
    );
  } finally {
    nineDb.close();
  }

  const omniDb = new DatabaseSync(target.omniDbPath);
  try {
    omniDb.exec(`DELETE FROM combos;`);
    omniDb.exec(
      `INSERT INTO combos (id, name, data) VALUES ('routersync-omni', 'Omni Combo', ` +
        `'{"strategy":"priority","models":${JSON.stringify(JSON.stringify(OMNI_MODELS))},"managed":true}');`,
    );
  } finally {
    omniDb.close();
  }
}
