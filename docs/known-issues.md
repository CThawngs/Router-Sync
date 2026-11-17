# Known Issues

The following are known issues in the current version of RouterSync, tracked so that users and developers can be aware of product limitations.

## 1. OmniRoute: `readRouterModelState` returns `availableModels=0`

Function `readRouterModelState` from package `@routersync/core` returns an empty `availableModels` set for OmniRoute router. As a result, OmniRoute entries in command `routersync apps drift` are classified as `MISSING`, even though command `routersync doctor` counts 281 active models from `combos.data.models`.

Cause: `readRouterModelState` has not read active models from `combos.data.models` of OmniRoute.

## 2. Combo names (`9Router-Coder-1`, `OmniRoute-Coder-1`) not found in any read set

Field `comboModels` in router state contains model IDs *inside* combos, not combo names. Therefore, when an application references a combo name (e.g. `9Router-Coder-1`), drift does not find it in any read set (`availableModels`, `comboModels`, `customModels`) and classifies it as `MISSING`.
