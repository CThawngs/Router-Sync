import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { createDaemonServer, clearProbeCache } from '@routersync/daemon';
import { setupDaemonFixture, type DaemonFixture } from '../../../test/harness/daemon-fixture.js';
import { ApiProvider } from '../src/api';
import { HttpApi } from '../src/api/http';
import { App } from '../src/App';
import { t } from '../src/i18n';

/**
 * AT-145 (R16-1): the closed loop daemon -> HttpApi -> screen.
 *
 * Every other test in this repo looked at ONE end of the wire: the daemon
 * tests looked at raw payloads, the UI tests looked at a MockApi. Nothing
 * proved that what the daemon really sends is what the screen really shows.
 * This test starts a hermetic daemon with a router database shaped like a
 * real one, injects its base URL into the real HttpApi, renders the real
 * application in jsdom, and asserts on the TEXT THE USER SEES.
 *
 * The fixture DB carries, on purpose:
 *  - 2 routers (OmniRoute down, 9Router up);
 *  - 9Router `comboStrategies` with a plain string AND the object form;
 *  - one combo with 60 models, another with 3 models, 2 of them shared;
 *  - a model that belongs to one combo only (to catch a ladder that unions
 *    every combo of every router).
 */

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as {
  DatabaseSync: new (p: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...args: unknown[]): void };
    close(): void;
  };
};

const BIG_MODELS = Array.from({ length: 60 }, (_, i) => `m${String(i + 1).padStart(2, '0')}`);
const SMALL_MODELS = ['m59', 'm60', 'm61'];
const OMNI_MODELS = ['omni-only-model'];

/** 60 + 1 (m61) + 1 (omni) = 62 distinct models across the two routers. */
const EXPECTED_TRACKED_MODELS = 62;

/**
 * R18-6b: the wait deadline for the daemon-backed assertions below.
 *
 * The testing-library default is 1000 ms. The App only leaves its loading
 * screen after SIX real HTTP round-trips to the in-process daemon, and the
 * first one also opens the fixture SQLite database. Under a loaded machine
 * (the whole suite in parallel) that took longer than 1 s, so the test
 * failed while the app was still loading - a deadline problem, not a
 * behaviour problem. The ASSERTIONS are unchanged; only the deadline moves.
 */
const WAIT = { timeout: 5000 } as const;

/**
 * jsdom does not implement `window.matchMedia`; the shell asks for the
 * prefers-color-scheme on every render, so the whole app would throw
 * without this stub (same stub as at-78-theme / at-147).
 */
const originalMatchMedia = window.matchMedia;

/**
 * jsdom replaces the global `AbortSignal` with its own implementation, and
 * Node's fetch (undici) refuses a signal that is not a native AbortSignal:
 * "RequestInit: Expected signal to be an instance of AbortSignal".
 *
 * The daemon's router probe passes `AbortSignal.timeout(800)` to fetch, so
 * in this environment every probe would fail with a bogus error and the
 * screen would show "0/2 routers" although the mock router answers. The
 * timeout is therefore disabled here — every probe target of this test
 * either answers immediately or refuses the connection immediately.
 */
const originalTimeout = AbortSignal.timeout;

beforeAll(() => {
  AbortSignal.timeout = (() => undefined) as unknown as typeof AbortSignal.timeout;

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
});

afterAll(() => {
  window.matchMedia = originalMatchMedia;
  AbortSignal.timeout = originalTimeout;
});

describe('AT-145: daemon -> HttpApi -> screen (closed loop)', () => {
  let fixture: DaemonFixture | undefined;
  let daemon: http.Server | undefined;
  let daemonPort = 0;
  let upRouter: http.Server | undefined;

  beforeAll(async () => {
    // 1. A router that answers -> 9Router is `up`.
    const upServer = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
    });
    upRouter = upServer;
    await new Promise<void>((resolve) => upServer.listen(0, '127.0.0.1', () => resolve()));
    const upPort = (upServer.address() as AddressInfo).port;

    // 2. Hermetic fixture. OmniRoute keeps a closed loopback port -> `down`.
    const fx = await setupDaemonFixture({ probePorts: { nine: upPort } });
    fixture = fx;

    // 3. Shape the databases like a real router DB.
    const nineDb = new DatabaseSync(fx.nineDbPath);
    try {
      nineDb.exec(`DELETE FROM combos;`);
      const now = new Date().toISOString();
      const insert = nineDb.prepare(
        `INSERT INTO combos (id, name, kind, models, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)`
      );
      insert.run('routersync-big', 'Big Combo', 'managed', JSON.stringify(BIG_MODELS), now, now);
      insert.run('routersync-small', 'Small Combo', 'custom', JSON.stringify(SMALL_MODELS), now, now);
      nineDb.prepare('UPDATE settings SET data = ? WHERE id = 1').run(
        JSON.stringify({
          theme: 'dark',
          port: 20128,
          comboStrategies: {
            'Big Combo': 'priority',
            'Small Combo': { fallbackStrategy: 'fallback' },
          },
        })
      );
    } finally {
      nineDb.close();
    }

    const omniDb = new DatabaseSync(fx.omniDbPath);
    try {
      omniDb.exec(`DELETE FROM combos;`);
      omniDb.exec(
        `INSERT INTO combos (id, name, data) VALUES ('routersync-omni', 'Omni Combo', ` +
          `'{"strategy":"priority","models":${JSON.stringify(OMNI_MODELS)},"managed":true}');`
      );
    } finally {
      omniDb.close();
    }

    // 4. Start the daemon on an ephemeral loopback port.
    clearProbeCache();
    const d = createDaemonServer({ host: '127.0.0.1' });
    daemon = d;
    await new Promise<void>((resolve) => {
      d.listen(0, '127.0.0.1', () => resolve());
    });
    daemonPort = (d.address() as AddressInfo).port;
  });

  afterAll(async () => {
    const d = daemon;
    if (d) await new Promise<void>((resolve) => d.close(() => resolve()));
    const router = upRouter;
    if (router) await new Promise<void>((resolve) => router.close(() => resolve()));
    fixture?.restore();
  });

  let consoleErrors: string[] = [];

  beforeEach(() => {
    consoleErrors = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map((a) => String(a)).join(' '));
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const renderApp = () =>
    render(
      <ApiProvider value={new HttpApi(`http://127.0.0.1:${daemonPort}`)}>
        <App />
      </ApiProvider>
    );

  /**
   * Opens a screen through the real sidebar. The label is the TRANSLATED one
   * (the app runs in Vietnamese by default), so the test never guesses an
   * English name that the sidebar does not show.
   */
  const openScreen = async (label: string) => {
    const button = await screen.findByRole('button', { name: label }, WAIT);
    fireEvent.click(button);
    return button;
  };

  it('shows the measured router count, not a constant', async () => {
    renderApp();

    // 9Router answers, OmniRoute does not -> 1 of 2 routers responded.
    await waitFor(() => {
      expect(screen.getByTestId('metric-routers-value').textContent).toBe('1/2');
    }, WAIT);
  });

  it('shows the measured number of tracked models', async () => {
    renderApp();

    await waitFor(() => {
      expect(screen.getByTestId('metric-models-value').textContent).toBe(
        String(EXPECTED_TRACKED_MODELS)
      );
    }, WAIT);
  });

  it('never paints a sample-data strip while the daemon serves live data', async () => {
    renderApp();

    await waitFor(() => {
      expect(screen.getByTestId('metric-routers-value')).toBeDefined();
    }, WAIT);
    expect(screen.queryByTestId('data-source-sample')).toBeNull();
    expect(screen.queryByTestId('data-source-unreachable')).toBeNull();
  });

  it('shows every combo name and the measured strategy string', async () => {
    renderApp();
    await openScreen(t('nav_combos'));

    await waitFor(() => {
      expect(screen.getByTestId('combo-picker-routersync-big')).toBeDefined();
    }, WAIT);
    expect(screen.getByTestId('combo-picker-routersync-big').textContent).toContain('Big Combo');
    expect(screen.getByTestId('combo-picker-routersync-small').textContent).toContain('Small Combo');

    // The 9Router stores "Small Combo" as { fallbackStrategy: 'fallback' }.
    // The screen must show the STRING, never the object.
    expect(screen.getByTestId('combo-picker-routersync-small').textContent).toContain('fallback');
    expect(screen.getByTestId('combo-picker-routersync-big').textContent).toContain('priority');
    expect(document.body.textContent).not.toContain('[object Object]');
  });

  it('draws the priority ladder of the SELECTED combo, not a union of every combo', async () => {
    renderApp();
    await openScreen(t('nav_combos'));

    await waitFor(() => {
      expect(screen.getByTestId('combo-picker-routersync-big')).toBeDefined();
    }, WAIT);

    // Select the 60-model combo.
    fireEvent.click(screen.getByTestId('combo-picker-routersync-big'));

    await waitFor(() => {
      const ladder = screen.getByTestId('combo-ladder');
      expect(ladder.textContent).toContain('m01');
    }, WAIT);

    // The ladder belongs to "Big Combo": its own 60 models. The model that
    // only exists in "Small Combo" (m61) must NOT be in the ladder, and the
    // OmniRoute-only model must not be in it either.
    const ladderText = screen.getByTestId('combo-ladder').textContent ?? '';
    expect(ladderText).not.toContain('m61');
    expect(ladderText).not.toContain('omni-only-model');

    // Expand the ladder (it is collapsed by default) and count the steps.
    const toggle = screen.queryByTestId('combo-ladder-toggle');
    if (toggle) fireEvent.click(toggle);

    await waitFor(() => {
      expect(document.querySelectorAll('[data-testid^="combo-step-"]').length).toBe(60);
    }, WAIT);

    // The other combo has 3 steps of its own.
    fireEvent.click(screen.getByTestId('combo-picker-routersync-small'));
    await waitFor(() => {
      const steps = document.querySelectorAll('[data-testid^="combo-step-"]').length;
      expect(steps).toBeLessThanOrEqual(60);
    }, WAIT);
    const smallText = screen.getByTestId('combo-ladder').textContent ?? '';
    expect(smallText).toContain('m59');
    expect(smallText).not.toContain('m01');
  });

  it('shows the measured reachability of every router on the targets screen', async () => {
    renderApp();
    await openScreen(t('nav_targets'));

    await waitFor(() => {
      expect(screen.getByTestId('target-card-9router')).toBeDefined();
    }, WAIT);

    const nineCard = screen.getByTestId('target-card-9router');
    // R18-5.1: the enum is translated now, so the assertion follows the
    // catalog instead of pinning the raw payload token.
    const nineProbe = within(nineCard).getByTestId('target-probe-value').textContent ?? '';
    expect(nineProbe).toContain(t('r18_reach_up'));
    expect(nineProbe).toContain('200');
    // ...and the raw enum must NOT be painted on its own anymore.
    expect(nineProbe).not.toBe('up');

    const omniCard = screen.getByTestId('target-card-omniroute');
    const omniProbe = within(omniCard).getByTestId('target-probe-value').textContent ?? '';
    expect(omniProbe).toContain(t('r18_reach_down'));
    expect(omniProbe).not.toBe('down');
  });

  it('shows the measured doctor states on the health screen', async () => {
    renderApp();
    await openScreen(t('nav_health'));

    await waitFor(() => {
      expect(screen.getByTestId('doctor-state-c1')).toBeDefined();
    }, WAIT);

    // c1 (node runtime) always passes on the machine that runs the test.
    expect(screen.getByTestId('doctor-state-c1').textContent?.trim()).not.toBe('');
    // c7..c9 are deferred to P3a -> not checked, never painted as a failure.
    for (const id of ['c7', 'c8', 'c9']) {
      const badge = screen.getByTestId(`doctor-state-${id}`);
      expect(badge.style.border).toContain('dashed');
    }
  });

  it('renders without a console error and without an error boundary', async () => {
    renderApp();
    await openScreen(t('nav_combos'));
    await waitFor(() => {
      expect(screen.getByTestId('combo-ladder')).toBeDefined();
    }, WAIT);

    expect(screen.queryByTestId('screen-error-fallback')).toBeNull();
    const fatal = consoleErrors.filter(
      (msg) =>
        /Objects are not valid as a React child|Uncaught|The above error occurred|Cannot read propert/i.test(
          msg
        )
    );
    expect(fatal, `console errors:\n${consoleErrors.join('\n')}`).toEqual([]);
  });
});

/**
 * The data-error case of AT-145: a daemon that answers with a field of the
 * WRONG TYPE (an object where the contract promises a string). The screen that
 * reads that field must show its local error card; the rest of the
 * application must keep rendering.
 *
 * A stub server stands in for the daemon here: the real daemon normalises
 * `strategy` (AT-143), so it can no longer produce the broken shape. What
 * matters is that the CLIENT is robust to a daemon it does not control.
 */
describe('AT-145: a daemon that answers with a wrongly typed field', () => {
  let broken: http.Server | undefined;
  let brokenPort = 0;

  beforeAll(async () => {
    const nowIso = new Date().toISOString();
    const overview = {
      meta: { source: 'live', generatedAt: nowIso },
      routers: { upCount: 1, probedCount: 2 },
      trackedModels: { count: 3 },
      billableRequestsToday: { code: 'by_design_zero_inference' },
      lastCheck: { code: 'daemon_running' },
    };
    const doctor = {
      meta: { source: 'live', generatedAt: nowIso },
      overallStatus: 'healthy',
      conditions: [],
    };
    const health = {
      meta: { source: 'live', generatedAt: nowIso },
      daemon: 'test',
      status: 'ok',
      readOnly: true,
      uptime: 5,
      routers: {},
    };
    // The broken part: `strategy` is an OBJECT here.
    const combos = {
      meta: { source: 'live', generatedAt: nowIso },
      combos: [
        {
          id: 'broken',
          name: 'Broken Combo',
          strategy: { fallbackStrategy: 'fallback' },
          type: 'managed',
          targets: [],
          steps: [],
        },
      ],
    };

    broken = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const url = req.url ?? '';
      if (url.startsWith('/api/v1/combos')) res.end(JSON.stringify(combos));
      else if (url.startsWith('/api/v1/overview')) res.end(JSON.stringify(overview));
      else if (url.startsWith('/api/v1/doctor')) res.end(JSON.stringify(doctor));
      else if (url.startsWith('/api/v1/health')) res.end(JSON.stringify(health));
      else res.end(JSON.stringify({ meta: { source: 'live', generatedAt: nowIso }, data: [] }));
    });
    await new Promise<void>((resolve) => {
      (broken as http.Server).listen(0, '127.0.0.1', () => resolve());
    });
    brokenPort = ((broken as http.Server).address() as AddressInfo).port;
  });

  afterAll(async () => {
    const b = broken;
    if (b) await new Promise<void>((resolve) => b.close(() => resolve()));
  });

  it('shows a local error card on the broken screen and keeps the rest alive', async () => {
    render(
      <ApiProvider value={new HttpApi(`http://127.0.0.1:${brokenPort}`)}>
        <App />
      </ApiProvider>
    );

    await waitFor(() => {
      expect(screen.getByRole('navigation')).toBeTruthy();
    }, WAIT);

    fireEvent.click(screen.getByRole('button', { name: t('nav_combos') }));

    await waitFor(() => {
      expect(screen.getByTestId('screen-error-fallback')).toBeTruthy();
    }, WAIT);
    expect(screen.getByTestId('screen-error-fallback').textContent).toContain('RS-SCREEN-001');

    // The shell survives: the sidebar is still there.
    expect(screen.getByRole('navigation')).toBeTruthy();

    // Another screen still renders the measured numbers.
    fireEvent.click(screen.getByRole('button', { name: t('nav_overview') }));
    await waitFor(() => {
      expect(screen.getByTestId('metric-routers-value').textContent).toBe('1/2');
    }, WAIT);
  });
});

/**
 * R18-1 (AT-145 extension): the COLLECTION ENVELOPE of `/api/v1/combos`.
 *
 * `/combos` used to answer a bare array when at least one database was
 * readable, and `{ meta, combos }` only when BOTH failed. The bare array
 * carried no `meta`, so the screen could not tell "readable database, zero
 * combos" from "nothing could be read" — it painted "no combos yet" in both
 * cases. The route now answers the envelope on every 200.
 *
 * The two cases below are the ones the owner can hit on a real machine:
 *  A. both databases are gone -> the unavailable frame, NOT the empty state;
 *  B. one database is gone -> the combos of the readable router PLUS a warning
 *     naming the router whose combos are missing.
 */
describe('AT-145 (R18-1): /combos keeps its collection envelope over HTTP', () => {
  let fixture: DaemonFixture | undefined;
  let daemon: http.Server | undefined;
  let daemonPort = 0;

  const startDaemon = async (): Promise<void> => {
    clearProbeCache();
    const d = createDaemonServer({ host: '127.0.0.1' });
    daemon = d;
    await new Promise<void>((resolve) => {
      d.listen(0, '127.0.0.1', () => resolve());
    });
    daemonPort = (d.address() as AddressInfo).port;
  };

  const renderApp = () =>
    render(
      <ApiProvider value={new HttpApi(`http://127.0.0.1:${daemonPort}`)}>
        <App />
      </ApiProvider>
    );

  const openCombos = async (): Promise<void> => {
    const button = await screen.findByRole('button', { name: t('nav_combos') }, WAIT);
    fireEvent.click(button);
  };

  const readCombosPayload = async (): Promise<{
    meta?: { source?: string; reason?: string; routers?: Record<string, { source?: string }> };
    combos?: unknown[];
  }> => {
    const res = await fetch(`http://127.0.0.1:${daemonPort}/api/v1/combos`);
    return (await res.json()) as {
      meta?: { source?: string; reason?: string; routers?: Record<string, { source?: string }> };
      combos?: unknown[];
    };
  };

  afterEach(async () => {
    cleanup();
    vi.restoreAllMocks();
    const d = daemon;
    daemon = undefined;
    if (d) await new Promise<void>((resolve) => d.close(() => resolve()));
    fixture?.restore();
    fixture = undefined;
  });

  it('answers the envelope when BOTH router databases are gone', async () => {
    const fx = await setupDaemonFixture();
    fixture = fx;
    fs.rmSync(fx.omniDbPath);
    fs.rmSync(fx.nineDbPath);
    await startDaemon();

    const body = await readCombosPayload();
    // Not a bare array: `meta` must survive the wire.
    expect(Array.isArray(body)).toBe(false);
    expect(body.meta?.source).toBe('unavailable');
    expect(body.combos).toEqual([]);
    expect(body.meta?.routers?.['omniroute']?.source).toBe('unavailable');
    expect(body.meta?.routers?.['9router']?.source).toBe('unavailable');

    renderApp();
    await openCombos();

    await waitFor(() => {
      expect(screen.getByTestId('combos-unavailable')).toBeTruthy();
    }, WAIT);
    // The empty state says "no combos are configured", which is a CLAIM about
    // the routers. Nothing was read, so the screen must not say it.
    expect(screen.queryByTestId('combos-empty-state')).toBeNull();
  });

  it('keeps the combos of the readable router and names the unreadable one', async () => {
    const fx = await setupDaemonFixture();
    fixture = fx;
    // OmniRoute is gone, 9Router still readable.
    fs.rmSync(fx.omniDbPath);
    await startDaemon();

    const body = await readCombosPayload();
    expect(body.meta?.source).toBe('live');
    expect(body.meta?.routers?.['omniroute']?.source).toBe('unavailable');
    expect(body.meta?.routers?.['9router']?.source).toBe('live');
    expect(body.combos?.length).toBe(1);

    renderApp();
    await openCombos();

    await waitFor(() => {
      expect(screen.getByTestId('combo-picker-routersync-fast')).toBeTruthy();
    }, WAIT);
    const warning = screen.getByTestId('combos-router-unavailable');
    expect(warning.textContent).toContain('omniroute');
    // One router is readable, so this is not the total-failure frame.
    expect(screen.queryByTestId('combos-unavailable')).toBeNull();
    // And it is not the "nothing configured" state either.
    expect(screen.queryByTestId('combos-empty-state')).toBeNull();
  });
});
