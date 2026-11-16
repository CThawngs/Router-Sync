/**
 * test/ui/render-audit-scenarios.ts
 *
 * AT-155 (R19-1) — the explicit scenario table of the interactive render audit.
 *
 * DOM-free on purpose: the ROOT tsconfig type-checks every TypeScript file
 * under `test` with `lib: ES2022` (no DOM). This module therefore holds DATA
 * only — a locator plus the plain-language sentence of the action — and the
 * runner (`packages/ui/test/at-155-render-audit-interactive.test.tsx`) executes
 * it.
 *
 * Rules of the table:
 *  - every step is a REAL user action (a click a person could do);
 *  - the DOM is captured after EVERY step, so a screen is never judged only in
 *    its opening state;
 *  - a step marked `optional` may be missing in a given state (nothing was
 *    measured there). A missing step is REPORTED, never silent;
 *  - a required UI that does not exist at all is a `NOT_PRESENT` row with a
 *    written reason — the audit never pretends it saw something it did not see.
 *
 * The locators are language-independent: a `nameKey` is an i18n key that the
 * runner resolves with `t()` in the language under audit, so the SAME table
 * drives the Vietnamese run and the English run.
 */

/** Every screen of the app, in the order of `ScreenId`. */
export type AuditRoute =
  | "overview"
  | "changes"
  | "combos"
  | "providers"
  | "targets"
  | "models"
  | "health"
  | "guide"
  | "settings"
  | "setup";

/** The route list, in the stable order of the printed audit. */
export const ROUTES: readonly AuditRoute[] = [
  "overview",
  "changes",
  "combos",
  "providers",
  "targets",
  "models",
  "health",
  "guide",
  "settings",
  "setup",
];

/** The controls of the shell (the top bar), outside the route content. */
export type ShellControl =
  | "lang-vi"
  | "lang-en"
  | "theme"
  | "view-simple"
  | "view-detail"
  | "agent-drawer";

/** How the runner finds the element of a step. */
export type Locator =
  | { by: "testid"; value: string }
  | { by: "testid-prefix"; value: string }
  | { by: "role"; role: string; nameKey?: string; index?: number }
  | { by: "shell"; control: ShellControl };

/** One real user action. */
export interface ScenarioStep {
  /** The action in plain words; the report prints it verbatim. */
  action: string;
  /** Where the action lands. */
  target: Locator;
  /** A selector that must exist after the step (the readiness check). */
  expectSelector?: string;
  /**
   * `true` when the control may be absent in a state (nothing was measured
   * there). A missing optional step is reported as skipped, with the reason.
   */
  optional?: boolean;
  /** Why the step may be missing. Printed when it is. */
  optionalReason?: string;
}

/** One named user journey through a route. */
export interface Scenario {
  route: AuditRoute;
  name: string;
  steps: ScenarioStep[];
}

/** A required UI that does not exist. Never silent. */
export interface NotPresentRow {
  route: AuditRoute | "shell";
  name: string;
  status: "not_present";
  reason: string;
}

/* ------------------------------------------------------------------ *
 * The scenarios
 * ------------------------------------------------------------------ */

export const SCENARIOS: readonly Scenario[] = [
  {
    route: "overview",
    name: "switch the view mode (simple <-> detail) and re-read the hero",
    steps: [
      {
        action: "switch the shell to the detail view",
        target: { by: "shell", control: "view-detail" },
      },
      {
        action: "switch the shell back to the simple view",
        target: { by: "shell", control: "view-simple" },
      },
    ],
  },
  {
    route: "changes",
    name: "open both tabs (pending / history)",
    steps: [
      {
        action: "open the pending tab",
        target: { by: "role", role: "tab", nameKey: "c_tab1" },
        expectSelector: '[role="tabpanel"]',
      },
      {
        action: "open the history tab",
        target: { by: "role", role: "tab", nameKey: "c_tab2" },
        expectSelector: '[role="tabpanel"]',
      },
    ],
  },
  {
    route: "combos",
    name: "open the builder, come back to the list, expand a combo card",
    steps: [
      {
        action: "open the builder tab",
        target: { by: "role", role: "tab", nameKey: "b_tab2" },
        expectSelector: '[role="tabpanel"]',
      },
      {
        action: "go back to the combo list",
        target: { by: "role", role: "tab", nameKey: "b_tab1" },
        expectSelector: '[role="tabpanel"]',
      },
      {
        action: 'press "Hiện tất cả" (show every step of the combo ladder)',
        target: { by: "testid", value: "combo-ladder-toggle" },
        optional: true,
        optionalReason:
          "the combo ladder is only rendered when a combo with steps was measured",
      },
      {
        action: "open a combo card (pick the first measured combo)",
        target: { by: "testid-prefix", value: "combo-picker-" },
        optional: true,
        optionalReason: "no combo was measured in this state",
      },
    ],
  },
  {
    route: "providers",
    name: "open the add-provider panel and flip the first provider switch",
    steps: [
      {
        action: "open the add-provider panel",
        target: { by: "role", role: "button", nameKey: "p_add" },
        expectSelector: '[data-testid="add-provider-panel"]',
      },
      {
        action: "close the add-provider panel again",
        target: { by: "role", role: "button", nameKey: "p_add" },
      },
      {
        action: "flip the first provider switch",
        target: { by: "role", role: "switch", index: 0 },
        optional: true,
        optionalReason: "no provider was measured in this state",
      },
    ],
  },
  {
    route: "targets",
    name: "read the target cards (the apply button is a prototype)",
    steps: [
      {
        action: "press the target action button",
        target: { by: "testid", value: "targets-empty-state" },
        optional: true,
        optionalReason:
          "the empty-state marker is not rendered when targets were measured",
      },
    ],
  },
  {
    route: "models",
    name: "open every model tab and every model filter",
    steps: [
      {
        action: "open the list tab",
        target: { by: "role", role: "tab", nameKey: "m_tab1" },
        expectSelector: '[data-testid="models-tab-list"]',
      },
      {
        action: "open the sources tab",
        target: { by: "role", role: "tab", nameKey: "m_tab2" },
        expectSelector: '[data-testid="models-tab-sources"]',
      },
      {
        action: "open the review tab",
        target: { by: "role", role: "tab", nameKey: "m_tab3" },
        expectSelector: '[data-testid="models-tab-review"]',
      },
      {
        action: "go back to the list tab",
        target: { by: "role", role: "tab", nameKey: "m_tab1" },
        expectSelector: '[data-testid="models-tab-list"]',
      },
      {
        action: 'filter by "all"',
        target: { by: "role", role: "button", nameKey: "m_f1" },
      },
      {
        action: 'filter by "free"',
        target: { by: "role", role: "button", nameKey: "m_f2" },
      },
      {
        action: 'filter by "vision"',
        target: { by: "role", role: "button", nameKey: "m_f3" },
      },
      {
        action: 'filter by "needs review"',
        target: { by: "role", role: "button", nameKey: "m_f4" },
      },
      {
        action: "open the detail card of the first model",
        target: { by: "testid-prefix", value: "model-row-" },
        optional: true,
        optionalReason: "no model was measured in this state",
      },
    ],
  },
  {
    route: "health",
    name: "run the doctor",
    steps: [
      {
        action: "run the machine check (doctor)",
        target: { by: "role", role: "button", nameKey: "h_dr" },
      },
    ],
  },
  {
    route: "guide",
    name: "open every guide tab",
    steps: [
      {
        action: "open the 'get started' tab",
        target: { by: "role", role: "tab", nameKey: "g_tab1" },
        expectSelector: '[data-testid="guide-tab-start"]',
      },
      {
        action: "open the 'concepts' tab",
        target: { by: "role", role: "tab", nameKey: "g_tab2" },
        expectSelector: '[data-testid="guide-tab-concepts"]',
      },
      {
        action: "open the 'FAQ' tab",
        target: { by: "role", role: "tab", nameKey: "g_tab3" },
        expectSelector: '[data-testid="guide-tab-faq"]',
      },
      {
        action: "open the 'troubleshooting' tab",
        target: { by: "role", role: "tab", nameKey: "g_tab4" },
        expectSelector: '[data-testid="guide-tab-trouble"]',
      },
      {
        action: "open the 'commands and MCP' tab",
        target: { by: "role", role: "tab", nameKey: "g_tab5" },
        expectSelector: '[data-testid="guide-tab-cheat"]',
      },
    ],
  },
  {
    route: "settings",
    name: "open every settings tab",
    steps: [
      {
        action: "open the 'general' tab",
        target: { by: "role", role: "tab", nameKey: "s_tab1" },
        expectSelector: '[data-testid="settings-tab-general"]',
      },
      {
        action: "open the 'safety' tab",
        target: { by: "role", role: "tab", nameKey: "s_tab2" },
        expectSelector: '[data-testid="settings-tab-safety"]',
      },
      {
        action: "open the 'AI and MCP' tab",
        target: { by: "role", role: "tab", nameKey: "s_tab3" },
        expectSelector: '[data-testid="settings-tab-ai"]',
      },
      {
        action: "open the 'notifications' tab",
        target: { by: "role", role: "tab", nameKey: "s_tab4" },
        expectSelector: '[data-testid="settings-tab-notify"]',
      },
      {
        action: "open the 'advanced' tab",
        target: { by: "role", role: "tab", nameKey: "s_tab5" },
        expectSelector: '[data-testid="settings-tab-advanced"]',
      },
    ],
  },
  {
    route: "setup",
    name: "walk the wizard forward 1->2->3->4 and back 4->3->2->1",
    steps: [
      {
        action: "continue from step 1 (provider)",
        target: { by: "role", role: "button", nameKey: "w_next" },
        expectSelector: '[data-testid="wizard-step-2"]',
      },
      {
        action: "continue from step 2 (targets)",
        target: { by: "role", role: "button", nameKey: "w_next" },
        expectSelector: '[data-testid="wizard-step-3"]',
      },
      {
        action: "continue from step 3 (safety)",
        target: { by: "role", role: "button", nameKey: "w_next" },
        expectSelector: '[data-testid="wizard-step-4"]',
      },
      {
        action: "go back from step 4",
        target: { by: "role", role: "button", nameKey: "w_back" },
        expectSelector: '[data-testid="wizard-step-3"]',
      },
      {
        action: "go back from step 3",
        target: { by: "role", role: "button", nameKey: "w_back" },
        expectSelector: '[data-testid="wizard-step-2"]',
      },
      {
        action: "go back from step 2",
        target: { by: "role", role: "button", nameKey: "w_back" },
        expectSelector: '[data-testid="wizard-step-1"]',
      },
    ],
  },
];

/**
 * The shell journey. It runs ONCE per (state, language) and ends on the
 * overview route, so the route is captured again with the other theme and the
 * other language.
 */
export const SHELL_SCENARIO: Scenario = {
  route: "overview",
  name: "shell: switch the language, switch the theme, capture the route again",
  steps: [
    {
      action: "switch the shell to English",
      target: { by: "shell", control: "lang-en" },
    },
    {
      action: "switch the shell back to Vietnamese",
      target: { by: "shell", control: "lang-vi" },
    },
    {
      action: "switch the theme (light <-> dark)",
      target: { by: "shell", control: "theme" },
    },
    {
      action: "switch the theme again",
      target: { by: "shell", control: "theme" },
    },
    {
      action: "open the agent drawer",
      target: { by: "shell", control: "agent-drawer" },
    },
    {
      action: "close the agent drawer",
      target: { by: "role", role: "button", nameKey: "close" },
    },
  ],
};

/**
 * The required UI that does NOT exist. Every entry is a promise the owner can
 * check: the audit never pretends to have seen a screen that is not there.
 */
export const NOT_PRESENT: readonly NotPresentRow[] = [
  {
    route: "overview",
    name: "the first-run branch (checklist, detections, demo toggle)",
    status: "not_present",
    reason:
      "the S1 daemon payload of GET /api/v1/overview carries no firstRun/isFirstRun field, so the first-run card can never render in any of the four audited states; the branch is covered by at-142-firstrun-overview.test.tsx instead",
  },
  {
    route: "providers",
    name: "a provider filter",
    status: "not_present",
    reason:
      "the providers screen has no filter control in S1: the provider list is not filterable, the summary chips are plain spans and the only interactive controls are the add-provider button and the per-provider switch",
  },
  {
    route: "health",
    name: "a health toggle",
    status: "not_present",
    reason:
      "the health screen is read-only in S1: it has no switch or checkbox, the only interactive control is the doctor button (GET /api/v1/doctor)",
  },
  {
    route: "targets",
    name: "an apply / rollback action on a target card",
    status: "not_present",
    reason:
      "the target action button is a prototype: its onClick is a no-op and it is disabled outside sample mode, so it is never enabled in the four audited states",
  },
];
