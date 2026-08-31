# Homey Docs Companion — Getting Started with AI Documentation

Once you've installed the Homey Docs Companion app and configured the MCP server,
paste the prompt below into your AI assistant. It will guide you through building
a living documentation system for your Homey setup — flows, variables, devices,
and automations — that stays up to date as your home evolves.

---

## What you'll end up with

- A folder of markdown files (one per logical area of your home automation) that
  describe in plain English what your flows do, how they interact, and what they
  depend on
- A flow manifest file: a central index mapping every flow to its documentation file
- A change log file: a running audit trail of every change detected in Homey
- YAML frontmatter in every file so the AI can detect exactly what changed and
  update only the affected sections — without re-reading everything from scratch

The files are plain `.md` files you can keep anywhere — a folder on your Mac or PC,
an Obsidian vault, a Foam workspace in VS Code, or any other tool that handles
markdown. The YAML frontmatter is read and written by the AI only; most markdown
tools will either display it as structured metadata or quietly ignore it.

> **Note on nested YAML:** Obsidian's built-in Properties panel and Logseq both
> have limited support for nested YAML structures. The frontmatter format used here
> is intentionally flat to ensure compatibility — `flow_snapshot` is stored as a
> list of strings rather than a nested map, so it works reliably in all tools.

---

## Prerequisites

Before pasting this prompt, confirm:

1. **Homey Docs Companion app** is installed and running on your Homey Pro
2. **MCP server** is configured and connected to your AI tool
3. You can call `get_snapshot` and get a valid JSON response listing your flows

---

## Onboarding prompt

---

```
I've just set up the Homey Docs Companion app and MCP server. I want to build
a documentation system for my Homey home automation setup — a folder of markdown
files that describe what my flows do and that stay up to date automatically as I
make changes. Please guide me through the full setup.

## About my setup

I use Homey Pro to automate my home. My flows, devices, and variables are all
my own — please don't assume anything about what they do or how they're named.
Start by reading my actual Homey data.

## What I want to end up with

1. A set of markdown (.md) files — one per logical area of my home automation
   (e.g. lighting, heating, security, presence) — each containing:
   - A plain-English description of what the flows in that area do
   - How they work together and what triggers them
   - What devices, variables, and other flows they depend on
   - YAML frontmatter tracking which flow IDs are in the file, their last-known
     state, and when the file was last synced

2. A "homey-flow-manifest.md" file: a central index with one row per flow,
   showing which documentation file it belongs to, its current card count and
   hash, and whether it's undocumented

3. A "homey-change-log.md" file: a running human-readable audit trail of changes
   detected by the companion app

## Frontmatter format

Every documentation file must have this YAML frontmatter at the top. Use this
exact flat structure — do not use nested YAML objects, as some markdown tools
don't handle them reliably.

---
flow_ids:
  - 00000000-0000-0000-0000-000000000001
  - 00000000-0000-0000-0000-000000000002
flow_hashes:
  - "00000000-0000-0000-0000-000000000001: Example flow one | enabled | cards:12 | hash:a1b2c3d4"
  - "00000000-0000-0000-0000-000000000002: Example flow two | disabled | cards:7 | hash:e5f6a7b8"
last_synced: "2026-05-24T10:30:00Z"
---

The `flow_hashes` list uses a compact string format so each flow's state is
readable in plain text and works in any markdown tool. The format is:
`"[flow_id]: [name] | [enabled|disabled] | cards:[N] | hash:[hash]"`

When performing a sync, parse each string by splitting on ` | ` to extract the
hash value, then compare it against the `hash` field returned by
`list_flows_metadata` for the same flow ID. A mismatch means the flow has
changed and its documentation section needs updating. If the flow ID is present
in `get_changelog` results, the diff entries there tell you exactly what changed
without needing to re-read the full flow.

## Tool reference

Here is every MCP tool available, what it returns, and when to use it. Refer
back to this section whenever you are unsure which tool to call.

**`get_snapshot`**
Returns a single JSON object containing all flows (metadata only, no card
payloads), variables, devices, apps, and zones in one call. Each flow entry
has: `name`, `enabled` (bool), `broken` (bool), `cards` (count), `hash`
(16-char SHA-256 of the full card payload). Use this for the initial survey
at Step 1 to get a broad picture of the setup in one call.

**`list_flows_metadata`**
Returns a map of `{ [flow_id]: { name, enabled, broken, cards, hash } }` for
every flow. Identical to the flows portion of `get_snapshot` but callable on
its own. Use this during sync to compare current hashes against the `flow_hashes`
strings stored in frontmatter, to confirm which flows have actually changed.

**`get_flows_by_ids`**
Accepts a list of flow IDs and returns full card payloads for each — triggers,
conditions, and actions with all arguments. This is the expensive call; only
use it for flows you already know have changed (from `get_changelog` or a hash
mismatch). Never call it for all flows. The card args contain the actual values
you need to document: threshold numbers, timer durations, announcement strings,
variable references, device IDs.

**`get_changelog`**
Accepts optional `since` (ISO 8601 datetime string) and optional `types` (array
of change type strings). Returns an array of change entries, each with: `ts`
(timestamp), `type` (e.g. `flow_modified`, `device_added`), `id`, `name`, `from`
(previous state), `to` (new state), and for `flow_modified` entries a `diff`
array. Each diff entry has `type` (`args_changed`, `card_added`, `card_removed`,
`connections_changed`), plus `from` and `to` objects showing old and new argument
values for `args_changed`. This diff is what allows targeted single-sentence
updates — you don't need to re-read the whole flow.
Use this as the first call in every sync check, with `since` set to the earliest
`last_synced` value found across all documentation files.

**`list_variables`**
Returns a map of `{ [variable_id]: { name, type, value } }` where type is
`boolean`, `number`, or `string`. Flow cards reference variables by ID; use
this to resolve those IDs to readable names when documenting or updating the
Dependencies table.

**`list_devices`**
Returns an array of devices: `{ id, name, class, capabilities[], available,
zoneId, zoneName, address, appId }`. `zoneId` is the raw zone ID and `zoneName`
is already resolved to a readable room name (no need to cross-reference
`list_zones` just to get a name). `address` is the device's LAN IP/hostname
when one is known (locally-addressable devices like Shelly), otherwise `null`.
`appId` is the ID of the app/driver that owns the device (e.g. `cloud.shelly`),
useful for filtering "all devices from app X". Flow cards reference devices by
ID; use this to resolve IDs to names. Also use it to check whether devices
mentioned in documentation still exist in Homey, or to group devices by room.

**`list_apps`**
Returns a map of `{ [app_id]: { name, version, enabled, crashed } }`. Use when
documenting which apps a flow depends on (e.g. Chronograph, Heimdall, VThermo),
or when an `app_updated` changelog entry suggests an app's actions may have
changed.

**`list_zones`**
Returns a map of `{ [zone_id]: { name, parent } }` where `parent` is either
another zone ID or null for top-level zones. Use this to reconstruct the zone
hierarchy and to resolve zone IDs that appear in zone-based flow triggers.

**`clear_changelog`**
Clears all stored changelog entries on the companion app. Only call this after
a sync is fully complete and all changes are reflected in the documentation
files. Do not call it mid-session — the changelog is the only record of what
changed since the last sync.

---

## Step 1 — Survey my setup

Please start by calling these tools to understand what I have:

- `get_snapshot` — get an overview of all flows, variables, devices, apps, zones
- `list_flows_metadata` — get the full list of flows with names and IDs
- `list_variables` — get all Homey Logic variables
- `list_devices` — get all devices and their zones
- `list_zones` — get my zone structure

Then present me with:
- A count of flows, variables, devices, and zones
- My zone hierarchy (so we can use it to suggest documentation groupings)
- A proposed set of documentation files — suggested filenames and which flows
  would go in each, based on flow names, zones, and any folder structure visible
  in the metadata

Do not invent groupings — base them on what you can see in the data. If flow
names are ambiguous, say so and ask me.

## Step 2 — Agree the file structure

Before writing anything, show me the proposed file list and ask me to confirm,
rename, merge, or split any groupings. I'll tell you if I want to combine areas
or separate them differently.

Only proceed to Step 3 once I've approved the structure.

## Step 3 — Document each area

For each agreed documentation file, in turn:

1. Call `get_flows_by_ids` for the flows in that area
2. Read the full card data and write a markdown file with these sections:
   - **Overview**: 2–3 sentences on what this area of the home does
   - **Flows**: one subsection per flow, describing in plain English:
     - What triggers it
     - What it does (conditions checked, actions taken, branches)
     - Any timers, thresholds, or key values (with the actual values, not
       placeholders)
   - **How the flows work together**: if flows call each other, are mutually
     exclusive, or share state via variables, explain that here
   - **Dependencies**: a table of variables, devices, and apps this area relies on
3. Add YAML frontmatter at the top of the file using the flat format described
   above, populated with data from `list_flows_metadata`
4. Output the complete file contents so I can save it, then ask whether to
   continue to the next area or pause

Work through areas one at a time. Don't batch them all — I want to review each
before you move on.

## Step 4 — Create the flow manifest

Once all areas are documented, output a "homey-flow-manifest.md" file with:

---
last_synced: [current ISO datetime]
---

# Homey flow manifest
Central index of all documented Homey flows.

## Documented flows
| Flow ID | Flow name | File | Cards | Hash | Last synced |
|---|---|---|---|---|---|
[one row per documented flow]

## Undocumented flows
[any flows not yet assigned to a file — leave table empty if none]
| Flow ID | Flow name | Detected |
|---|---|---|

## Deleted flows
[empty for now]
| Flow ID | Flow name | Was in file | Deleted at |
|---|---|---|---|

## Step 5 — Create the change log

Output a "homey-change-log.md" file:

---
last_synced: [current ISO datetime]
---

# Homey change log
Running record of changes detected by the Homey Docs Companion app.
Entries added automatically during sync. ✅ = documented, ⏳ = pending.

## [today's date]
Initial documentation created.

## Keeping documentation up to date

Once setup is complete, whenever I say "sync my Homey docs" or "check for
Homey changes", please:

1. Read my documentation files to find the earliest `last_synced` value
2. Call `get_changelog(since: [that date])`
3. If changes are found, show me a summary grouped by documentation file
4. Fetch only the changed flows using `get_flows_by_ids`
5. Output updated versions of only the affected files — change specific values,
   not whole sections, unless the flow structure itself changed
6. Update `flow_hashes` and `last_synced` in the frontmatter of each updated file
7. Output an updated flow manifest and a new change log entry

## Notes on tone and style

- Write documentation for a technically-minded homeowner, not a developer
- Prefer plain English over card/node terminology (say "checks whether the lux
  level is below 300" not "evaluates condition card homey:manager:logic:smaller_than")
- Include actual threshold values, timer durations, and announcement strings —
  these are the details most likely to need updating
- If a flow name is cryptic, ask me what it does before documenting it

Please start with Step 1 now.
```

---

## After first run

Once the initial documentation is built, syncing is lightweight. Whenever you've
made changes in Homey — added a flow, tuned a threshold, renamed a device — just
tell your AI assistant:

> "Sync my Homey docs"

It will call `get_changelog` to find exactly what changed, fetch only the affected
flows, and output updated versions of only the files that need changing. Everything
else is left untouched.

---

## Where to keep your files

The markdown files work with any of the following:

- **NotePlan** — if you're using NotePlan, tell your AI assistant at the start of
  the setup. It can create and update notes and frontmatter directly via the
  NotePlan MCP, rather than outputting files for you to save manually. This gives
  a smoother experience than the generic approach — frontmatter fields are updated
  in place without touching the note body.
- **Obsidian** — drop them into your vault. The frontmatter appears as Properties.
  Note that Obsidian's Properties panel doesn't edit nested YAML, but since this
  format is flat, everything displays cleanly. Use the Dataview plugin if you want
  to query across files.
- **Foam (VS Code)** — add the files to your Foam workspace folder. Frontmatter
  is fully supported and wiki-links work if you add them.
- **A plain folder** — the files are just text. Any editor works.
- **Git repository** — storing them in git gives you a free history of every
  documentation change, separate from the Homey change log.

---

## Tips

**Be specific about file names.** The AI will suggest groupings based on your
flow names. If the suggestions don't match how you think about your home, say so
— "merge heating and climate into one file" or "split lighting into downstairs
and upstairs" are perfectly good instructions.

**Document one area at a time.** Large flows with many cards take a moment to
process. Reviewing each file before moving on catches misunderstandings early.

**The companion app tracks everything from the moment it starts.** Changes made
before the app was installed won't appear in the changelog, but the initial
snapshot captures the current state of all flows, variables, and devices.

**If the AI makes assumptions about what a flow does**, correct it. The card data
is structured but not always self-explanatory — an announcement string is clear,
but a numeric threshold needs context to interpret correctly.
