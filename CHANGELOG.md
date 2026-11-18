# Changelog

Versions follow [Semantic Versioning](https://semver.org/). A release is a plain `x.y.z` tag that
matches `manifest.json`; the GitHub mirror builds it and publishes it for Obsidian.

## 0.2.0 (2026-11-17)

A task manager window, start and due dates that map to PeckList's schedule, and the bird back in
Tasks queries. Works with PeckList 0.10 or later and Obsidian 1.13 or later, like 0.1.1.

- **Task manager:** one window with every PeckList task: tagged lines with their sync state,
  links whose line is gone, and tasks only in PeckList. Filter, search, and from a row: go to the
  line, open in PeckList, complete or reopen, move to another list, edit tags, link to another
  task, unlink, leave out, add a PeckList task to a note. Several rows can be moved, tagged,
  completed or left out at once. Open it from the ribbon, the command palette or the settings.
- **Fixed: no bird in Tasks queries.** Query results (and tasks the Tasks plugin draws in reading
  view) show the bird on linked tasks, with the same click and task menu as in the editor, and
  their PeckList tags are marked again. The bird sits in the same place everywhere: after the
  task's text, before its tags.
- **Dates:** 🛫 start sets the task's start date in PeckList (⏳ scheduled still does, on a line
  without 🛫). 📅 due always sets the due date. A start and a due date on different days make the
  task span those days, all day. Tasks synced before get their span once.

## 0.1.1 (2026-11-12)

Fixes from Obsidian's automated plugin review, and a first-sync problem on new accounts.

- The settings appear in Obsidian's settings search: the tab is built from Obsidian's declarative
  settings, so this release needs **Obsidian 1.13 or later** (0.1.0 stays available for older
  versions).
- A new PeckList account has no inbox until the app is opened once, and the first sync stopped
  with "Choose a default list". The review now warns before the first sync, and the message says
  to open PeckList once or choose a default list.
- The dotted underline on synced tags is a dotted border, which every supported Obsidian version
  draws.
- The task menu uses the plugin's own date helper instead of Obsidian's `moment`.
- The README says what the plugin lists in the vault and when it writes to the clipboard, and
  has screenshots.

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
