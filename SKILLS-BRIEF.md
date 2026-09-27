# Revising the Homey skills

A briefing for whoever revises Jon's three Homey skills — `homey-sync`,
`homey-documentation`, `homey-diagnostics` — against the rebuilt Homey Docs
Companion app and its MCP server.

Read this in full before editing any of them. The change is not cosmetic: one of
the three skills is built entirely on tools that no longer exist.

---

## What changed, and why

The app used to run a **documentation sync** model. It polled Homey every five
minutes, diffed the result, kept a changelog, and an assistant used that
changelog to make targeted edits to a folder of NotePlan notes describing the
flows. The notes were the record; Homey was the thing the notes tried to keep up
with.

That model is gone. The app now supports **live querying**: Claude reads Homey
directly whenever it needs to know something, and writes nothing down about
wiring. The reasoning was that a description of wiring is stale the moment
anything is rewired, and keeping a parallel set of markdown notes in step by
hand was the entire cost of the old approach with none of the benefit.

Three consequences drive every skill revision below.

1. **Change tracking is gone.** `poll_now`, `get_changelog` and
   `clear_changelog` no longer exist. Nor does the notion of a sync window, a
   `last_synced` date, a `flow_snapshot` hash, or a flow manifest.
2. **Wiring is never written down.** Not in a note, not in a file, not in a
   summary the user keeps. If you want to know what a flow does, you call
   `get_flow_summary`. Every time.
3. **Explanation lives on the flow's own canvas.** Homey advanced flows support
   note cards. Those are now the annotation layer — the app can read and write
   them, and `get_flow_summary` renders each note under the card it annotates.

---

## Where knowledge lives now

Three kinds, each kept where its source of truth naturally sits. This split is
the core idea; a skill that violates it is wrong regardless of how well it is
written.

| Kind | Where it lives | How it is read |
|---|---|---|
| Wiring, state, mechanical relationships | Homey itself | Live, every time, via MCP |
| Why a section of a flow is built as it is | A note card on that flow's canvas | `get_flow_summary` renders it inline |
| Everything else — cross-flow design, decisions, dead ends, device quirks, the backlog | Jon's own wiki (NotePlan) | The wiki skills, not these |

"Everything else" is a real category and the wiki still matters. What left the
wiki is the per-flow *description* of wiring. What stays is the reasoning that
spans flows and the context that isn't in Homey at all.

---

## The three skills

### `homey-sync` — retire it

This skill cannot be revised. Every tool it calls has been removed: `poll_now`,
`get_changelog`, `clear_changelog`. Its entire structure — sync windows,
`(changelog cleared)` completion markers, `flow_snapshot` frontmatter,
`last_synced`, the `Homey flow manifest` and `Homey change log` notes — describes
a model that no longer exists on either side.

Delete it. Do not try to port it.

Two things it did are worth keeping, but neither belongs in a skill of its own:

- Resolving raw card ids, zone ids and device ids to readable labels. The app
  does this now. `get_flow_summary` returns resolved names, tokens rendered
  inline, and the card graph as an indented tree. The whole "never show raw
  UUIDs to the user" apparatus is obsolete because the raw UUIDs no longer
  reach you.
- Noticing new undocumented flows. `list_flows_metadata` still lists everything;
  there is simply nothing to document them *into* any more.

Jon will need to decide separately what to do with the existing NotePlan flow
notes, the flow manifest and the change log. That is his call, not a skill's —
flag it, don't act on it.

### `homey-documentation` — narrow it hard, or retire it

Its job was to write a NotePlan note describing an area of Homey automation:
flows, the cards in them, dependency tables of devices, variables and apps.
Most of that is now the thing the new model exists to avoid. A note describing
which cards are in a flow is exactly the artefact that goes stale silently.

What survives is genuinely narrower: **documenting an area's design intent** —
why the heating is split across four flows, what was tried and abandoned, which
conventions apply, what a future change should be careful of. That is real
knowledge, it is not in Homey, and a wiki note is the right place for it.

So either narrow it to that, dropping every section that reproduces wiring, or
retire it and let the general wiki skills handle design notes. Suggest the
first; it is the more useful outcome, and the skill's structure and hub-linking
conventions are worth keeping.

Whichever way it goes, these must come out: frontmatter `flow_ids`,
`flow_snapshot`, `last_synced`; the flow manifest update phase; dependency
tables enumerating devices and variables; any section that walks the cards of a
flow.

### `homey-diagnostics` — revise and expand

This is the one Jon wants to use first, and it is the one that gains most. It
was written before the navigation tools existed, so it reaches for whole-flow
dumps where there are now much better options.

**Remove:** `get_changelog` from the tool list; the NotePlan documentation
lookups (`Homey flow manifest`, `Homey change log`, searching the wiki for a
flow's note) — the flow's own canvas notes are now the place intent is
recorded, and they are returned by `get_flow_summary` automatically.

**Keep unchanged:** the BST/UTC timezone handling. It is correct, it is the
most common source of wrong answers in this domain, and nothing about it
changed. Also keep the "what is NOT available via MCP" section about device
action history — still true, still the right thing to tell the user.

**Add** — these are the real gains, roughly in the order a diagnosis should
reach for them:

- `search_flows` — find the flows involved by what they contain, rather than
  guessing at names. Matches flow names, canvas notes, resolved card titles,
  device and variable names, and card arguments, and returns the lines that
  matched. This should usually be the first call once the user names a symptom.
- `get_cross_references` — the index of which flows read, write or trigger on
  each device, variable, FlowBits entity, Chronograph timer and programmatic
  flow trigger. Answers "what touches X?" without reading a flow at all.
- `trace_behaviour` — follows a behaviour across flows. Give it any name and it
  returns what affects it and what it affects, walking flow to flow through
  what they share. This is the tool for "why did X happen" when the cause is
  two flows away, which is the case the old skill handled worst. Start at
  depth 3.
- `get_flow_summary` — replaces `get_advanced_flow` and `get_flows_by_ids` for
  almost every diagnostic purpose. Resolved names, inline tokens, canvas notes
  under the cards they annotate, and the card graph as an indented tree showing
  execution order. Roughly 73% smaller than the raw flow and far less
  error-prone to read. Fall back to `get_advanced_flow` only when raw ids or
  card coordinates are genuinely needed.
- `list_apps` — installed apps, read live, with whether each is running. Worth
  a check when a flow looks correct but does not fire: a crashed or disabled
  app breaks every flow using its cards, and **nothing in the flow itself shows
  that** — the cards still resolve and read correctly in the summary. This is a
  failure mode the old skill had no way to see.
- **Read the canvas notes.** They are the author's own explanation of why a
  section exists, and they appear inline in `get_flow_summary`. Read them
  before inferring intent from structure. A red note means Jon intends to
  change that soon — treat it as a known-suspect area.

**Add a closing step that did not exist:** when a diagnosis works something out
that was not obvious from the wiring — why a guard is there, why two flows must
not both run, why the obvious simpler version fails — offer to write it as a
canvas note on the flow with `add_flow_note`. That is the one thing worth
persisting, and it belongs on the flow, not in a wiki note. Keep it to one
short sentence (see the note-writing rules below).

---

## Current tool inventory

34 tools. Grouped by what they are for, not alphabetically.

**Navigate — cheap to expensive, in this order**

- `list_flows_metadata` — every flow, basic and advanced, with name, folder,
  enabled, broken, card count. The cheapest overview.
- `list_folders` — Jon groups flows by area, so the folder is a strong hint.
- `get_cross_references` — the index of which flows use each device, BLL
  variable, Chronograph timer, programmatic flow trigger, and FlowBits entity
  (events, labels, sets, signals, modes, mode groups, timers, flags, cycles,
  sliders, no-repeat windows).
- `search_flows` — find flows by what they contain.
- `trace_behaviour` — follow a behaviour across flows, upstream and downstream.
- `get_flow_summary` — one flow, resolved and readable, notes inline. Takes
  `withCardIds: true` when you are about to edit.

**Read raw** — prefer the summary; these are for when you need ids or geometry

- `list_advanced_flows`, `get_advanced_flow`, `get_flows_by_ids`,
  `get_all_advanced_flows` (very large — full audits only)
- `list_flows`, `get_basic_flows_by_ids` (basic flows are flat If/Then/Else,
  not a card graph)

**Inventory**

- `list_devices` (name, zone, capabilities, network address, owning app),
  `list_zones`, `list_variables` (Homey Logic and Better Logic Library),
  `list_apps`, `get_app_actions` (readable titles for app card ids)

**Diagnose**

- `get_logs` — Simple (Sys) Log, newest first, with `search`, `since`, `limit`
- `get_diagnostics` — the companion app's own health
- `refresh_snapshot` — force a re-read if cached data looks stale (the cache is
  at most five minutes old)

**Write** — only if both opt-ins are set; see below

- Notes: `add_flow_note`, `update_flow_note`
- Cards: `add_card`, `remove_card` (needs `confirm: true`), `update_card_args`,
  `connect_cards`
- Flows: `create_advanced_flow`, `rename_flow`, `set_flow_enabled`,
  `set_flow_folder`, `relayout_flow`
- Undo: `list_flow_revisions`, `revert_flow`

There is **no delete tool**, deliberately. Recreating a flow gives it a new id
and breaks everything that triggers it. `set_flow_enabled(false)` is the
reversible way to stop a flow.

---

## Writing rules a skill must carry

**Wiring is read live, never written down.** No skill should instruct Claude to
record what a flow does anywhere outside Homey.

**Notes explain why, not what.** A note should say something the wiring cannot:
why this test is here, what breaks without it, which other flow it must not
fight with, why the obvious simpler version does not work. The test: if a
routine rewire would make the note false, it is a bad note.

**Notes must be short — one sentence.** This is not style. The layout holds
space beside a card for the note attached to it, so a long note makes that
column taller and every connector feeding it has further to travel. Jon's own
notes are typically four to eight words ("...and the fan is on...", "Night
mode"). Measured on a real flow: four notes at one sentence each cost 1796
units of connector travel; the same four at three sentences cost 4772.

**Note colours carry meaning.** Red means "I intend to change this soon" —
treat a red note as a known-suspect area. Yellow is the default, used for
section headings. Blue and green are inline explanations.

**Anything not about one specific flow goes in the wiki, not Homey.**

**Say when you are inferring.** Jon's flows are his own; their names do not
reliably describe what they do.

---

## Editing, and the two opt-ins

Writing is off by default and needs **both** of these, in the app's settings:

1. *Allow AI assistants to edit flows* turned on
2. A Homey **Personal Access Token** with Flows access pasted in — the app's own
   token can read flows but cannot change them

Leave either unset and every write tool refuses. A skill that offers to edit
should check `get_diagnostics` rather than discovering this by failing.

Every edit saves a pre-edit revision automatically, so anything can be undone
with `revert_flow`. Revision 1 is always the most recent save, and the numbers
shift down as new ones are added — so always call `list_flow_revisions` again
immediately before reverting rather than reusing a number from earlier.

Order of operations when building or restructuring a flow:

1. Make the card changes
2. `relayout_flow`
3. *Then* add notes

A note records only its position — Homey stores no anchor — so one added before
the cards are placed can end up labelling the wrong section. `add_flow_note`
detects the common cases: if the flow does not look laid out yet it colours the
note red and says so, and if there is no gap beside the anchor wide enough for
the note to read as belonging to it, it lays the flow out again to make one.

---

## Things that will bite

**Timezones.** Simple (Sys) Log stores UTC. Homey does not adjust for BST. From
the last Sunday in March to the last Sunday in October, log timestamps are an
hour behind local time. Convert before reporting, always. This is the single
most common source of a confidently wrong diagnosis.

**A flow with no Simple Log cards is invisible to `get_logs`.** Absence of log
entries is not evidence the flow did not run.

**Device action history is not available.** The per-device timeline in the
Homey app ("Turned on by flow X at 03:41") is not exposed by the local API.
If the responsible flow has no log cards, the Homey app's device view is the
only place to find it — tell Jon to look there.

**A crashed app is invisible in a flow.** Its cards still resolve and read
correctly. `list_apps` is the only way to see it.

**The cross-reference cache is up to five minutes old.** `refresh_snapshot`
forces a re-read. Flow reads for editing are always live regardless.

**`get_all_advanced_flows` is very large.** Full audits only.

---

## Where the detail is

- `PLAN.md` in this repo — the full build plan, step by step, with what was
  verified and what is still open. Long, and mostly about how the app was
  built rather than how to use it.
- `assets/homey-docs-companion-onboarding.md` — the user-facing orientation
  doc, including the first-run prompt. Overlaps this brief on the working
  rules; if the two disagree, this brief is newer.
- The tool descriptions in `mcp-server.js` are kept accurate and are the
  authority on any individual tool's behaviour.
