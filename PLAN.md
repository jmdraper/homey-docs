# Homey Docs Companion — Development Plan

Status: steps 1–7 built; step 7 awaiting on-device testing. Built one step at a time, in order.

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
| Canvas notes are the annotation layer; no annotation store in app settings | A per-flow cache of "understanding" is the stale-description problem again — wiring should be re-derived live. Most knowledge worth keeping spans flows or is not about flows at all, so a per-flow-id store is the wrong shape. Settings are invisible in the Homey editor, cannot be edited by hand, are lost when the app is uninstalled, and are orphaned when a flow is recreated with a new id — the same argument the plan uses against a deletion tool. Notes are cards, so Flow Version History backs them up; settings it does not. Settings already carry `snapshot` and a ~192KB `xref_html` |
| Notes attach to cards by geometry, not a stored link | Homey stores no anchor on a note; position is the only signal there is. Attach to the nearest card within a threshold, and leave distant or ambiguous notes as flow-level |
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

## Step 4 — Navigation tools ✅ done

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
flows. ✅ `get_flow_summary` renders 73% smaller than `get_advanced_flow` on a
representative flow and matches the flow editor's structure exactly.

**What the summary resolves:** device/zone/variable ids to names (with zone in
brackets), `[[...]]` tokens to readable placeholders like `{trigger.value}` and
`{Outside temp}`, card ids to their registered titles, and flow folder ids to folder
names. The card graph renders as an indented tree following outputTrue / outputFalse /
outputSuccess / outputError, with each branch named once and its children nested
beneath. Cards reachable by more than one path are rendered once and then referenced,
which bounds the output on diamond-shaped graphs.

**Canvas notes are included.** Advanced flows carry `note` cards — the author's own
annotations, 517 of them across the reference Homey. They are the single best
statement of intent available and are listed above the tree.

**Card-type coverage:** the graph handles `trigger`, `condition` (including
`inverted`, rendered as IF NOT), `action`, `all`, `any`, `delay`, `start` and `note`.
Basic flows render as a flat WHEN / IF / THEN list.

**Depends on two Homey endpoints that can only be verified on-device**, since a
development run has no Homey API: `/manager/flow/flowcard{trigger,condition,action}`
for card titles and `/manager/flow/folder` for folder names. Both are wrapped in
try/catch and degrade to the raw card-id suffix and the folder uuid respectively, so
a missing endpoint costs readability rather than correctness.

## Step 5 — MCP network hardening ✅ done

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
page is refused. ✅ 16 guard cases and 5 end-to-end HTTP cases pass.

**Both servers are covered**, with different rules, because their clients differ:
- **MCP (8735)** has no browser client at all — `mcp-remote` is a local Node process
  that sends no Origin — so *any* Origin header is rejected outright. A CORS preflight
  is therefore refused at the guard, which also fails the real request behind it.
- **Viewer (8734)** is itself a browser page that POSTs back to `/settings` and
  `/refresh`, so an Origin is expected there but must match the Host. That closes the
  unauthenticated `POST /settings` noted in the step 3 follow-ups.

**Host validation** accepts addresses that cannot be pointed at this Homey by an
attacker's DNS: IPv4 and IPv6 literals, `localhost`, and mDNS `.local` names. Anything
else is refused unless listed in a new **Additional allowed hosts** setting — which is
what a Tailscale MagicDNS name needs, since `homey.tailnet-name.ts.net` is a real DNS
name and therefore reboundable. Access by plain Tailscale IP needs no configuration.

**The app had no settings UI at all.** `app.json` carried a `settings` array, which
validates but renders nothing — Homey app settings come from a custom
`/settings/index.html`, which this app never had. So `xref_port`, `mcp_port` and
`xref_base_url` had been unconfigurable since the app was written, which is why the
viewer grew its own Setup panel with a base-URL field. Adding a setting for allowed
hosts surfaced this, because a setting nobody can reach is not a setting. A real
settings page now exists, listing refused hosts with an Allow button beside each, and
the inert array is gone.

With the setting reachable in the proper place, the viewer's Setup step 3 and the
`GET`/`POST /settings` routes behind it were removed. That deletes the unauthenticated
write endpoint outright rather than merely guarding it, which is the better outcome.
The base URL is also no longer cached at startup: it was read once in `onInit`, so
editing it left flow links pointing at the old URL until the app restarted. It is now
read through, and a `settings.on('set')` listener rebuilds the page — which bakes the
URL in at generation time — as soon as it changes.

**Reverse proxies need configuring.** A proxy forwards its own hostname, so the guard
refuses it and the viewer stops working — and a proxy may report that upstream 403 as
a 502, hiding the reason. The hostname must be added to **Additional allowed hosts**.
This is a real access pattern the README documents, so it is called out there too, and
rejected requests are now recorded in `getDiagnostics` (`recentlyRejected`) so the
host to allow is discoverable rather than guessed at.

**No token, deliberately** — see the decisions table. The guards address the attack
that network trust does not cover; a shared secret would add client configuration
without addressing it.

## Step 6 — Write support for advanced flows ✅ done

**Editing requires a Personal Access Token — a platform constraint, not a choice.**
The app's own token (`getOwnerApiToken`) carries `homey.flow.readonly` but not
`homey.flow`, so every write returns HTTP 403 "Missing Scopes". Verified against
`GET /manager/sessions/session/me`, which needs no scopes and reports the session's
scopes: broad on reads, plus `homey.device.control`, but no write scope for flows,
logic or zones. Apps may control devices; they may not rewrite automations.
`HomeyAPI.createAppAPI()` is not an alternative — its source calls
`getOwnerApiToken()` itself. So the user must create a token in the Homey web app and
paste it into the app settings; writes use it, reads keep using the app's own token.
Two deliberate opt-ins rather than one, which suits the feature.

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

**Addressing a card to edit it.** `get_flow_summary` is deliberately lossy — no card
ids, no coordinates, arguments truncated — because it exists to be read cheaply. But
every write tool takes a card id, and a summary gives Claude no way to name the card
it just read about: there is nothing in `THEN Sewing room Shelf lights - Turn off` that
identifies which card that is. Without a fix, the flow becomes read summary, re-fetch
the raw flow, re-identify the card by matching on its contents — which reintroduces
exactly the error-prone matching step the summary was built to remove, and on a flow
with eight identical `Turn off` cards it is ambiguous.

Likely answer: an opt-in `withCardIds` argument on `get_flow_summary` that prefixes
each line with the card's short id, so reading-for-understanding stays cheap and
reading-to-edit is addressable. Decide when building the write tools, since the exact
shape depends on what they take. The convergence markers (`[1]`, `[2]`) already in the
output are sequential render positions, not card ids, and are not a substitute.

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
reverted to any retained revision, with the viewer reflecting both. ✅ Verified on a
live flow: a log card's text was changed through `update_card_args` (addressed by an
eight-character id prefix), the change appeared in `get_flow_summary`, a revision was
written, and `revert_flow` restored the arguments byte-identically.

**Also exercised on live flows:** `create_advanced_flow`, `add_card`, `connect_cards`,
`remove_card`, `set_flow_enabled`, `rename_flow`, `list_flow_revisions`,
`revert_flow`, and `relayout_flow` — the last added during the step, since placement
logic that only ran for newly added cards could not tidy a flow that already existed.

**Found by testing, beyond the plan:**
- **ALL cards carry an explicit `input` array** of `"<cardId>::<output>"` entries, one
  per incoming connection — 257 of 257, no other type has one, and Homey sizes the
  card from it. The write tools edited output arrays without maintaining it, so
  connecting anything to a gate left it disagreeing with its own connections. Every
  write now rebuilds these from the edges before validating.
- Creating a flow with no cards is rejected (`Advanced Flow is empty`), so
  `create_advanced_flow` seeds a `start` card.
- Rebuilding the whole cross-reference page on every write made a 53-write build kill
  the app; the rebuild is now deferred and coalesced.
- A note attached before a flow is laid out is filed against a meaningless position.
  It cannot be prevented — position is the only anchor Homey stores — so the note is
  coloured **red**, matching the convention that red means "change this soon".

## Step 7 — Trace behaviour, and canvas notes as the annotation layer ✅ built

### Where knowledge lives

Three kinds of knowledge, each kept where its source of truth naturally sits:

1. **Wiring, state and mechanical relationships** — read live from Homey through this
   app (`get_flow_summary`, `search_flows`, `get_cross_references`,
   `trace_behaviour`). Never cached as prose.
2. **Why a section of a flow is built the way it is** — a canvas note card on that
   flow, beside the section it explains. The reference Homey already carries 521 of
   them, and `get_flow_summary` already surfaces them.
3. **Cross-flow design, decision history, abandoned approaches, house and device
   context, conventions, backlog** — kept outside Homey entirely, in the user's
   NotePlan wiki. This app neither stores nor knows about it.

### A. `trace_behaviour(target)` — unchanged

**Scope, decided before building:** the target may be any named entity — a variable,
device, flow, or FlowBits event, mode, flag, timer or signal — with the type
auto-detected from the cross-reference index. It walks both directions to a default
depth of 3 hops, overridable, and renders an indented text tree in the manner of
`get_flow_summary`. Bounding by depth is what stops a hub such as a house-state
variable returning a large fraction of the estate in one call; the text form keeps it
cheap to read.

Direction is causal rather than structural: a flow that **writes, fires, activates,
controls or sends** an entity is upstream of it, and one that **reads, checks or
triggers on** it is downstream. So walking downstream from a variable finds the flows
that react to it, then whatever those flows go on to change, and so on.

The graph pieces already exist: `flow_triggers` maps flow→flow, and the
variable/event/mode indices map flow→state→flow. Unify them into one graph and walk it
transitively, so "what does this thermostat variable touch, upstream and downstream"
returns a connected subgraph rather than a single hop. This is the direct answer to
behaviour spread across several complex advanced flows.

### B. Canvas note write tools

Built on the step 6 write path, so each inherits the `writes_enabled` gate, the
Personal Access Token, a revision snapshot before every write, graph validation,
post-write re-fetch and cross-reference invalidation, and the MCP annotations.

**The note card's shape**, from all 521 on the reference Homey — inspected, not assumed:

| Field | Value |
|---|---|
| `type` | `"note"` |
| `value` | the text — a **top-level field, not an argument** |
| `color` | `yellow` (443), `blue` (44), `green` (24), `red` (10) |
| `x`, `y` | position — the only record of what the note refers to |
| `width`, `height` | **always `null`**, on every one of the 521; Homey sizes them at render time |
| `id` | present on 107, always the literal string `"undefined:undefined"` — an editor artefact carrying no meaning |

There is no anchor, parent or link field of any kind. A note floats.

**`update_card_args` cannot edit note text.** Checked rather than assumed: it assigns
`card.args`, and a note's text is `card.value`. A separate tool is needed.

- `add_flow_note(flowId, text, nearCardId?, color?)` — creates a note card. With
  `nearCardId`, auto-layout places it beside that card, clear of every other card;
  without, it goes in free space as a flow-level note. Rejects basic flows with a
  clear message — they have no canvas.
- `update_flow_note(flowId, noteCardId, text)` — sets `value`.
- Removal uses the existing `remove_card` with `confirm: true`.

Placement reuses the geometry already measured for the layout work: a heading note
sits its own height above the card it labels, and note height is estimated from text
length, since the stored height is null.

### C. Attach notes to cards in `get_flow_summary`

**Partly built already.** The summary attaches each note to its nearest card and
prints it as a `#` line at that card's depth. Three things are missing: a distance
threshold, handling of ambiguity, and note card ids.

Measured across all 521 notes:

| distance from a note to its nearest card | |
|---|---|
| min | 60 |
| median | 80 |
| 75th percentile | 120 |
| 90th | 160 |
| 95th | 233 |
| max | 3841 |

The long tail is real — some notes sit nowhere near anything. The margin between the
nearest and second-nearest card has a median of 120, but **58 of 521 (11%) are within
40px of each other**, so ambiguity has to be handled rather than resolved.

**Measure centre to centre, not between bounding boxes.** Bounding boxes were tried
first, as originally specified, and are worse: the gap between two rectangles
saturates at zero the moment they overlap, so a note sitting among several cards ties
with all of them at distance 0 and attaches to none. On the reference flow the blue
note beside the nested `ANY` tied with four cards at 0, 0, 12 and 20. Centres separate
the same case cleanly — 117 against a runner-up at 278 — and pick the card a reader
would.

Settled values, measured over 517 notes with centre distance:

| | |
|---|---|
| median distance to nearest card | 100 |
| 95th percentile | 238 |
| max | 3841 |
| notes within 20px of two cards | 25 (5%) |

- **Threshold 240**, just above the 95th percentile. Beyond it a note is flow-level
  and listed after the tree.
- **Ambiguous when the two nearest cards are within 20px of each other** — 5% of
  notes, genuine ties. Left at flow level rather than guessed at.
- A note renders with its card wherever that card is rendered — including once only,
  where the card appears in a convergent section rendered once.
- **Headings render above their card, inline notes beneath it.** A note at the left
  margin heads a section and reads correctly above it; one out in the flow annotates a
  single card and belongs under it. The original brief said beneath in both cases,
  which reads wrongly for headings.
- With `withCardIds`, each note's own card id is printed so it can be edited.

**Result on live data: 485 of 517 notes attach, 36 stay flow-level.** A heading
sitting equidistant between two sections attaches to the one below it: a left-margin
note heads the section under it, and that placement is common enough that declining to
guess lost real attachments.

**Nothing is placed above `y = 60`.** Homey's canvas controls float over the top of
the flow, so anything up there is hidden at the default scroll position. Flows on this
Homey start at y 0, 20, 40 or 60 and never above it — the sole exception in 101 flows
was a note this app placed at −80, which is what prompted the margin. Relayout
normalises the topmost element to it, and note placement refuses positions above it.

### D. Folders

**`list_folders` is already fixed.** It returned `HTTP 404 for /manager/flow/folder`;
the working endpoint is `/manager/flow/flowfolder`, found while building step 4. It
and the summary's folder-name resolution now share a resolver that probes candidates,
and the summary renders `folder: Upstairs` on-device rather than a uuid. Verified
again before this revision: 17 folders returned. Nothing outstanding.

`folder` is already in `ADVANCED_FLOW_WRITABLE`, so `set_flow_folder(flowId,
folderId)` is a thin wrapper on the step 6 write path. Folder creation and deletion
stay human actions, for the reason flow deletion does.

### E. Rewrite the onboarding doc

Against the finished tool set. It must teach:

- **Read wiring live; never persist a description of it.** A cached description is the
  stale-documentation problem this whole plan exists to escape.
- **Write canvas notes to explain *why*, not *what*.** Short, beside the section they
  explain, never restating wiring the summary already shows. A note that a routine
  rewire would falsify is a bad note.
- **Cross-flow and non-Homey context lives outside this app**, in the user's wiki.
- **Navigate before fetching**: `search_flows`, `get_cross_references` and
  `trace_behaviour` before pulling whole flows.

### Done when

- `trace_behaviour` explains a multi-flow behaviour in a single call. ✅ verified
  offline against live data: tracing the FlowBits flag "Ensuite dark" returns the flow
  that sets it (and what that flow reads to decide) and the flow that checks it (and
  what it goes on to control).
- `add_flow_note` places a note beside a named card with no overlap; the note appears
  in the Homey editor, is captured in the revision stack, and can be reverted.
  **Not yet tested on-device** — needs an install.
- `get_flow_summary` shows notes inline under the correct card across a sample of real
  flows, checked against the editor. ✅ 477 of 517 notes attach; the inline note on the
  reference flow lands on the nested `ANY` it describes.
- `list_folders` works. ✅ already true.

## Follow-ups

Spotted while working; none blocking, all deferred deliberately.

- **`snapshot.apps` is a dead path.** `_appMeta` is never called, and `getApps()` and
  the `/apps` endpoint have always returned `{}` — neither the old `_buildSnapshot`
  nor `_poll` ever populated it. Either wire it up or delete all three. Pre-dates this
  work.
- ~~Step 5 must also cover the xref server on port 8734.~~ **Done** — both servers are
  guarded, with same-origin POSTs permitted on the viewer and no Origin accepted at
  all on MCP.
- **The onboarding doc is rewritten as part of step 7, not before.** It was rewritten
  once for live querying, but its prompt can only teach what exists at the time. Steps
  4 and 6 have since added `get_flow_summary`, `search_flows` and the write tools, and
  step 7 adds the note tools and `trace_behaviour` — so it is rewritten once, at the
  end, against the finished set. See step 7E for what it must teach.
- ~~Confirm whether Better Logic Library is actually installed.~~ **Resolved.** BLL is
  installed and responding; it returned `[]` because it genuinely had no variables.
  The `no usable data` log was a bug: `_toArray` treated an empty collection as a
  failed read, so the 60-second cache could never be cleared and a deleted variable
  was reported indefinitely. Fixed — null now means "could not read", `[]` means
  "no variables".

- **`_overlapCount` over-reports and is only safe as a relative measure.** Card
  heights are estimated from the arguments, so it counts 1714 overlaps across the
  user's own hand-drawn flows, which look fine in the editor. `_layoutCards` only
  ever uses it to compare two arrangements of the *same* flow, where the same
  estimate applies to both. Do not report the number to anyone.
- **Measure layout changes against all 101 flows, not one.** Two changes in this
  round looked like clear wins on the flow being worked on and were losses across
  the estate, and one — putting gates in their own lane — looked like a 40% increase
  in overlapping cards purely because the check measured every card as 400px wide
  when a gate is nearer 120. The numbers that matter: notes attached, notes landing
  on a different card after a relayout, overlapping cards, connector travel, flows
  that move on a second relayout.
- **Long notes are expensive.** A note's height is estimated from its text, and the
  layout holds that much room beside the card it annotates, so three explanatory
  sentences stacked in one column add several hundred pixels and every connector
  into that column has to reach further. The Ensuite humidity rebuild carries four
  notes of 100-120px and comes out at 4772 travel against 1980 with the notes
  stripped. The user's own version of the same flow uses seven notes of the minimum
  80px, spread over two columns, and lands at 3920. Keep notes short, and prefer a
  short note on a sparse column to a long one in the deepest column.
- **A note anchored to a gate can stick out over the next column.** Notes render
  card-width (~400) but sit at their anchor's x, and a gate's lane is only 180-200
  from the next column of cards, so a note on a gate can overlap it. `_overlapCount`
  sees this and the arrangement search avoids it where it can, but nothing places
  the note anywhere else. Showed up as a near-miss on the Ensuite humidity rebuild.
- **The arrangement search is capped at 48.** Thirteen flows drift rather than
  settle and would otherwise burn the whole budget — at 400 the largest flow took
  2.2s, which is too slow for a device-side call. At 48 the slowest is 244ms and
  nothing moves on a second relayout, on any of the 101 flows.

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
