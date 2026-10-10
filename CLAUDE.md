# Project Preferences

## Pull Requests
- Always merge PRs to main via squash merge as soon as CI passes — do not wait for the user to say "merge".
- Do not wait on the Vercel deployment status: merge without it (Vercel's free plan rate-limits deployments).

## Settings Gear Panel Design
- **Top section (cross-cutting controls)**: cache/refresh, config picker, plan selector — always visible on every tab.
- **Bottom section (per-tab controls)**: tab-specific toggles that appear only when the relevant tab is active. Show/hide by watching `state.activeTab` and updating the container's `display` in `switchTab()` / on tab render.
- New tab-specific toggles belong in the bottom section, not always visible.

## Typography in Hovers & Modals
- Default font sizes chosen for hover tooltips and modals (popovers, Change Drivers modal, etc.) read 1-2px too small. When adding new text to one of these components, size it 1-2px larger than what would otherwise feel proportionate — e.g. a label that would normally be 12px should be 14px, 10px should be 12px, 13px should be 15px.
