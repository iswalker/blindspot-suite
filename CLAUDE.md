# Project Preferences

## Pull Requests
- Always merge PRs to main via squash merge as soon as CI passes — do not wait for the user to say "merge".

## Settings Gear Panel Design
- **Top section (cross-cutting controls)**: cache/refresh, config picker, reload files, plan selector — always visible on every tab.
- **Bottom section (per-tab controls)**: tab-specific toggles that appear only when the relevant tab is active. Show/hide by watching `state.activeTab` and updating the container's `display` in `switchTab()` / on tab render.
- New tab-specific toggles belong in the bottom section, not always visible.
