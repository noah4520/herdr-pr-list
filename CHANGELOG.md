# Changelog

PR List follows [semantic versioning](https://semver.org): a patch release fixes things, a
minor release adds something, and a major release changes file names or how it is placed
in a layout. The current number is in `VERSION`.

## 0.1.0 — 2026-11-18

First release, built on herdr-app 0.1.16.

- **Panel.** The pull request for the focused terminal's branch, your open pull requests
  and the ones waiting on your review, with review and check states, read through `gh`.
  Sections fold; a click opens a pull request in the browser.
- **Refresh** when the panel shows, when the focused folder changes, on the button, and
  on an interval of 2 to 30 minutes or off.
- **Its own PRs button** for the tab bar, as a block with `props: { button: true }`, with
  options for the pill's corner and the divider line under it.
- An install script and a recipe for agents.
