# ADR-UI-01: Technology Stack for RouterSync Web UI (UI-0 Slice)

- **ID:** ADR-UI-01
- **Status:** ACCEPTED
- **Date:** 2026-10-15
- **Deciders:** Project Owner, RouterSync Engineering
- **Consulted:** SPEC.md (§24.2, §28.3, §29.5, §34), GOVERNANCE.md, D25, D27

---

## 1. Context & Problem Statement

RouterSync needs a real, local-first web interface complying with UI concept v5. This is an isolated vertical slice (`UI-0`) that must not affect the Core, Adapters, CLI, MCP server, or the pending gates of Phase 3 (Gate L, Gate R, AT-114, Gate X, P3a, P3b).
The UI must run on sample data via a pure TypeScript view-model layer (`MockApi`), with an explicit interface allowing future binding to the background daemon via HTTP (`HttpApi` in P3b).

Key requirements:
1. **Visual Fidelity & Concept v5 Alignment:** Pixel-clean, responsive card/ladder structure with light, dark, and auto themes governed strictly by CSS variables (`routersync-ui-tokens.css`).
2. **Strict Offline & Local-First:** Self-hosted bundled fonts (Plus Jakarta Sans 400-800, JetBrains Mono 400-500). No CDN, no Google Fonts, zero external network requests (`default-src 'self'`).
3. **Multi-platform & Zero Shell Specifics:** Compatible with Windows, macOS, and Linux (D25).
4. **License Compliance:** All runtime and dev dependencies must use permissive open-source licenses (MIT, ISC, Apache-2.0, or OFL-1.1 for fonts). No copyleft or viral licenses.
5. **Exact Version Pinning:** Fully pinned versions in `package.json` to guarantee reproducible builds across environments and CI.

---

## 2. Options Considered

### Option A: React 18 + Vite + TypeScript (Recommended & Chosen)
- **Framework:** React 18 (`react` 18.3.1, `react-dom` 18.3.1)
- **Bundler:** Vite 5 (`vite` 5.4.11) with `@vitejs/plugin-react` 4.3.3
- **Language:** TypeScript 5.6.3 (strict mode, `noUncheckedIndexedAccess`)
- **Styling:** Pure Vanilla CSS using design token custom properties (`var(--...)`), CSS Modules / scoped classes where needed. No heavy UI framework (no Tailwind, no MUI, no Radix/Chakra).
- **Typography:** Local packaging via `@fontsource/plus-jakarta-sans` (5.1.0) and `@fontsource/jetbrains-mono` (5.1.0).
- **Testing & Regression:** Vitest + Testing Library (`@testing-library/react` 16.0.1) for component & DOM assertions; Playwright (`@playwright/test` 1.48.2) for 1440x900 light/dark structural and visual contrast checks.

*Pros:*
- Ecosystem maturity and robust component model for complex states (ladder simulator, multi-tab drawer, bilingual dictionary switching).
- Instant HMR with Vite; bundle footprint remains minimal (< 150 kB min+gzip) when no heavy component libraries are introduced.
- First-class Vitest integration sharing configuration with the rest of the monorepo workspace.
- Clear separation between UI components and the `ApiClient` contract.

*Cons:*
- Slightly larger runtime runtime baseline (~42 kB gzipped) compared to Svelte.

---

### Option B: Svelte 5 / SvelteKit + Vite
- **Framework:** Svelte 5 (`svelte` 5.x)
- **Bundler:** Vite 5

*Pros:*
- Ultra-small bundle size, compiled reactivity.
- Native CSS scoping without extra tooling.

*Cons:*
- Svelte 5 rune model introduces transitional syntax changes.
- Smaller ecosystem for certain specialized testing utilities in monorepos already standardized on React/Vitest conventions.
- Developer experience across disparate contributor harnesses is more uniform with standard React 18.

---

## 3. Decision

We choose **Option A: React 18 + Vite 5 + TypeScript strict + Pure CSS Tokens + Fontsource**.

### Exact Dependency & License Specification

| Package | Version | License | Role |
|---|---|---|---|
| `react` | `18.3.1` | MIT | UI View Library |
| `react-dom` | `18.3.1` | MIT | DOM Renderer |
| `lucide-react` | `dự kiến (chưa thêm)` | ISC | Accessible UI Icon Library (hiện dùng inline SVG) |
| `@fontsource/plus-jakarta-sans` | `5.1.0` | OFL-1.1 (fonts) / MIT (code) | Primary Interface Font (400-800) |
| `@fontsource/jetbrains-mono` | `5.1.0` | OFL-1.1 (fonts) / MIT (code) | Monospace Code/ID Font (400, 500) |
| `vite` | `5.4.11` | MIT | Build Tool & Dev Server |
| `@vitejs/plugin-react` | `4.3.3` | MIT | Vite React JSX Transform |
| `typescript` | `5.6.3` | Apache-2.0 | Type System (Strict Mode) |
| `vitest` | `2.1.3` | MIT | Test Runner |
| `@types/react` | `18.3.12` | MIT | TypeScript Type Definitions |
| `@types/react-dom` | `18.3.1` | MIT | TypeScript Type Definitions |
| `@testing-library/react` | `16.0.1` | MIT | Component Testing |
| `@testing-library/jest-dom` | `6.6.2` | MIT | DOM Matchers |
| `jsdom` | `25.0.1` | MIT | Headless DOM Environment |
| `@playwright/test` | `dự kiến (chưa thêm)` | Apache-2.0 | Screenshot & Regression Testing (Phase 3) |

**Package Manager:** `pnpm@9.15.1` (declared via root `package.json#packageManager`, engines `node >=22.12.0`).

All licenses are non-copyleft (MIT, ISC, Apache-2.0, OFL-1.1) and fully compatible with RouterSync's root MIT license.

### Workspace Version Alignment & Review Corrections:
- **Unified Vitest Version:** Vitest is strictly pinned to `2.1.3` across the entire monorepo workspace (both in root `devDependencies` and `packages/ui`); there is no version drift or dual version (verified via `pnpm why vitest`).
- **Correction Regarding `lucide-react`:** In Round 2 review dialogue, it was mistakenly stated that `lucide-react` was installed in `package.json`. In reality, UI-0 exclusively uses clean inline accessible SVGs with zero runtime icon dependencies. `lucide-react` was only listed in the ADR table as prospective (`dự kiến (chưa thêm)`).

---

## 4. Architectural Boundaries (UI-0 Slice)

1. **No Core/Adapter Cross-Imports:** The browser application resides in `packages/ui` and interacts with data exclusively through `src/api/client.ts` (`ApiClient` interface). It imports no Node.js built-ins (`node:fs`, `node:sqlite`, `node:child_process`) and no server packages.
2. **Two Implementations of `ApiClient`:**
   - `MockApi`: Default implementation. Serves deterministic, synthetic data (acme, kite-lite-2, orbit). Mutations operate on an in-memory clone. Always activates the `DỮ LIỆU MẪU` chip.
   - `HttpApi`: Scaffold for P3b/P4 pointing to `/api/v1/...`. All mutation calls throw an informative error explaining that the background daemon is required.
3. **No External Network Calls:**
   - Content Security Policy in `index.html`:
     `default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self' http://127.0.0.1:* http://localhost:*;`
   - Zero telemetry, zero web fonts from Google/Cloudflare CDNs.
4. **Platform Agnostic Build Scripts (D25):**
   - Root scripts invoke `pnpm --filter @routersync/ui dev|build|test|preview`.
   - Verification script `pnpm verify:ui` runs typecheck, lint, component tests, build, and security guards.

---

## 5. Consequences

- **Positive:** UI development proceeds in full independence without blocking on Phase 3 backend stabilization. Visual and ergonomic alignment with concept v5 can be verified and reviewed by the project owner immediately.
- **Negative:** Dual maintenance of View-Model interfaces (`src/api/types.ts`) and future REST API contracts, mitigated by documenting mappings in `docs/ui/API-CONTRACT.md`.
