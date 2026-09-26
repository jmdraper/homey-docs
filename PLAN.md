# Homey Docs Companion — Development Plan

Status: steps 1–3 complete. Built one step at a time, in order.

## Context

The app currently supports a *documentation sync* model: it polls Homey every five
minutes, diffs the result, and exposes a changelog so an AI assistant can update a
folder of markdown files incrementally.

That model is being retired. The new approach is **live querying** — Claude reads
Homey directly through the MCP server whenever it needs to know something, rather
than maintaining a parallel set of markdown docs. This changes what the app needs
to provide: less bookkeeping, much better navigation and resolution, and the ability
to act on what it finds.

Three consequences drive the work below:

1. Change tracking becomes dead weight and comes out.
2. The cross-reference index becomes a primary navigation surface, so it needs to
   cover everything (FlowBits signals, modes, mode groups, timers — and devices).
3. The MCP server gains write access, which brings validation, recovery, and
   network-hardening requirements with it.

## Decisions taken

| Decision | Rationale |
|---|---|
| Drop per-flow `hash` and the sync-completion hooks entirely | Live querying makes staleness detection unnecessary; nothing else reads them |
| No MCP auth token | The threat model is browser-originated requests, not LAN peers; CORS lockdown addresses it directly and costs no client config |
| Lock down CORS + reject `Origin`-bearing requests | `Access-Control-Allow-Origin: *` with no auth lets any visited website read and (post-write) mutate flows. `mcp-remote` is a local Node process and needs no CORS at all |
| `writes_enabled` setting, default off | Guards against an agent misreading an instruction — a likelier failure than any attacker |
| Fine-grained write ops, no full-replace escape hatch | Advanced flow cards embed `x`/`y` coordinates and output-connection arrays; wholesale rewrites from an LLM produce dangling edges and stacked cards |
| Separate buckets for FlowBits vs Chronograph timers | Different namespaces with colliding names; mirrors the existing `variables` / `bll_variables` precedent |
| Dispatch FlowBits cards by **card-ID prefix**, not arg shape | `mode_activate` and `cycle` both use `args.name.name` — arg-shape dispatch cannot tell them apart |
| No flow-deletion tool; deletion stays a human action | Reversal is lossy regardless of backup — a recreated flow gets a new ID, breaking every inbound programmatic trigger |
| Keep a revision *stack* per flow in `/userdata`, not one slot in settings | Agent editing is iterative; a single pre-edit slot is overwritten by the second edit. Settings already carry `snapshot` and `xref_html` and should not hold bulk revisions |

## Step 1 — Remove change tracking ✅ done

The snapshot is *not* change tracking. `snapshot.flows[].cards_snapshot` is the data
source for the cross-reference builder and backs several MCP tools. It stays. Only
the diff/changelog layer on top comes out.

**`app.js`**
- Remove `MAX_CHANGELOG_ENTRIES`, `this.changelog`, `_addChange`, `_diffCards`,
  `getChangelog`, `clearChangelog`
- Remove `_computeHash` and `_sortKeys` (only consumers were hashing and diffing)
- Remove `hash` from `_flowMeta`
- Collapse `_poll()` (~110 lines of comparison branches) into `_refreshSnapshot()`:
  fetch, overwrite, save, regenerate the xref page
- `_saveState()` no longer writes the changelog
- Remove `getFlowSnapshot` — its only purpose was hash comparison; `get_advanced_flow`
  supersedes it

**`app.json`** — remove the `changelog`, `clear_changelog`, `flow_snapshot`, and
`sync_complete` API entries; remove the `sync_completed` trigger from the `flow`
section. Update the app description.

**`api.js`** — remove the corresponding handlers.

**`mcp-server.js`** — remove `get_changelog`, `clear_changelog`, `trigger_sync_complete`.
Rename `poll_now` to `refresh_snapshot` and update its description.

**Docs** — delete the CHANGE TRACKING section of `README.txt`. Rewrite
`assets/homey-docs-companion-onboarding.md`, which is built end-to-end around
changelog-driven incremental sync.

**Done when:** the app starts, refreshes its snapshot, and serves the cross-reference
viewer with no changelog code remaining. ✅ Verified on Homey: 112 flows, 244 devices,
28 zones; viewer and MCP server both serving.

**Delivered beyond the written plan**, each noted at the time:
- The snapshot now rebuilds on **every** app start, not just when absent. This made
  the `isAdvanced` backfill migration dead code, so it went too.
- REST endpoint `/poll` renamed `/refresh`, matching the `poll_now` →
  `refresh_snapshot` tool rename. Breaking for any external caller; nothing in the
  repo called it.
- The viewer's Refresh button now calls `_refreshSnapshot` instead of only
  `regenerateXrefPage`, so it re-reads Homey rather than redrawing stale data.
- One-time `settings.unset('changelog')` on boot to drop the obsolete data.
- `_mcpPort` resolved early in `onInit`, since the boot refresh regenerates the xref
  page and that page renders the MCP port into its setup instructions.

**Bugs found and fixed during testing** (all pre-existing, surfaced by the boot-time
refresh):
- `_apiGet` hardcoded `http.get`, so it threw `Protocol "https:" not supported`
  whenever `getLocalUrl()` returned an https URL — which it does when the app runs
  off-device. Both `_apiGet` and `bll-client._httpGet` now pick the client from the
  URL scheme.
- `bll-client._httpGet` scheduled its timeout *before* `const req = …`, so any
  synchronous throw from `.get()` left a live timer referencing an uninitialised
  binding — a TDZ `ReferenceError` inside a timer callback, which crashed the whole
  app. `req` is now declared before the timer, null-checked, and `.get()` is wrapped.
- `this.snapshot.flows` was assigned unconditionally, so a failed read emptied the
  cached index and regenerated the viewer from nothing. `_fetchAllFlows` now returns
  `null` to distinguish a failed read from an empty Homey, and the assignment is
  guarded like the device/variable/zone ones already were.

## Step 2 — Rewrite the FlowBits extractor ✅ done

`_extractFlowBitsRef` identifies entities by *which arg is present*. That cannot be
extended to the new types, because mode cards and cycle cards share an arg key:

    mode_activate  →  args.name.name    (a mode)
    cycle          →  args.name.name    (a cycle counter)

So this is a rewrite into a prefix→handler table, not an extension. FlowBits exposes
141 cards (38 triggers, 37 conditions, 66 actions), but they fall into regular
families, so the table is per-family with a card-type fallback. This step covers
every entity type FlowBits exposes — nothing is left for a later pass.

### Entity reference

All FlowBits autocomplete args serialise as `{ name: string }`.

| Entity | Card prefix | Key | Bucket |
|---|---|---|---|
| Events | `event_*` | `args.event.name` | `flowbits_events` *(existing)* |
| Labels | `label_*` | `args.label.name` | `flowbits_labels` *(existing)* |
| Sets | `set_*` | `args.set.name` + `args.state.name` | `flowbits_sets` *(existing)* |
| Signals | `signal_*` | `args.signal.name` | `flowbits_signals` **(new)** |
| Modes (ungrouped) | `mode_*` | `args.name.name` | `flowbits_modes` **(new)** |
| Mode groups | `mode_group_*` | `args.group.name` + `args.name.name` | `flowbits_mode_groups` **(new)** |
| Timers | `timer_*` | `args.timer.name` | `flowbits_timers` **(new)** |
| Flags | `flag_*` | `args.flag.name` | `flowbits_flags` **(new)** |
| Cycles | `cycle*` | `args.name.name` | `flowbits_cycles` **(new)** |
| Sliders | `slider_*` | `args.slider.name` | `flowbits_sliders` **(new)** |
| No-repeat windows | `no_repeat_*` | `args.window.name` | `flowbits_windows` **(new)** |

Chronograph timers remain in the existing `timers` bucket, keyed by `args.namedd.name`.

### Ordering and type traps

- **`mode_group_*` must be matched before `mode_*`** — it is a prefix collision.
- **`timer_finished` exists as both a trigger and a condition.** Role resolution must
  consider `card.type`, not the ID alone.
- **The base cycle action has the bare ID `cycle`**, not `cycle_…`. Prefix matching
  must not assume a trailing underscore or it will miss the most common cycle card.
- **Cycles and modes share `args.name.name`** but have distinct ID prefixes. This is
  precisely the collision that makes prefix dispatch mandatory rather than convenient.
- Modes have two independent namespaces — ungrouped (`mode_activate`) and grouped
  (`mode_group_activate`). They are different entities and need separate buckets.
- Some cards carry no entity arg at all (`mode_active`, `flag_active`, `event_clear_all`,
  `mode_reactivate_current`). They reference no specific entity and should be skipped.

### Role mapping

| Family | Action → | Condition → | Trigger → |
|---|---|---|---|
| Events | `fires` (`event_trigger*`), `clears` (`event_clear*`) | `checks` | `triggered_by`, `cleared_by` (`event_cleared`) |
| Labels | `writes` (`label_set`), `clears` (`label_clear`) | `checks` | `triggers_on` |
| Sets | `activates` / `deactivates` / `toggles` | `checks` | `triggers_on` |
| Signals | `sends` | — | `received_by` |
| Modes / groups | `activates` / `deactivates` | `checks` | `triggers_on` |
| Timers | `starts` (`timer_start*`, `timer_set*`, `timer_resume`), `stops` (`timer_stop`, `timer_pause`), `reads` (`timer_info`) | `checks` | `triggers_on` |
| Flags | `activates` (`flag_activate*`), `deactivates`, `toggles` | `checks` | `triggers_on` |
| Cycles | `advances` (`cycle`, `cycle_previous`, `cycle_between*`), `writes` (`cycle_to`) | `checks` | `triggers_on` |
| Sliders | `writes` | — | `triggers_on` |
| No-repeat windows | `clears` | `checks` | — |

### Bugs fixed in passing

- The extractor branches on suffix `label_is` — **that card does not exist**. The real
  condition is `label_has_value`. The dead branch falls through to the `cardType`
  fallback and happens to yield `reads`, so behaviour is accidentally correct, but
  `label_clear` is an action and gets tagged `writes` when it should be `clears`.
- `event_cleared` (a trigger) is unhandled and falls back to `triggered_by`, losing
  the distinction from `event_triggered`.

**Done when:** `get_cross_references` returns populated buckets for every new type
against real flow data. ✅ Verified against live Homey — 31 distinct FlowBits cards in
use across 359 instances, none unrouted. All 141 cards from FlowBits' own app.json
were driven through the extractor: 115 placed, 26 skipped, all 26 genuinely
entity-less.

**Corrected during implementation:** `mode_toggle` and `mode_group_toggle` were
landing as `activates`. The plan's role table gave modes only activates/deactivates,
but FlowBits has toggle cards for modes exactly as for sets and flags, and a toggle
can deactivate. Both now use `toggles`. Also declared `trigger_tokens` in the result
skeleton and added it to the enum — it was populated but not filterable.

## Step 3 — Devices as a cross-reference type, and viewer updates ✅ done

The index covers variables, events, labels, timers and flow triggers — but **not
devices**. "Which flows control the kitchen lights?" is likely the most common
question and is currently unanswerable.

**`app.js`** — new `devices` bucket. Card args already carry device IDs, and
`_deviceMeta` already resolves names and zones, so this is extraction plus a join
against `snapshot.devices`. Roles: `controls` (action), `checks` (condition),
`triggers_on` (trigger).

**`xref-template.js`** — add tabs for devices and every new FlowBits type; extend
`SECTIONS`, `SECTION_LABELS`, `ROLE_LABELS`, `ROLE_TOOLTIPS` and the `buildLegend`
role array. Mode groups reuse the grouped-entry rendering that sets already need.

**Existing bug:** `flowbits_sets` is collected by the backend but has **no entry in
`SECTIONS`** — sets have no tab, are excluded from the "All" count, and are invisible
in the viewer today. Fix as part of this step, since mode groups need the identical
grouped rendering.

**`mcp-server.js`** — extend the `get_cross_references` type enum.

**Done when:** every collected bucket is reachable in the viewer and counted in "All".
✅ 13 tabs render against live data, 394 entries in "All".

**Device extraction covers three patterns**, confirmed by scanning 5021 real cards:
`ownerUri: homey:device:<uuid>` on capability cards (1394 cards — the dominant form,
with the capability in the card id), `args.device` on app cards, and
`homey:device:<uuid>|<capability>` capability tokens read into other cards' arguments.
Result: 210 of 244 devices cross-referenced, with zone and capability lists resolved.

**Delivered beyond the written plan:**
- **Empty tabs are hidden.** With 16 possible sections, a Homey that uses none of
  sets/modes/cycles/sliders would show four permanent zero tabs. Only populated
  sections get a tab now.
- **The legend is derived from the data** rather than a hardcoded role list, so it
  cannot drift as roles are added.
- **Missing devices are flagged.** Devices referenced by a flow but absent from Homey
  get `missing: true` and a "not in Homey" badge — a deleted device whose cards were
  left behind. On the reference Homey nothing is currently flagged.

**Correction made after review.** The first implementation took the device id from
`card.ownerUri` and only the capability from `card.id`. That is wrong: on capability
cards the **card id is authoritative** (`homey:device:<id>:<capability>`), while
ownerUri carries a device uuid that usually agrees but can be stale. On the reference
Homey the two disagreed on 21 cards and ownerUri named two devices that no longer
exist, producing false "missing" reports for devices that were plainly present in the
flow editor. A further 15 cards carried a device card id with no device ownerUri and
were being skipped entirely. Separately, the `args.device` fallback admitted
app-internal identifiers — Pushover's is a notification target literally named
"iPhone" — so it now requires an id that resolves to a real device. Card ids resolved
100% against Homey's device list; ownerUri is no longer consulted.
- **Per-flow member chips** show which capabilities / states / modes each flow
  actually touches, not just that it touches the entity.
- Deleted `SECTION_LABELS`, which was defined but never referenced.

## Step 4 — Navigation tools

Both reduce the context Claude burns resolving identifiers before it can reason.

**`get_flow_summary(id)`** — the same flow as `get_advanced_flow`, but card IDs
resolved to human titles via the existing `getAppActions`, device/variable/zone UUIDs
resolved to names, and the connection graph rendered as an indented tree instead of
UUID arrays. Raw `get_advanced_flow` output is UUID soup; this should cut context
substantially and be read correctly first time.

**`search_flows(query)`** — full-text across flow names, card args, and resolved
device/variable names, returning flow IDs with matching card context. Currently
Claude's only options are to guess an ID or pull `get_all_advanced_flows` wholesale.

**Done when:** a named behaviour can be located and understood without fetching all
flows.

## Step 5 — MCP network hardening

Prerequisite for step 6. `mcp-server.js` sets `Access-Control-Allow-Origin: *` with
no authentication. Read-only, that leaks the full flow and device inventory to any
website visited on a machine that can reach the Homey. With writes, it hands over
control of the automations. Tailscale does not help — the browser is the courier.

- Remove the wildcard CORS headers entirely. `mcp-remote` is a local Node process,
  sends no `Origin`, and needs no CORS. The GitHub Pages viewer talks to the Homey
  app API via Athom, not to this port, so it is unaffected.
- Reject any request carrying an `Origin` header.
- Validate `Host` against the expected address and port — this is what stops DNS
  rebinding once CORS is gone.

**Done when:** `mcp-remote` still connects, and a cross-origin `fetch` from a browser
page is refused.

## Step 6 — Write support for advanced flows

**Infrastructure**
- Generalise `_apiGet` into `_apiRequest(method, path, body)` — JSON body, 200/201/204
  handling. `_apiGet` becomes a one-line wrapper.
- Establish the write path. `ADVANCED_FLOW_PATHS` currently probes GET only; confirm
  `PUT {path}/:id` semantics against real Homey — full object vs partial, which fields
  are rejected (`id`, `broken`, `triggerable`), and how much the server validates.

**Tools** — fine-grained, each read-modify-write server-side:
`set_flow_enabled`, `rename_flow`, `update_card_args`, `add_card`, `remove_card`,
`connect_cards`, `create_advanced_flow`.

**Deletion is deliberately out of scope.** There is no `delete_advanced_flow` tool and
no plan to add one. Deletion is the only operation whose reversal is lossy no matter
whose backup is used: recreating a flow assigns a **new ID**, so every inbound
programmatic trigger still points at the dead one, and neither our revisions nor a
Flow Version History import restores folder placement or enabled state. An agent never
needs it — `set_flow_enabled(false)` plus a rename is the reversible equivalent.
Deleting stays a human action in the Homey UI.

**Card graph integrity.** Cards embed `x`/`y` coordinates and output connections
(`outputTrue` / `outputFalse` / `outputSuccess` / `outputError`, arrays of card UUIDs).
Before any write, validate: no unknown card UUID references, no dangling connections,
no duplicate IDs, no cards owned by uninstalled apps. Fail with a clear message rather
than writing a broken flow. `add_card` needs auto-layout so new cards do not land on
top of existing ones.

**Recovery and safety**
- **A revision stack, not a single slot.** Before every write, snapshot the current
  flow JSON to `/userdata/revisions/<flowId>/<timestamp>.json`, with an index in app
  settings, keeping the last N (default 10, configurable). One pre-edit slot is close
  to useless for agent editing, which is iterative — the second edit would overwrite
  the backup of the state you actually want back. This introduces the app's first
  `/userdata` usage (`fs` is currently only used to read the bundled onboarding file);
  keeping payloads out of settings follows Flow Version History's pattern, and settings
  are already heavy with `snapshot` and `xref_html`.
- `list_flow_revisions(id)` to see what is available, and `revert_flow(id, revision?)`
  defaulting to the most recent.
- `writes_enabled` app setting, default off.
- MCP tool annotations (`readOnlyHint: false`, `destructiveHint: true`) so clients prompt.
- `confirm: true` required on `remove_card` — the most destructive remaining operation.

**Independent safety net (operational, not code).** Install **Flow Version History**
(`nl.dypodex.versionhistory`) and set *Maximum revisions per Flow* to **20**; the
default of 5 rolls off after six sequential edits. It subscribes to Homey's realtime
flow events, so it captures every change regardless of source — including manual edits,
which our revisions never see — and critically it does **not** share a failure domain
with our write code: if our write path has a bug, our own backup logic is written by
the same hand against the same assumptions. Know its limits before relying on it.
"Restore" is a *download* plus a manual ALT-import that creates a **new** flow; it
saves only `{name, cards}`, so folder and enabled state are lost; and its 30-day trash
is what covers the manual deletions we just pushed out of scope.

**Post-write coherence.** After a successful write, re-fetch that one flow into
`snapshot.flows[id]`, invalidate `this._xrefCache`, and regenerate the xref page —
otherwise the viewer serves stale cross-references. The background refresh must not
clobber a write in flight.

**Docs** — the viewer Setup panel and `README.txt` need the write-mode opt-in explained.

**Done when:** a card argument can be edited through MCP, listed as a revision, and
reverted to any retained revision, with the viewer reflecting both.

## Step 7 — Deeper navigation, post-write

Deferred until writes land, because both benefit from the graph and storage work above.

**`trace_behaviour(target)` — transitive dependency walk.** The graph pieces already
exist: `flow_triggers` maps flow→flow, and the variable/event/mode indices map
flow→state→flow. Unify them into one graph and walk it transitively, so "what does
this thermostat variable touch, upstream and downstream" returns a connected subgraph
rather than a single hop. This is the direct answer to behaviour spread across several
complex advanced flows.

**`set_flow_note(id, text)` — persistent annotation layer.** Stored in app settings,
returned inline with every flow read. With the markdown docs system retired, this gives
Claude somewhere to accumulate understanding across sessions without an external folder
— a much lighter replacement for what the sync workflow provided.

**Done when:** a single call explains a multi-flow behaviour, and notes written in one
session are visible in the next.

## Follow-ups

Spotted while working; none blocking, all deferred deliberately.

- **`snapshot.apps` is a dead path.** `_appMeta` is never called, and `getApps()` and
  the `/apps` endpoint have always returned `{}` — neither the old `_buildSnapshot`
  nor `_poll` ever populated it. Either wire it up or delete all three. Pre-dates this
  work.
- **Step 5 must also cover the xref server on port 8734**, not just MCP on 8735. It
  exposes an unauthenticated `POST /settings` that persists `xref_base_url` into app
  settings, and a `POST /refresh` that now triggers a full Homey re-read. Same class
  of problem, same fix.
- **The onboarding doc needs another pass after steps 4 and 6.** It was rewritten for
  live querying, but its prompt can only teach Claude about tools that exist today —
  `get_flow_summary`, `search_flows`, and the write tools will each change the advice
  it gives.
- **Confirm whether Better Logic Library is actually installed.** During testing
  `[BLL] /ALL returned no usable data: []`. Handled gracefully, but if BLL *is*
  installed with variables defined, the empty result is worth investigating — the
  `bll_variables` bucket would be silently empty.

### Deferred from step 3

- **`trigger_tokens` has no viewer tab, deliberately.** It holds 93 entries, but its
  keys are opaque `<cardUuid>::<tokenName>` pairs — a tab would show 93 UUIDs. Making
  it useful needs card-title resolution, which is exactly what `get_flow_summary`
  builds in step 4. Revisit then; it is the one bucket not reachable from the viewer.
- **Watch the size of `xref_html`.** The rendered page is now ~192KB held in app
  settings; devices roughly doubled it. Fine today, but it grows with the estate.

## Development workflow

`homey app run` does **not** run the app on the Homey. It runs it in a Docker
container on the development machine, talking to the Homey remotely over its API, and
maps only the debugger port 9229. The cross-reference viewer (8734) and MCP server
(8735) bind inside that container and are unreachable from both the Mac and the
Homey's IP. It is fine for checking startup, logs and data fetching — and it is how
the https scheme bug was found, since off-device execution is what makes
`getLocalUrl()` return an https URL.

To test anything that listens on a port, use `homey app install`, which installs the
working tree onto the Homey itself. Note that this replaces the currently installed
app.

## Build order

Steps run in sequence. 1 shrinks the surface before anything is added to it; 2 and 3
share extraction code; 4 depends on 3's resolution helpers; 5 gates 6; 7 builds on 6.
