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
  type AuditRoute,
  type Locator,
  type Scenario,
} from "../../../test/ui/render-audit-scenarios.js";
import { normalizeText, REPO_ROOT } from "../../../test/ui/render-audit-helpers.js";
import {
  checkTextNodeProvenance,
  collectCatalogNumbers,
  collectDerivedNumbers,
  collectPayloadNumbers,
  extractNumberTokens,
  readNumberProvenanceAllow,
  type NumberProvenanceAllowEntry,
  type ProvenanceAuditResult,
} from "../../../test/ui/number-provenance";
import { collectTextNodes } from "./render-audit-poison";
import { ApiProvider } from "../src/api";
import { HttpApi } from "../src/api/http";
import { App } from "../src/App";
import { setLanguage, getLanguage, t, type Language } from "../src/i18n";
import { getViewMode, setViewMode, type ViewMode } from "../src/theme/viewMode";
import translations from "../src/i18n/translations.json";

/**
 * AT-159 (R20-2): Number Provenance in live states.
 *
 * Verifies that every number string (integers, ratios, decimals, timestamps) rendered
 * in live states (live_fixture and live_fixture_up) originates from:
 *   (i)   A real value in the daemon's six JSON route payloads;
 *   (ii)  A static number in the translation catalog (translations.json);
 *   (iii) An explicit, documented derived function (time formatting, uptime tolerance, ratios).
 */

type LiveAuditState = "live_fixture" | "live_fixture_up";
const LIVE_STATES: readonly LiveAuditState[] = ["live_fixture", "live_fixture_up"];
const LANGUAGES: readonly Language[] = ["vi", "en"];

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

const READY_SELECTOR: Record<AuditRoute, readonly string[]> = {
  overview: ['[data-testid="overview-unavailable"]', '[data-testid="metric-tile"]'],
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
  if (!fs.existsSync(SKIP_PATH)) return [];
  const raw = JSON.parse(fs.readFileSync(SKIP_PATH, "utf8")) as unknown;
  return Array.isArray(raw) ? raw : ((raw as { skips?: unknown }).skips as SkipEntry[]) ?? [];
}

let pendingFetches = 0;
const realFetch = globalThis.fetch;
let currentControl = "startup";

async function waitUntil(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`[AT-159] timed out after ${timeoutMs}ms while waiting`);
    }
    await new Promise((resolve) => setTimeout(resolve, 4));
  }
}

async function waitForSettled(): Promise<void> {
  await act(async () => {
    await waitUntil(() => pendingFetches === 0);
  });
}

async function restoreShellState(lang: Language, viewMode: ViewMode): Promise<void> {
  await act(async () => {
    if (getLanguage() !== lang) setLanguage(lang);
    if (getViewMode() !== viewMode) setViewMode(viewMode);
    await waitUntil(() => pendingFetches === 0);
  });
}

function navButton(container: HTMLElement, label: string): HTMLElement {
  const nav = within(container).getByRole("navigation");
  const buttons = within(nav).getAllByRole("button");
  const found = buttons.find((button) => {
    const text = normalizeText(button.textContent ?? "");
    if (text === label) return true;
    return text.startsWith(label) && /^\d+$/.test(text.slice(label.length).trim());
  });
  if (!found) {
    const labels = buttons.map((b) => normalizeText(b.textContent ?? ""));
    throw new Error(`Sidebar has no button labelled "${label}". Found: ${labels.join(" | ")}`);
  }
  return found;
}

async function openScreen(container: HTMLElement, id: AuditRoute): Promise<void> {
  const key = NAV_KEYS[id];
  if (key === undefined) {
    await openScreen(container, "guide");
    fireEvent.click(within(container).getByRole("button", { name: t("g_open") }));
  } else {
    const button = navButton(container, t(key));
    fireEvent.click(button);
  }
  await waitForSettled();
  await waitUntil(() =>
    READY_SELECTOR[id].some((selector) => container.querySelector(selector) !== null),
  );
}

async function rebuildRoute(container: HTMLElement, id: AuditRoute): Promise<void> {
  const parking: AuditRoute = id === "guide" ? "overview" : "guide";
  await openScreen(container, parking);
  await openScreen(container, id);
}

function locate(container: HTMLElement, locator: Locator): HTMLElement | null {
  if (locator.by === "testid") {
    return container.querySelector<HTMLElement>(`[data-testid="${locator.value}"]`);
  }
  if (locator.by === "testid-prefix") {
    return container.querySelector<HTMLElement>(`[data-testid^="${locator.value}"]`);
  }
  if (locator.by === "shell") {
    const header = within(container).getByRole("banner");
    const headerButtons = Array.from(header.querySelectorAll<HTMLElement>("button"));
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
    const escaped = t(locator.nameKey).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = within(container).queryAllByRole(locator.role, {
      name: new RegExp(`^${escaped}`, "i"),
    });
    return matches[0] ?? null;
  }
  const all = within(container).queryAllByRole(locator.role);
  return all[locator.index ?? 0] ?? null;
}

const CONTROL_SELECTOR =
  'button, [role="tab"], [role="switch"], input[type="checkbox"], input[type="radio"]';

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

interface Control {
  key: string;
  role: string;
  ordinal: number;
  disabled: boolean;
}

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
      element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true";
    out.push({ key, role, ordinal, disabled });
  }
  return out;
}

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

interface DomCapture {
  route: string;
  state: LiveAuditState;
  lang: Language;
  step: string;
  textNodes: string[];
}

async function startFakeRouter(): Promise<{
  port: number;
  origin: string;
  close: () => Promise<void>;
}> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address() as AddressInfo;
  return {
    port: address.port,
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function applyFixtureEnv(fixture: DaemonFixture): void {
  process.env["ROUTERSYNC_CONFIG"] = fixture.configPath;
  process.env["OMNIROUTE_DB_PATH"] = fixture.omniDbPath;
  process.env["NINEROUTER_DB_PATH"] = fixture.nineDbPath;
  process.env["OMNIROUTE_URL"] = fixture.omniProbeUrl;
  process.env["NINEROUTER_URL"] = fixture.nineProbeUrl;
  process.env["ROUTERSYNC_STATE_DIR"] = fixture.stateDir;
}

describe("AT-159: number provenance in live states", () => {
  let allowList: NumberProvenanceAllowEntry[] = [];
  let skipList: SkipEntry[] = [];
  let daemon: http.Server | undefined;
  let daemonPort = 0;
  let fakeOmni: { port: number; origin: string; close: () => Promise<void> } | undefined;
  let fakeNine: { port: number; origin: string; close: () => Promise<void> } | undefined;
  let fakeNineTwo: { port: number; origin: string; close: () => Promise<void> } | undefined;
  let fixtureNineOnly: DaemonFixture | undefined;
  let fixtureBothUp: DaemonFixture | undefined;
  let currentRecordedPayloads: Record<string, unknown> | undefined;

  const originalMatchMedia = window.matchMedia;
  const originalAbortSignalTimeout = (AbortSignal as unknown as { timeout?: unknown })
    .timeout;

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

    (AbortSignal as unknown as { timeout: unknown }).timeout = () => undefined;

    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      pendingFetches += 1;
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url;

      return realFetch(input, init)
        .then(async (res) => {
          if (url.includes("/api/v1/")) {
            const pathname = new URL(url, "http://127.0.0.1").pathname;
            const routeKey = pathname.replace("/api/v1/", "").split("/")[0] || "unknown";
            try {
              const data = await res.clone().json();
              if (currentRecordedPayloads) {
                currentRecordedPayloads[routeKey] = data;
              }
            } catch {
              // ignore non-json
            }
          }
          return res;
        })
        .finally(() => {
          pendingFetches -= 1;
        });
    }) as typeof fetch;

    allowList = readNumberProvenanceAllow();
    skipList = readSkipList();

    fakeOmni = await startFakeRouter();
    fakeNine = await startFakeRouter();
    fakeNineTwo = await startFakeRouter();

    fixtureNineOnly = await setupDaemonFixture({
      probePorts: { nine: fakeNine.port },
    });
    shapeFixtureDatabases(fixtureNineOnly);

    fixtureBothUp = await setupDaemonFixture({
      probePorts: { omni: fakeOmni.port, nine: fakeNineTwo.port },
    });
    shapeFixtureDatabases(fixtureBothUp);

    clearProbeCache();
    daemon = createDaemonServer({ host: "127.0.0.1" });
    const server = daemon;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    daemonPort = (server.address() as AddressInfo).port;
  }, 120000);

  afterAll(async () => {
    window.matchMedia = originalMatchMedia;
    (AbortSignal as unknown as { timeout: unknown }).timeout = originalAbortSignalTimeout;
    globalThis.fetch = realFetch;
    if (daemon) await new Promise<void>((resolve) => daemon!.close(() => resolve()));
    if (fakeOmni) await fakeOmni.close();
    if (fakeNine) await fakeNine.close();
    if (fakeNineTwo) await fakeNineTwo.close();
    fixtureBothUp?.restore();
    fixtureNineOnly?.restore();
  });

  afterEach(() => {
    cleanup();
    setLanguage("vi");
  });

  /** Fetches the 6 live daemon route payloads */
  async function fetchLivePayloads(baseUrl: string): Promise<Record<string, unknown>> {
    const routes = ["overview", "health", "targets", "combos", "providers", "models", "doctor"];
    const out: Record<string, unknown> = {};
    for (const r of routes) {
      try {
        const res = await realFetch(`${baseUrl}/api/v1/${r}`);
        out[r] = await res.json();
      } catch {
        out[r] = {};
      }
    }
    return out;
  }

  it("proves positive control: flags invented numbers 86 and 416, accepts valid numbers", () => {
    const catalog = translations as unknown as Record<string, unknown>;
    const catalogVi = collectCatalogNumbers(catalog, "vi");
    const samplePayloads: Record<string, unknown> = {
      overview: { trackedModels: { count: 61 }, safetyBreaker: { trippedCount: 0 } },
    };
    const payloadNums = collectPayloadNumbers(samplePayloads);
    const derivedNums = collectDerivedNumbers({ payloads: samplePayloads, lang: "vi" });

    // Legitimate model count (61) is valid
    const validResult = checkTextNodeProvenance(
      "61 model",
      "overview",
      "vi",
      payloadNums,
      catalogVi,
      derivedNums,
      [],
    );
    expect(validResult).toEqual([]);

    // Invented number "86 model" is caught as violation
    const fake86 = checkTextNodeProvenance(
      "86 model",
      "overview",
      "vi",
      payloadNums,
      catalogVi,
      derivedNums,
      [],
    );
    expect(fake86.length).toBeGreaterThan(0);
    expect(fake86.map((v) => v.token)).toContain("86");

    // Invented number "416" is caught as violation
    const fake416 = checkTextNodeProvenance(
      "416 model",
      "overview",
      "vi",
      payloadNums,
      catalogVi,
      derivedNums,
      [],
    );
    expect(fake416.length).toBeGreaterThan(0);
    expect(fake416.map((v) => v.token)).toContain("416");
  });

  it("every number rendered in live states has documented provenance", async () => {
    const baseUrl = `http://127.0.0.1:${daemonPort}`;
    const catalog = translations as unknown as Record<string, unknown>;

    const allViolations: ProvenanceAuditResult[] = [];

    for (const state of LIVE_STATES) {
      if (state === "live_fixture" && fixtureNineOnly) {
        applyFixtureEnv(fixtureNineOnly);
      }
      if (state === "live_fixture_up" && fixtureBothUp) {
        applyFixtureEnv(fixtureBothUp);
      }
      clearProbeCache();

      // Read current live payloads for this state
      currentRecordedPayloads = await fetchLivePayloads(baseUrl);

      for (const lang of LANGUAGES) {
        setLanguage(lang);
        const catalogNums = collectCatalogNumbers(catalog, lang);

        const api = new HttpApi(baseUrl);
        const { container } = render(
          <ApiProvider value={api}>
            <App />
          </ApiProvider>,
        );
        const baselineViewMode: ViewMode = getViewMode();

        await waitForSettled();
        await waitUntil(() =>
          READY_SELECTOR.overview.some((selector) => container.querySelector(selector) !== null),
        );

        const auditDom = (route: string, stepName: string) => {
          const payloadNums = collectPayloadNumbers(currentRecordedPayloads || {});
          const derivedNums = collectDerivedNumbers({
            payloads: currentRecordedPayloads || {},
            lang,
          });
          const textNodes = collectTextNodes(container);
          for (const node of textNodes) {
            if (!/\d/.test(node)) continue;
            const violations = checkTextNodeProvenance(
              node,
              route,
              lang,
              payloadNums,
              catalogNums,
              derivedNums,
              allowList,
            );
            if (violations.length > 0) {
              allViolations.push(...violations);
            }
          }
        };

        for (const route of ROUTES) {
          // 1. Opening state
          await openScreen(container, route);
          auditDom(route, "opening");

          // 2. Explicit scenarios
          for (const scenario of SCENARIOS.filter((item) => item.route === route)) {
            await openScreen(container, route);
            for (const step of scenario.steps) {
              const element = locate(container, step.target);
              if (element === null) continue;
              fireEvent.click(element);
              await waitForSettled();
              auditDom(route, `${scenario.name} | ${step.action}`);
              await restoreShellState(lang, baselineViewMode);
            }
          }

          // 3. Control sweep
          await openScreen(container, route);
          const controls = enumerateControls(container);
          for (const control of controls) {
            const handWritten = skipList.find(
              (entry) => entry.route === route && entry.control === control.key,
            );
            if (handWritten || control.disabled) continue;

            await rebuildRoute(container, route);
            const element = controlAt(container, control.role, control.ordinal);
            if (element === null) continue;
            fireEvent.click(element);
            await waitForSettled();
            auditDom(route, `sweep: ${control.key}`);
            await restoreShellState(lang, baselineViewMode);
          }
        }

        // 4. Shell scenario
        await openScreen(container, "overview");
        for (const step of SHELL_SCENARIO.steps) {
          const element = locate(container, step.target);
          if (element === null) continue;
          fireEvent.click(element);
          await waitForSettled();
          auditDom("overview", `shell: ${step.action}`);
          await restoreShellState(lang, baselineViewMode);
        }

        cleanup();
      }
    }

    if (allViolations.length > 0) {
      console.error(
        "AT-159 Provenance Violations:\n" +
          allViolations
            .map((v) => `[${v.route}] [${v.lang}] "${v.token}" (${v.type}) in: "${v.textNode}"`)
            .join("\n"),
      );
    }

    expect(
      allViolations,
      `Unprovenanced numbers found in live states:\n${allViolations
        .map((v) => `[${v.route}] "${v.token}" in "${v.textNode.slice(0, 100)}"`)
        .join("\n")}`,
    ).toEqual([]);
  }, 180000);
});
