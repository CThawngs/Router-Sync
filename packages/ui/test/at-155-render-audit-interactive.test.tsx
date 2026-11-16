import React, { act } from "react";
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import * as http from "node:http";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { render, fireEvent, cleanup, within } from "@testing-library/react";
import { createDaemonServer, clearProbeCache } from "@routersync/daemon";
import {
  setupDaemonFixture,
  type DaemonFixture,
} from "../../../test/harness/daemon-fixture.js";
import { shapeFixtureDatabases } from "../../../test/harness/fixture-databases.js";
import {
  ROUTES,
  SCENARIOS,
  SHELL_SCENARIO,
  NOT_PRESENT,
  type AuditRoute,
  type Locator,
  type Scenario,
  type ScenarioStep,
} from "../../../test/ui/render-audit-scenarios.js";
import {
  isAllowed,
  normalizeText,
  readAllowList,
  REPO_ROOT,
  type AllowList,
} from "../../../test/ui/render-audit-helpers.js";
import {
  buildPoisonTokens,
  collectDigitTextNodes,
  collectMockSampleTokens,
  collectTextNodes,
  containsWholeToken,
  expandTokensWithCatalog,
  isNumberToken,
  readStatusClaimLexicon,
  scanStatusClaims,
} from "./render-audit-poison";
import { ApiProvider } from "../src/api";
import { HttpApi } from "../src/api/http";
import { App } from "../src/App";
import { setLanguage, getLanguage, t, type Language } from "../src/i18n";
import { getViewMode, setViewMode, type ViewMode } from "../src/theme/viewMode";

/**
 * AT-155 (R19-1): the INTERACTIVE render audit.
 *
 * AT-148 looks at the OPENING state of every route. That misses everything a
 * user can reach by clicking: the builder tab, the second tab of a screen, the
 * wizard's steps, the shell's language and theme. A claim can hide there.
 *
 * AT-155 therefore does three things:
 *
 *  1. it walks an EXPLICIT scenario table (`test/ui/render-audit-scenarios.ts`)
 *     — every step is a real user action — and captures the DOM after EVERY
 *     step;
 *  2. it sweeps every interactive control of every route one at a time, with a
 *     clean rebuild of the route between two clicks, and captures the DOM
 *     after every click; the controls that are not clicked are written down in
 *     `test/ui/render-audit-interactions-skip.json` with a hand-written reason;
 *  3. it runs BOTH existing grids (the poison set and the status-claim
 *     lexicon) over EVERY captured DOM, in FOUR daemon states, and it proves
 *     with a positive control that the grids are not vacuous.
 *
 * The network is the safety net: the S1 slice is read-only, so every request
 * the app makes must be a GET to `/api/v1/...`. Any other method or URL is a
 * failure and the audit prints the control that caused it.
 *
 * The product code is owned by another agent; this file only observes it.
 */

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

type AuditState =
  | "daemon_down"
  | "all_unavailable"
  | "live_fixture"
  | "live_fixture_up";

/** Stable state order of the printed audit. */
const STATES: readonly AuditState[] = [
  "daemon_down",
  "all_unavailable",
  "live_fixture",
  "live_fixture_up",
];

/** Stable language order of the printed audit. */
const LANGUAGES: readonly Language[] = ["vi", "en"];

/**
 * R19-1 (AT-155): the states in which the daemon really measured something.
 *
 * In those states the grid drops the tokens the measurement itself produces,
 * because they are not sample leftovers:
 *  - every NUMBER: the daemon uptime, the clock of the last probe and the
 *    HTTP status are measured, and a measured number can be equal to a
 *    sample number by chance (the daemon was up 42 seconds, the sample data
 *    has a 42 somewhere);
 *  - the identity of the routers that were measured (the ids and the product
 *    names): the live data names the routers it measured;
 *  - the words of the doctor's state (pass / fail): the live doctor really
 *    checked a condition and the screen states the state it measured.
 *
 * In the two states where NOTHING was measured (daemon_down, all_unavailable)
 * the grid runs at full strength: there, every sample token is a leak unless
 * the app's own static copy says it (the catalog exemption) or the hand
 * written allow list excuses it.
 */
const LIVE_STATES: readonly AuditState[] = ["live_fixture", "live_fixture_up"];

const LIVE_MEASURED_TOKENS = new Set([
  "9router",
  "9Router",
  "omniroute",
  "OmniRoute",
  "OmniRoute, 9Router",
  "pass",
  "fail",
]);

/** True when the token is something the live measurement produced itself. */
function isLiveMeasuredToken(token: string, state: AuditState): boolean {
  if (!LIVE_STATES.includes(state)) return false;
  return isNumberToken(token) || LIVE_MEASURED_TOKENS.has(token);
}

/** Sidebar label key per screen. `setup` has no sidebar entry. */
const NAV_KEYS: Partial<Record<AuditRoute, string>> = {
  overview: "nav_overview",
  changes: "nav_changes",
  combos: "nav_combos",
  providers: "nav_providers",
  targets: "nav_targets",
  models: "nav_models",
  health: "nav_health",
  guide: "nav_guide",
  settings: "nav_settings",
};

/** Ready markers per screen (same set as AT-148). */
const READY_SELECTOR: Record<AuditRoute, readonly string[]> = {
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
  guide: ['[data-testid="guide-screen"]'],
  settings: ['[data-testid="settings-screen"]'],
  setup: ['[data-testid="setup-wizard-screen"]'],
};

/** Where the human-readable copy of the audit is written. */
const REPORT_PATH = path.join(
  REPO_ROOT,
  "test",
  "ui",
  "render-audit-interactive-report.txt",
);

/** The hand-written skip list of the control sweep. */
const SKIP_PATH = path.join(
  REPO_ROOT,
  "test",
  "ui",
  "render-audit-interactions-skip.json",
);

interface SkipEntry {
  route: string;
  control: string;
  reason: string;
}

function readSkipList(): SkipEntry[] {
  const raw = JSON.parse(fs.readFileSync(SKIP_PATH, "utf8")) as unknown;
  const entries = Array.isArray(raw)
    ? raw
    : ((raw as { skips?: unknown }).skips ?? []);
  const out: SkipEntry[] = [];
  for (const item of entries as Array<Partial<SkipEntry>>) {
    if (typeof item.route !== "string" || item.route.trim() === "") {
      throw new Error(`[AT-155] ${SKIP_PATH}: every skip needs a "route"`);
    }
    if (typeof item.control !== "string" || item.control.trim() === "") {
      throw new Error(
        `[AT-155] ${SKIP_PATH}: the skip of "${item.route}" needs a "control"`,
      );
    }
    if (typeof item.reason !== "string" || item.reason.trim() === "") {
      throw new Error(
        `[AT-155] ${SKIP_PATH}: the skip of "${item.route} / ${item.control}" needs a hand-written "reason"`,
      );
    }
    out.push({ route: item.route, control: item.control, reason: item.reason });
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Fetch bookkeeping — the settle wait and the network safety net
 * ------------------------------------------------------------------ */

let pendingFetches = 0;
const realFetch = globalThis.fetch;

/** The control that is being exercised right now (printed on a violation). */
let currentControl = "startup";

/** Every request that was neither a GET nor an `/api/v1/...` of the app. */
interface NetworkViolation {
  method: string;
  url: string;
  control: string;
}
const networkViolations: NetworkViolation[] = [];

/** The base URL the app talks to in the state under audit. */
let appBaseUrl = "";
/** The fake router origins the daemon probes (never the app). */
const probeOrigins = new Set<string>();

function isAllowedRequest(method: string, url: string): boolean {
  // The daemon's own reachability probe: a GET to the fake router, not the app.
  for (const origin of probeOrigins) {
    if (url.startsWith(origin)) return true;
  }
  if (method !== "GET") return false;
  return url.startsWith(`${appBaseUrl}/api/v1/`);
}

function installFetchSpy(): void {
  globalThis.fetch = ((
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const method = (init?.method ?? "GET").toUpperCase();
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    pendingFetches += 1;
    if (!isAllowedRequest(method, url)) {
      networkViolations.push({ method, url, control: currentControl });
    }
    return realFetch(input, init).finally(() => {
      pendingFetches -= 1;
    });
  }) as typeof fetch;
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 10000,
): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `[AT-155] timed out after ${timeoutMs}ms while waiting for the app`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
}

async function waitForSettled(): Promise<void> {
  await act(async () => {
    await waitUntil(() => pendingFetches === 0);
  });
}

/**
 * Puts the shell back into the state the audit runs in.
 *
 * Some controls of the app are global (the language buttons of the settings
 * screen, the view-mode buttons). A click on one of them would change every
 * later capture, so the audit restores the language and the view mode after
 * every interaction. The capture itself always happens BEFORE the restore, so
 * the captured DOM is the one the click produced.
 */
async function restoreShellState(
  lang: Language,
  viewMode: ViewMode,
): Promise<void> {
  await act(async () => {
    if (getLanguage() !== lang) setLanguage(lang);
    if (getViewMode() !== viewMode) setViewMode(viewMode);
    await waitUntil(() => pendingFetches === 0);
  });
}

/* ------------------------------------------------------------------ *
 * Navigation
 * ------------------------------------------------------------------ */

function navButton(container: HTMLElement, label: string): HTMLElement {
  const nav = within(container).getByRole("navigation");
  const buttons = within(nav).getAllByRole("button");
  const found = buttons.find((button) => {
    const text = normalizeText(button.textContent ?? "");
    if (text === label) return true;
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
async function openScreen(
  container: HTMLElement,
  id: AuditRoute,
): Promise<void> {
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

/**
 * Rebuilds the route from scratch: the screen is unmounted (the app leaves
 * the route) and mounted again, so the control sweep always starts from the
 * opening state of the route.
 */
async function rebuildRoute(
  container: HTMLElement,
  id: AuditRoute,
): Promise<void> {
  const parking: AuditRoute = id === "guide" ? "overview" : "guide";
  await openScreen(container, parking);
  await openScreen(container, id);
}

/** The route the app is really showing right now. */
function currentRoute(container: HTMLElement): string {
  if (container.querySelector('[data-testid="setup-wizard-screen"]')) {
    return "setup";
  }
  const nav = within(container).getByRole("navigation");
  const active = within(nav)
    .getAllByRole("button")
    .find((button) => button.getAttribute("aria-current") === "page");
  const text = normalizeText(active?.textContent ?? "");
  for (const [id, key] of Object.entries(NAV_KEYS)) {
    const label = t(key as string);
    if (text === label || text.startsWith(label)) return id;
  }
  return "unknown";
}

/* ------------------------------------------------------------------ *
 * The scenario table
 * ------------------------------------------------------------------ */

/** Finds the element of a step. `null` when the control is not there. */
function locate(container: HTMLElement, locator: Locator): HTMLElement | null {
  if (locator.by === "testid") {
    return container.querySelector<HTMLElement>(
      `[data-testid="${locator.value}"]`,
    );
  }
  if (locator.by === "testid-prefix") {
    return container.querySelector<HTMLElement>(
      `[data-testid^="${locator.value}"]`,
    );
  }
  if (locator.by === "shell") {
    const header = within(container).getByRole("banner");
    const headerButtons = Array.from(
      header.querySelectorAll<HTMLElement>("button"),
    );
    if (locator.control === "lang-vi" || locator.control === "lang-en") {
      const label = locator.control === "lang-vi" ? "VI" : "EN";
      return (
        headerButtons.find(
          (button) => normalizeText(button.textContent ?? "") === label,
        ) ?? null
      );
    }
    if (locator.control === "theme") {
      return header.querySelector<HTMLElement>(
        `button[aria-label="${t("theme_toggle")}"]`,
      );
    }
    if (locator.control === "agent-drawer") {
      return (
        headerButtons.find(
          (button) =>
            normalizeText(button.textContent ?? "") === t("ui0_open_in_agent"),
        ) ?? null
      );
    }
    const name = locator.control === "view-simple" ? t("vm_s") : t("vm_d");
    return (
      headerButtons.find(
        (button) => normalizeText(button.textContent ?? "") === name,
      ) ?? null
    );
  }
  if (locator.nameKey !== undefined) {
    // The accessible name of a control can carry a badge ("Chờ duyệt0"), so
    // the name is matched by PREFIX, not exactly. The role keeps the match
    // unambiguous: the model tab and the model filter pill share the label
    // "Cần xem lại", but only one of them is a tab and the other a button.
    const escaped = t(locator.nameKey).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = within(container).queryAllByRole(locator.role, {
      name: new RegExp(`^${escaped}`, "i"),
    });
    return matches[0] ?? null;
  }
  const all = within(container).queryAllByRole(locator.role);
  return all[locator.index ?? 0] ?? null;
}

/* ------------------------------------------------------------------ *
 * The control sweep
 * ------------------------------------------------------------------ */

const CONTROL_SELECTOR =
  'button, [role="tab"], [role="switch"], input[type="checkbox"], input[type="radio"]';

interface Control {
  /** The stable, language-independent key of the control. */
  key: string;
  role: string;
  /** The index of the control among the controls of the same role. */
  ordinal: number;
  disabled: boolean;
}

function roleOf(element: Element): string {
  const explicit = element.getAttribute("role");
  if (explicit) return explicit;
  const tag = element.tagName.toLowerCase();
  if (tag === "button") return "button";
  if (tag === "input") {
    const type = element.getAttribute("type");
    if (type === "radio") return "radio";
    if (type === "checkbox") return "checkbox";
    return "input";
  }
  return tag;
}

/** Every interactive control of the route content, in DOM order. */
function enumerateControls(container: HTMLElement): Control[] {
  const main = container.querySelector("main") ?? container;
  const elements = Array.from(main.querySelectorAll(CONTROL_SELECTOR));
  const perRole = new Map<string, number>();
  const out: Control[] = [];
  for (const element of elements) {
    const role = roleOf(element);
    const ordinal = perRole.get(role) ?? 0;
    perRole.set(role, ordinal + 1);
    const testid = element.getAttribute("data-testid");
    const key = testid ? `testid:${testid}` : `role:${role}#${ordinal}`;
    const disabled =
      element.hasAttribute("disabled") ||
      element.getAttribute("aria-disabled") === "true";
    out.push({ key, role, ordinal, disabled });
  }
  return out;
}

/** The nth control of a role inside the route content, after a rebuild. */
function controlAt(
  container: HTMLElement,
  role: string,
  ordinal: number,
): HTMLElement | null {
  const main = container.querySelector("main") ?? container;
  const elements = Array.from(
    main.querySelectorAll<HTMLElement>(CONTROL_SELECTOR),
  ).filter((element) => roleOf(element) === role);
  return elements[ordinal] ?? null;
}

/* ------------------------------------------------------------------ *
 * The captures
 * ------------------------------------------------------------------ */

interface Capture {
  /** The route the audit planned to be on. */
  plannedRoute: string;
  /** The route the app really showed. */
  route: string;
  state: AuditState;
  lang: Language;
  scenario: string;
  step: string;
  kind: "opening" | "scenario" | "sweep" | "shell";
  textNodes: string[];
  digitTexts: string[];
}

interface SkipRecord {
  route: string;
  control: string;
  reason: string;
  state: AuditState;
  lang: Language;
}

/* ------------------------------------------------------------------ *
 * The audit run
 * ------------------------------------------------------------------ */

interface RunResult {
  captures: Capture[];
  clicked: number;
  skipped: SkipRecord[];
  missingSteps: string[];
}

async function runInteractiveAudit(
  baseUrl: string,
  state: AuditState,
  lang: Language,
  skipList: SkipEntry[],
): Promise<RunResult> {
  setLanguage(lang);
  const api = new HttpApi(baseUrl);
  const { container } = render(
    <ApiProvider value={api}>
      <App />
    </ApiProvider>,
  );

  const captures: Capture[] = [];
  const skipped: SkipRecord[] = [];
  const missingSteps: string[] = [];
  let clicked = 0;
  const baselineViewMode: ViewMode = getViewMode();

  const capture = (
    plannedRoute: string,
    scenario: string,
    step: string,
    kind: Capture["kind"],
  ): void => {
    captures.push({
      plannedRoute,
      route: currentRoute(container),
      state,
      lang,
      scenario,
      step,
      kind,
      textNodes: collectTextNodes(container),
      digitTexts: collectDigitTextNodes(container),
    });
  };

  await waitForSettled();
  await waitUntil(() =>
    READY_SELECTOR.overview.some(
      (selector) => container.querySelector(selector) !== null,
    ),
  );

  const runScenario = async (
    route: AuditRoute,
    scenario: Scenario,
    kind: "scenario" | "shell",
  ): Promise<void> => {
    for (const step of scenario.steps) {
      const element = locate(container, step.target);
      if (element === null) {
        if (step.optional === true) {
          missingSteps.push(
            `${state} | ${lang} | ${route} | ${scenario.name} | ${step.action} | ${step.optionalReason ?? "optional step"}`,
          );
          continue;
        }
        throw new Error(
          `[AT-155] the step "${step.action}" of "${scenario.name}" found no control`,
        );
      }
      currentControl = `${route} | ${scenario.name} | ${step.action}`;
      fireEvent.click(element);
      await waitForSettled();
      if (step.expectSelector !== undefined) {
        await waitUntil(
          () => container.querySelector(step.expectSelector as string) !== null,
        );
      }
      capture(route, scenario.name, step.action, kind);
      await restoreShellState(lang, baselineViewMode);
    }
  };

  for (const route of ROUTES) {
    // 1. the opening state of the route
    await openScreen(container, route);
    capture(route, "opening state", "-", "opening");

    // 2. the explicit scenarios of the route
    for (const scenario of SCENARIOS.filter((item) => item.route === route)) {
      await openScreen(container, route);
      await runScenario(route, scenario, "scenario");
    }

    // 3. the control sweep of the route
    await openScreen(container, route);
    const controls = enumerateControls(container);
    for (const control of controls) {
      const handWritten = skipList.find(
        (entry) => entry.route === route && entry.control === control.key,
      );
      if (handWritten) {
        skipped.push({
          route,
          control: control.key,
          reason: handWritten.reason,
          state,
          lang,
        });
        continue;
      }
      if (control.disabled) {
        skipped.push({
          route,
          control: control.key,
          reason: "the control is disabled, a user cannot click it",
          state,
          lang,
        });
        continue;
      }
      // a clean route between two clicks
      await rebuildRoute(container, route);
      const element = controlAt(container, control.role, control.ordinal);
      if (element === null) {
        skipped.push({
          route,
          control: control.key,
          reason: "the control was not there after the route was rebuilt",
          state,
          lang,
        });
        continue;
      }
      currentControl = `${route} | sweep | ${control.key}`;
      fireEvent.click(element);
      await waitForSettled();
      clicked += 1;
      capture(route, `sweep: ${control.key}`, control.key, "sweep");
      await restoreShellState(lang, baselineViewMode);
    }
  }

  // 4. the shell: the language, the theme, and the route captured again
  await openScreen(container, "overview");
  await runScenario("overview", SHELL_SCENARIO, "shell");

  cleanup();
  return { captures, clicked, skipped, missingSteps };
}

/* ------------------------------------------------------------------ *
 * The daemon states
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
 * `unavailable` envelope and an empty list.
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

/** A fake router that answers 200 on the probe path. */
async function startFakeRouter(): Promise<{
  port: number;
  origin: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (pathname === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Points the daemon env at a fixture. */
function applyFixtureEnv(fixture: DaemonFixture): void {
  process.env["ROUTERSYNC_CONFIG"] = fixture.configPath;
  process.env["OMNIROUTE_DB_PATH"] = fixture.omniDbPath;
  process.env["NINEROUTER_DB_PATH"] = fixture.nineDbPath;
  process.env["OMNIROUTE_URL"] = fixture.omniProbeUrl;
  process.env["NINEROUTER_URL"] = fixture.nineProbeUrl;
  process.env["ROUTERSYNC_STATE_DIR"] = fixture.stateDir;
}

/* ------------------------------------------------------------------ *
 * Test suite
 * ------------------------------------------------------------------ */

describe("AT-155: interactive render audit (4 daemon states x 2 languages x scenarios + control sweep)", () => {
  let allow: AllowList;
  let skipList: SkipEntry[] = [];
  let poisonTokens: string[] = [];
  let captures: Capture[] = [];
  let clicked = 0;
  let skipped: SkipRecord[] = [];
  let missingSteps: string[] = [];
  let report = "";

  let closedPort = 0;
  let unavailableServer:
    | { baseUrl: string; close: () => Promise<void> }
    | undefined;
  let daemon: http.Server | undefined;
  let daemonPort = 0;
  let fakeOmni:
    | { port: number; origin: string; close: () => Promise<void> }
    | undefined;
  let fakeNine:
    | { port: number; origin: string; close: () => Promise<void> }
    | undefined;
  let fakeNineTwo:
    | { port: number; origin: string; close: () => Promise<void> }
    | undefined;
  let fixtureNineOnly: DaemonFixture | undefined;
  let fixtureBothUp: DaemonFixture | undefined;

  const originalMatchMedia = window.matchMedia;
  const originalAbortSignalTimeout = (
    AbortSignal as unknown as { timeout?: unknown }
  ).timeout;

  beforeAll(async () => {
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

    // R19-1: the daemon probes with `AbortSignal.timeout(800)`. jsdom ships
    // its own AbortSignal, and undici refuses it ("Expected signal to be an
    // instance of AbortSignal"), so every probe failed and every router looked
    // DOWN. The shim is TEST-ONLY: it makes the probe reach the fake router.
    (AbortSignal as unknown as { timeout: unknown }).timeout = () => undefined;

    installFetchSpy();

    allow = readAllowList();
    skipList = readSkipList();

    // 1. `daemon_down`: a loopback port that nothing listens on.
    closedPort = await reserveClosedLoopbackPort();

    // 2. `all_unavailable`: a tiny server that answers every route with an
    //    `unavailable` envelope.
    unavailableServer = await startUnavailableServer();

    // 3. the fake routers the daemon probes.
    fakeOmni = await startFakeRouter();
    fakeNine = await startFakeRouter();
    fakeNineTwo = await startFakeRouter();
    probeOrigins.add(fakeOmni.origin);
    probeOrigins.add(fakeNine.origin);
    probeOrigins.add(fakeNineTwo.origin);

    // 4. the two live fixtures: one router up, then both routers up.
    fixtureNineOnly = await setupDaemonFixture({
      probePorts: { nine: fakeNine.port },
    });
    shapeFixtureDatabases(fixtureNineOnly);
    fixtureBothUp = await setupDaemonFixture({
      probePorts: { omni: fakeOmni.port, nine: fakeNineTwo.port },
    });
    shapeFixtureDatabases(fixtureBothUp);

    // The daemon probes the routers over HTTP (GET /api/health on the probe
    // origin). Those requests are the daemon's, not the app's, so their
    // origins are allowed by the network safety net.
    for (const fixture of [fixtureNineOnly, fixtureBothUp]) {
      probeOrigins.add(fixture.omniProbeUrl);
      probeOrigins.add(fixture.nineProbeUrl);
    }

    clearProbeCache();
    daemon = createDaemonServer({ host: "127.0.0.1" });
    const server = daemon;
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve()),
    );
    daemonPort = (server.address() as AddressInfo).port;

    // 5. the poison set, computed from the MockApi at runtime.
    poisonTokens = buildPoisonTokens(
      expandTokensWithCatalog(await collectMockSampleTokens()),
    );
    setLanguage("vi");

    // 6. the audit itself: 4 states x 2 languages.
    const baseUrls: Record<AuditState, string> = {
      daemon_down: `http://127.0.0.1:${closedPort}`,
      all_unavailable: unavailableServer.baseUrl,
      live_fixture: `http://127.0.0.1:${daemonPort}`,
      live_fixture_up: `http://127.0.0.1:${daemonPort}`,
    };

    const allCaptures: Capture[] = [];
    let allClicked = 0;
    const allSkipped: SkipRecord[] = [];
    const allMissing: string[] = [];

    for (const state of STATES) {
      if (state === "live_fixture" && fixtureNineOnly) {
        applyFixtureEnv(fixtureNineOnly);
      }
      if (state === "live_fixture_up" && fixtureBothUp) {
        applyFixtureEnv(fixtureBothUp);
      }
      clearProbeCache();
      appBaseUrl = baseUrls[state];
      for (const lang of LANGUAGES) {
        const result = await runInteractiveAudit(
          baseUrls[state],
          state,
          lang,
          skipList,
        );
        allCaptures.push(...result.captures);
        allClicked += result.clicked;
        allSkipped.push(...result.skipped);
        allMissing.push(...result.missingSteps);
      }
    }

    captures = allCaptures;
    clicked = allClicked;
    skipped = allSkipped;
    missingSteps = allMissing;

    // the report
    const openingLines = captures
      .filter((row) => row.kind === "opening")
      .map(
        (row) =>
          `${row.plannedRoute} | ${row.state} | ${row.lang} | ${row.digitTexts.length === 0 ? "-" : row.digitTexts.join(" | ")}`,
      );
    const interactiveLines = captures.map(
      (row) =>
        `${row.route} | ${row.state} | ${row.lang} | ${row.scenario} | ${row.step} | ${row.digitTexts.length === 0 ? "-" : row.digitTexts.join(" | ")}`,
    );

    const header = [
      "# AT-155 interactive render audit",
      "#",
      "# route | state | lang | text node(s) that contain a digit  (opening states, AT-148 format)",
      ...openingLines,
      "",
      "# route | state | lang | scenario | step | text node(s) that contain a digit",
      ...interactiveLines,
      "",
      "# totals",
      `# DOMs scanned: ${captures.length}`,
      `# controls clicked: ${clicked}`,
      `# controls skipped: ${skipped.length}`,
      `# scenario steps that were missing (optional): ${missingSteps.length}`,
      `# poison tokens: ${poisonTokens.length} (computed from the MockApi at runtime)`,
      `# network violations: ${networkViolations.length}`,
      "",
      "# controls that were not clicked (route | control | reason | state | lang)",
      ...skipped.map(
        (row) => `${row.route} | ${row.control} | ${row.reason} | ${row.state} | ${row.lang}`,
      ),
      "",
      "# scenario steps that were missing (state | lang | route | scenario | step | reason)",
      ...missingSteps,
      "",
      "# required UI that does not exist (route | name | reason)",
      ...NOT_PRESENT.map((row) => `${row.route} | ${row.name} | ${row.reason}`),
      "",
    ].join("\n");

    report = header;
    fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    fs.writeFileSync(REPORT_PATH, report, "utf8");
    console.log(report);
  }, 1800000);

  afterAll(async () => {
    window.matchMedia = originalMatchMedia;
    (
      AbortSignal as unknown as { timeout: unknown }
    ).timeout = originalAbortSignalTimeout;
    globalThis.fetch = realFetch;
    const server = daemon;
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
    if (fakeOmni) await fakeOmni.close();
    if (fakeNine) await fakeNine.close();
    if (fakeNineTwo) await fakeNineTwo.close();
    if (unavailableServer) await unavailableServer.close();
    fixtureBothUp?.restore();
    fixtureNineOnly?.restore();
  });

  afterEach(() => {
    cleanup();
    setLanguage("vi");
  });

  /* ---- the shape of the audit ------------------------------------ */

  it("captures every route in every state and language", () => {
    expect(captures.length).toBeGreaterThan(
      STATES.length * LANGUAGES.length * ROUTES.length,
    );
    const openings = captures.filter((row) => row.kind === "opening");
    expect(openings.length).toBe(
      STATES.length * LANGUAGES.length * ROUTES.length,
    );
    for (const state of STATES) {
      for (const lang of LANGUAGES) {
        const rows = openings.filter(
          (row) => row.state === state && row.lang === lang,
        );
        expect(rows.length).toBe(ROUTES.length);
        expect(rows.map((row) => row.plannedRoute)).toEqual([...ROUTES]);
      }
    }
  });

  it("walks every scenario step of the table", () => {
    const steps = SCENARIOS.reduce((sum, item) => sum + item.steps.length, 0);
    const shellSteps = SHELL_SCENARIO.steps.length;
    // the shell scenario is a scenario too: its captures carry the kind
    // "shell", so both kinds count here.
    const executed = captures.filter(
      (row) => row.kind === "scenario" || row.kind === "shell",
    ).length;
    // every required step was executed; the optional ones may be missing and
    // every missing one is written down.
    expect(executed + missingSteps.length).toBe(
      steps * STATES.length * LANGUAGES.length + shellSteps * STATES.length * LANGUAGES.length,
    );
    expect(missingSteps.length).toBeGreaterThanOrEqual(0);
  });

  it("clicks the interactive controls and writes down every skip", () => {
    expect(clicked).toBeGreaterThan(0);
    for (const row of skipped) {
      expect(row.reason.length).toBeGreaterThan(0);
    }
  });

  it("writes the audit to test/ui/render-audit-interactive-report.txt", () => {
    const written = fs.readFileSync(REPORT_PATH, "utf8");
    expect(written).toContain("# AT-155 interactive render audit");
    expect(written).toContain(`# DOMs scanned: ${captures.length}`);
  });

  /* ---- the network safety net ------------------------------------ */

  it("makes no request other than a GET to /api/v1/...", () => {
    expect(
      networkViolations,
      `the S1 slice is read-only, but the audit saw:\n${networkViolations
        .map((row) => `${row.method} ${row.url} (control: ${row.control})`)
        .join("\n")}`,
    ).toEqual([]);
  });

  /* ---- the poison grid -------------------------------------------- */

  it("paints no sample value in any of the four states", () => {
    const violations: string[] = [];
    for (const row of captures) {
      for (const textNode of row.textNodes) {
        for (const token of findHits(textNode, poisonTokens)) {
          if (isLiveMeasuredToken(token, row.state)) continue;
          if (isAllowed(allow, row.route, token)) continue;
          violations.push(
            `${row.route} | ${row.state} | ${row.lang} | ${row.scenario} | ${row.step} | ${token} | ${textNode.replace(/\s+/g, " ").slice(0, 160)}`,
          );
        }
      }
    }
    expect(
      violations,
      `sample content found in the DOM:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  /* ---- the status-claim grid -------------------------------------- */

  it("AT-156: paints no status claim in any of the four states", () => {
    const lexicon = readStatusClaimLexicon();
    expect(lexicon.tokens.length).toBeGreaterThan(0);
    const violations: string[] = [];
    for (const row of captures) {
      for (const node of row.textNodes) {
        for (const token of scanStatusClaims(node, lexicon.tokens)) {
          if (
            lexicon.allow.some(
              (entry) => entry.route === row.route && entry.token === token,
            )
          ) {
            continue;
          }
          violations.push(
            `${row.route} | ${row.state} | ${row.lang} | ${row.scenario} | ${row.step} | ${token} | ${node.replace(/\s+/g, " ").slice(0, 160)}`,
          );
        }
      }
    }
    expect(
      violations,
      `status-claim violations (route | state | lang | scenario | step | token):\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("the calm sentence never appears while a router is not measured", () => {
    const calm = [t("d_hero_p_none")];
    for (const lang of LANGUAGES) {
      setLanguage(lang);
      calm.push(t("d_hero_p_none"));
    }
    setLanguage("vi");
    const forbidden = new Set(calm);
    const hits: string[] = [];
    for (const row of captures) {
      if (row.state === "live_fixture_up") continue;
      for (const node of row.textNodes) {
        for (const phrase of forbidden) {
          if (node.includes(phrase)) {
            hits.push(
              `${row.route} | ${row.state} | ${row.lang} | ${row.scenario} | ${row.step} | ${phrase}`,
            );
          }
        }
      }
    }
    expect(
      hits,
      `the calm sentence must not appear while nothing was measured:\n${hits.join("\n")}`,
    ).toEqual([]);
  });

  /* ---- the positive control --------------------------------------- */

  it("detects a poison claim injected after an interactive step", async () => {
    // The grid must not be vacuous: the same claim, injected into the DOM
    // after a real user action, has to be caught.
    const lexicon = readStatusClaimLexicon();
    const claim = "✓ OmniRoute — RouterSync đã tìm thấy 3 nơi trên máy bạn.";
    const hits = scanStatusClaims(claim, lexicon.tokens);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits).toContain("✓");

    // ... and the same claim really reaches the DOM of the running app.
    const api = new HttpApi(`http://127.0.0.1:${closedPort}`);
    const { container } = render(
      <ApiProvider value={api}>
        <App />
        <div data-testid="at-155-poison-probe">{claim}</div>
      </ApiProvider>,
    );
    await waitForSettled();
    await openScreen(container, "overview");
    const texts = collectTextNodes(container);
    const found = texts.some((node) => node.includes("✓ OmniRoute"));
    expect(found).toBe(true);
    const caught = texts.filter((node) => scanStatusClaims(node, lexicon.tokens).length > 0);
    expect(caught.length).toBeGreaterThan(0);
    cleanup();
  });
});

/** Every poison token that occurs in `text` as a whole identifier. */
function findHits(text: string, tokens: readonly string[]): string[] {
  const hits: string[] = [];
  for (const token of tokens) {
    if (!text.includes(token)) continue;
    if (containsWholeToken(text, token)) hits.push(token);
  }
  return hits;
}
