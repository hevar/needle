# Contributing

Bug reports and pull requests are welcome. For a larger change, please open an issue first so we can talk it through.

## Setup

```sh
npm install
npm run dev      # rebuild main.js on every change
npm run check    # lint, unit tests and production build
```

To try it in a vault, link the repository into the vault's plugin folder and enable Needle:

```sh
ln -s "$PWD" /path/to/vault/.obsidian/plugins/needle
```

## Project layout

| Path | Purpose |
| --- | --- |
| `src/search/engine.ts` | Matching, ranking and snippets. No Obsidian dependency. |
| `src/search/search.worker.ts` | Worker entry that runs the engine off the main thread. |
| `src/search/backends.ts` | Worker host with the watchdog, plus a main-thread fallback. |
| `src/search/vaultIndex.ts` | Keeps the worker in step with the vault. |
| `src/search/noteMatcher.ts` | Title, alias and folder matching for Go to note. |
| `src/ui/` | The find modal, preview pane, folder picker and Go to note. |
| `tests/` | Unit tests for the code that doesn't need Obsidian. |

## Releasing

1. Add the release to `CHANGELOG.md` and commit it.
2. Run `npm version patch` (or `minor`, `major`). This updates `manifest.json` and `versions.json`, commits them and creates a tag with no `v` prefix.
3. Run `git push --follow-tags`. The release workflow builds the plugin and creates a draft release with `main.js`, `manifest.json` and `styles.css`.
4. Review the draft and publish it.
