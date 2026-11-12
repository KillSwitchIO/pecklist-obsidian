# Changelog

Versions follow [Semantic Versioning](https://semver.org/). A release is a plain `x.y.z` tag that
matches `manifest.json`; the GitHub mirror builds it and publishes it for Obsidian.

## 0.1.0 (2026-11-11)

The first release.

- Two-way sync between task lines in the Tasks plugin's format and a PeckList server (0.10 or
  later) through its Task API v1: title, list, tags, priority, due and scheduled dates, repeats,
  done and won't do.
- `#pecklist` and `#pecklist/List` choose the list; missing lists are made.
- Sign in with the browser (a code you approve on your server), or paste an API key; the key stays
  in Obsidian's secret storage on each device.
- A review before the first sync, with a summary, to leave out folders, notes or lines; Select all
  and Unselect all.
- The hidden link shows as a bird in Live Preview: select it to open the task, right-click it for
  Open in PeckList, Complete, Won't do, Reopen, Move to list... and Delete task.
- Suggestions for PeckList lists and tags while typing a tag on a task line.
- Theme-safe marks on PeckList list tags and on tags sent to PeckList.
- A tag for every task from the vault in PeckList (`obsidian/<vault name>` by default); changing or
  clearing it updates the tasks already there.
- Repeating tasks completed in Obsidian complete once in PeckList; unticking the closed line
  reopens PeckList's closed copy.
