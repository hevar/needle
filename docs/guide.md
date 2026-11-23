# Needle user guide

- [Searching](#searching)
- [Regex recipes](#regex-recipes)
- [Reading the results](#reading-the-results)
- [How results are ranked](#how-results-are-ranked)
- [Go to note](#go-to-note)
- [Settings](#settings)
- [Cloud-synced vaults](#cloud-synced-vaults)
- [Accessibility](#accessibility)
- [Troubleshooting](#troubleshooting)

## Searching

Open Needle in any of these ways:

- Run **Needle: Find in vault** or **Needle: Find in current folder** from the command palette.
- Click **Find in vault** in the ribbon.
- Select text in a note, right-click and choose **Find in vault**.
- Right-click a folder and choose **Find in folder**.

If text is selected when Needle opens, it searches for that text. Otherwise it offers your previous search.

A search with several words is treated as one phrase, so `spaced repetition` only matches those words next to each other. To find lines containing both words in any order, turn on regex and use `(?=.*spaced)(?=.*repetition).+`.

| Option | Shortcut | What it does |
| --- | --- | --- |
| Match case | <kbd>Alt</kbd>+<kbd>C</kbd> | `Note` no longer matches `note`. |
| Whole word | <kbd>Alt</kbd>+<kbd>W</kbd> | `art` no longer matches `party`. Works with accented letters and non-Latin scripts. |
| Regular expression | <kbd>Alt</kbd>+<kbd>R</kbd> | Treats the search as a JavaScript regular expression. |

Use the chips under the search field to choose the scope. **Vault** searches everything. The folder chip searches the current note's folder, and the icon next to it lets you pick another one.

## Regex recipes

`^` and `$` match the start and end of each line. Searches ignore case unless **Match case** is on.

| Find | Pattern |
| --- | --- |
| Open tasks | `^\s*- \[ \] .+` |
| Level 2 headings | `^## .+` |
| Tags, including nested and accented | `#[\p{L}\p{N}_/-]+` |
| Dates like 2026-11-20 | `\b\d{4}-\d{2}-\d{2}\b` |
| Wikilinks | `\[\[[^\]]+\]\]` |
| Web links | `https?://\S+` |
| TODO or FIXME | `\b(TODO\|FIXME)\b` |

If a pattern takes too long, Needle stops it after about four seconds and shows a message. Obsidian keeps running.

## Reading the results

Each note gets a card with its name, folder and number of matches. Long notes show their first lines, with a button to show more.

- Click a line to preview it.
- Double-click a line to open the note there.
- Middle-click or <kbd>Ctrl/Cmd</kbd>-click to open it in a new tab.
- Double-click the preview to open the note at that line.

The preview has two modes. **Source** shows the raw Markdown with line numbers. **Reading** renders the note as reading view does. Switch with the buttons in the preview header or <kbd>Ctrl/Cmd</kbd>+<kbd>E</kbd>.

To change the layout, drag any edge or corner of the window, or drag the divider between results and preview. Double-click an edge or the divider to reset it.

## How results are ranked

The default sort uses [BM25](https://en.wikipedia.org/wiki/Okapi_BM25), a standard search ranking formula. A note scores higher the more often the text appears, with diminishing returns, and long notes don't win just for being long. Needle then adds:

| Signal | Boost |
| --- | --- |
| The note's title is exactly the search | +3 |
| The note's title contains the search | +1.5 |
| The search appears in a heading | +1, plus a little for each further heading |
| The search appears in frontmatter | +0.5 |
| The note was modified recently | Up to +0.5, halving every 30 days |

Ties go to the most recently modified note, then to path order. You can also sort by **Recently modified** or **Path**.

## Go to note

Run **Needle: Go to note** to jump to a note, canvas or base.

- With nothing typed, it lists the notes you opened last. Open it and press <kbd>Enter</kbd> to go back to your previous note.
- Words can come in any order and match the title, an alias or a folder: `alpha plan` finds `Projects/Alpha/Plan`.
- Case and accents are ignored. Letters in order also match, so `dsys` finds "Design system".
- Notes already open are marked **Open**, and <kbd>Enter</kbd> switches to that tab.
- If nothing matches, <kbd>Enter</kbd> searches the text of your notes instead.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| Start with selected text | On | Search for the editor selection when Needle opens. |
| Show preview | On | Show the preview pane. Always off on phones. |
| Result limit | 1000 | Most matching lines to list, from 100 to 10,000. Match counts still cover every note. |
| Respect excluded files | On | Skip what's listed under **Files and links → Excluded files**. |
| Excluded folders | Empty | Folders Needle should never search, one per line. |

Search options, sort order, preview mode and window size are remembered between sessions.

## Cloud-synced vaults

Some sync tools keep notes only in the cloud until you open them, such as iCloud with **Optimize Mac Storage** or OneDrive Files On-Demand. Needle reads notes two at a time so Obsidian stays responsive. When a note takes longer than usual, which usually means it's being downloaded, Needle shows the results it already has and loads the rest in the background. Results update as notes arrive, and the header shows how many are left.

To avoid the wait on a Mac, right-click the vault folder in Finder and choose **Keep Downloaded**.

## Accessibility

- The search field and results follow the ARIA combobox and listbox patterns, so screen readers announce the selected match while focus stays in the field.
- Match counts are announced through a polite live region.
- Every control has a label, and toggles report their state.
- The divider can be focused with <kbd>Tab</kbd> and moved with the arrow keys, <kbd>Home</kbd> and <kbd>End</kbd>.
- The selected match is marked with a bar as well as color, and forced-colors mode is supported.

## Troubleshooting

**A note is missing from the results.** Check **Excluded folders** in Needle's settings and **Files and links → Excluded files** in Obsidian's. Needle only searches Markdown notes, and skips notes over 10 MB.

**The results say notes are still loading.** Your sync tool is probably fetching notes that are stored only in the cloud. See [Cloud-synced vaults](#cloud-synced-vaults).

**My regex was stopped.** Patterns with nested repeats, like `(a+)+$`, can take extremely long to run. Try a more specific pattern.

**My hotkey doesn't work.** Another command probably uses it. Check **Settings → Hotkeys** and remove the conflict.
