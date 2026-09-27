# Addendum: what the write-path work actually changed

A companion to `SKILLS-BRIEF.md`. That brief described the move from documentation
sync to live querying. This one covers the round of work that followed, on
**27 Sep 2026**, and exists because several things the work was commissioned to fix
turned out not to be the problem — so a skill revised against the original brief's
assumptions would teach the wrong lessons.

Read this before revising `homey-diagnostics`. The `homey-diagnostics` skill has
**already had a first pass** against these changes (see "What was already changed in
the skill" at the end); this document is the ground truth to check that pass against
and to extend.

---

## 1. The premise that was wrong

The work began from a session in which Claude tried to rebuild a ~70-card flow section
through the MCP, made about 60 sequential `add_card` / `connect_cards` calls, hit its
per-turn tool-call limit, and then had two calls hang for four minutes each. The
app looked as though it had stalled. The diagnosis was abandoned and the split was
done by hand in the Homey editor in minutes.

The natural conclusion — **that the app gets slow as a flow grows, and that a big
build overloads it** — is false. Measured against the live Homey:

| Claim | Measurement |
|---|---|
| Per-call cost grows with flow size | 70 `add_card` calls growing a flow from 0 to 70 cards: 72.5s total, mean 1.04s. First ten averaged 1054ms, last ten 1073ms. **No growth.** |
| Big flows are expensive to write | A no-op write on the largest flow on this Homey (213 cards) costs the same ~0.6s as one on a 12-card flow. The biggest flow is 62KB. |
| Homey rate-limits the advanced-flow PUT | 25 back-to-back PUTs: 378–1583ms, no 429, no degradation. |
| The app leaks memory under write load | 125MB RSS / 75MB PSS, in line with every other app installed (Flow Checker 119MB, Button+ 117MB). |

**What the hang was not:** the app working. Nothing server-side takes longer than about
a second under that workload.

**A correction, made after a first pass got this wrong.** The first diagnosis blamed the
MCP server's SSE stream, which had no keepalive: an idle connection dies silently at a
router, and the server then writes its answer into a dead socket with neither end timing
out. That is a real defect and it has been fixed — but **it is not the path Claude
Desktop uses.** `mcp-remote`, given the configured URL `http://<homey>:8735/mcp`,
reports `transport strategy: http-first` and connects with
`StreamableHTTPClientTransport`; running it and watching the counters confirms it
(`streamableSessions` increments, `sseSessions` does not). The SSE endpoint is served
for compatibility and is not in use here.

**So the precise mechanism of the four-minute hangs is not established**, and cannot now
be, because nothing recorded a tool call at the time. What is known: on the streamable
transport the answer travels back on the request's own socket, so a hang means either
the server never finished the call or the answer never got back over a connection that
had gone bad. Both are now instrumented — every call is logged with its duration, every
undeliverable response is recorded with the tool and session, and each session's idle
time is reported — so a recurrence will say which.

**What makes the symptom impossible regardless of the cause** is the bounded write: a
write now answers within 30 seconds saying whether Homey was told, so an indefinite wait
becomes an explicit error. That is the part a skill should rely on.

**Implication for the skill:** do not teach "avoid large builds because the app can't
cope". The correct lessons are *use the batch tools because round trips are the
expensive part*, and *a call that does not come back is a transport or client problem,
not an overloaded Homey* — with the corollary that a write which genuinely fails now
says so within 30 seconds, so a silent wait is never the app thinking.

Two further defects were found by reading the code, both now fixed: writes to one flow
were not serialised (two overlapping calls each read the same state and PUT it, and the
second silently discarded the first), and the revision cap discarded exactly the history
a long build needs — the 70-card rebuild produced 70 revisions and the cap of 20 left
the oldest holding the flow at 51 cards.

---

## 2. Facts about Homey worth carrying into any skill

- **Homey exposes no flow version history through the API.** The Homey app shows one;
  there is no endpoint. A flow's earlier state is unrecoverable except from the
  companion app's own revision store.
- **An advanced flow carries no change signal.** Its fields are
  `id, name, folder, triggerable, enabled, broken, cards` — no `updatedAt`, no revision
  counter, no hash. Any freshness check has to hash the payload.
- **A card id appears in four places, not one:** the output arrays, an ALL gate's
  `input` list, a card's `droptoken`, and `[[trigger::<id>::…]]` tokens embedded in
  argument text. 476 cards on this Homey carry the last kind. This matters whenever
  cards are copied or ids are reasoned about.
- **Only trigger, condition and action cards have an `id`.** `delay`, `all`, `any`,
  `start` and `note` are structural and have none.
- **Valid outputs per card type**, from all 5,003 cards on this Homey: trigger, delay,
  all, any, start — `outputSuccess` only; condition — `outputTrue`, `outputFalse`,
  `outputError` (16 cards really do use the error branch); action — `outputSuccess`,
  `outputError`.
- **Homey refuses to create a flow with no cards** ("Advanced Flow is empty, add at
  least one Flow card"). That is why `create_advanced_flow` seeds a placeholder start
  card, and why it cannot be declined on its own.
- **Reading Homey's notifications needs `homey.notifications.readonly`.** Neither the
  app's own token nor a flow-scoped Personal Access Token carries it.
- **The `homey` CLI is rate-limited by Athom's cloud API**, which blocks
  `homey app install` for roughly 30 minutes once tripped. Polling to check keeps it
  alive. The app's own MCP server on the LAN is unaffected.

---

## 3. New tools

### `apply_cards(flowId, cards[], connections[], relayout?, requestId?)`
Adds any number of cards and the connections between them in **one read-modify-write,
one revision, all or nothing**. Cards carry a local `ref` (`"$trigger"`) that
connections use; a `from`/`to` that is not a ref is read as an existing card id or
prefix, so a batch can hang off what is already there. Every connection must name its
`output` explicitly. A batch with any fault writes nothing and returns **every** problem
found, not the first.

### `copy_cards(fromFlowId, toFlowId, cardIds? | sectionNoteId?, …)`
Copies a group of cards between flows, keeping arguments, `ownerUri`, relative
positions, droptokens and the wiring between them, under fresh ids. Options:
`includeNotes` (default true), `removeFromSource` (makes it a move; the copy is written
first, so a failure leaves the source intact), `dryRun`, `requestId`.

**`sectionNoteId` semantics matter and are easy to get wrong.** Section heading notes
sit at the left margin — the same test `get_flow_summary` uses to tell a heading from a
label — and consecutive headings divide the canvas into bands. A section is the cards in
its band, plus whatever they go on to drive, never crossing into another band. So **the
topmost heading often names the flow rather than the whole of it**: on *Scullery Button+
controller*, the "Button+ controller" note selects 47 of 73 cards because four more
headings sit below it. The result lists `otherSectionsInSource` for exactly this reason.
Always `dryRun` a section selection first and read the count.

Both tools remove the placeholder start card when the batch brings in real triggers, and
say so in the result.

**Scale, measured:** the 73-card *Scullery Button+ controller* is reproduced by a single
`copy_cards` call in 1.4s as one revision, and `get_flow_summary` of the copy is
identical to the source line for line. The same build through `add_card` is 70 calls and
72 seconds.

### `get_trigger_load(flowId?, limit?)`
Estimates how often each flow fires, from the trigger cards alone — no execution history.
Ranked on `certainPerHour` (the triggers that state their own rate), **not** on the upper
bound, because ranking on the bound ranks on guesses about how chatty a device is.
`estimatedPerHour` is a min/max range, wide wherever a trigger's rate belongs to a device.

`flagged` is the actionable part. Two checks:
- **More than one interval trigger at a minute or finer on one canvas** — the shape that
  gets a flow disabled. (Six of them on *Dehumidifier drying* is what started all this.)
- **Feedback loops**, defined narrowly. This needed two attempts and the reasoning is
  worth preserving: flagging any flow that triggers on something it also writes flagged
  **fifty** flows, because that is the ordinary shape of every lights flow — trigger on
  the light turning on, then set its dim level. What matters is whether writing the thing
  would set the trigger off *again*. "When the light turns on" is an edge, and writing
  `on` to an already-on light fires nothing. `X changed`, a variable, and a FlowBits
  flag or signal all fire on any new value. Restricted to those, it flags sixteen, all
  genuine.

### `get_notifications(since?, until?, search?, limit?)`
Homey's own notifications, where `"<flow> has been disabled, because the Flow executed
too many times"` appears — **naming the trigger card responsible**. Nothing else records
that event. It needs `homey.notifications.readonly`; without it the tool returns an
error saying precisely which scope to add and where, and still returns
`flowStateChanges`: flow enable/disable transitions the app records for itself, which
need no extra permission. Those carry the time the change was *noticed*, not when it
happened, and a flow disabled and re-enabled between two reads leaves no trace.

---

## 4. Changed behaviour in existing tools

- **`get_logs`** takes `until`. It also reports `truncated` when the limit cut the window
  short and `beforeRetention` when the window starts before the oldest entry Simple Log
  still holds — so an empty answer can be told from a discarded one. An unparseable date
  is now an error rather than a silently empty result.
- **`add_card`** takes `output` (which output of `after` to connect from) and
  `requestId`. It still defaults to `outputTrue` for a condition and `outputSuccess`
  otherwise, but now says which it used, and refuses an output the source card cannot
  have.
- **`connect_cards`** returns `alreadyConnected` / `alreadyDisconnected` and writes
  nothing in either case, so it is safe to repeat and a no-op no longer costs a
  revision.
- **`create_advanced_flow`** documents its placeholder and takes `withStartCard`, which
  is refused on its own with an explanation, since Homey will not hold an empty flow.
- **`relayout_flow`** returns `misplacedNotes` when `notesMisplaced > 0`: each note's id,
  text, colour, the card it was beside, and what it now reads as labelling.
- **`get_diagnostics`** reports `appVersion`, `buildId` (a digest of the app's source —
  development installs go on repeatedly at the same version, so the version alone cannot
  identify a build), `startedAt`, the `tools` list this build serves, recent MCP calls
  with durations, in-flight calls, and open session counts.
- **`list_flow_revisions`** reports `writes` per revision and marks daily archives.
- **`search_flows`, `trace_behaviour`, `get_cross_references`** check whether Homey has
  moved before answering, re-read what changed, and report `snapshotAge` in seconds plus
  `changedFlows` / `newFlows` / `deletedFlows`. `refresh_snapshot` is therefore no longer
  a required ritual.

### Write safety, which changes how a skill should handle failure
- Writes to one flow **queue**, so overlapping calls no longer race.
- Every write **answers within 30 seconds**, reporting `phase` and `putSent`. Where the
  timeout lands before the PUT the call is genuinely abandoned, so `putSent: false` means
  nothing was written and a retry is safe. `putSent: true` means Homey may have applied
  it — re-read rather than retrying.
- **`requestId`** on `add_card`, `apply_cards` and `copy_cards` makes a retry safe:
  repeating the same id within ten minutes returns the first call's result instead of
  writing again. A failure that demonstrably wrote nothing is not remembered, so a real
  retry still retries.
- **Revisions merge:** writes less than two minutes apart share one, holding the state
  from before the first of them. One-per-day archives are kept beyond the cap.

---

## 5. Still not possible

- **No flow deletion through the MCP**, deliberately. Use `set_flow_enabled(false)`.
- **No device action history.** The per-device timeline in the Homey app ("Turned on by
  flow X at 03:41") is not in the local API.
- **No manual edit history.** Edits made in the Homey editor are not in
  `list_flow_revisions`, and Homey exposes no version history endpoint.
- **Capability-change rates are a guess.** `get_trigger_load` gives a `measure_*_changed`
  trigger 1–360/h and marks it unknown. Homey Insights holds the real per-device report
  rate and would turn this into a measurement; not done.

---

## 6. Needs Jon, not a skill change

The Personal Access Token in the app's settings carries only `homey.flow`. Adding
**Notifications read access** (Homey web app → Settings → API Keys) would make
`get_notifications` return Homey's own flow-disable events, which name the offending
trigger card. Ten such events from 26 Sep 2026 are still on the Homey. Until then, the
tool returns the locally-observed transitions and an error explaining the gap.

---

## 7. What was already changed in the skill

`homey-diagnostics` has had a first pass. Check and extend rather than redo:

- **Phase 7a** rewritten around `copy_cards` / `apply_cards`, with the `dryRun`-first
  advice and the "topmost heading names the flow" trap. Manual copy/paste in the Homey
  editor is now the fallback, not the plan.
- **Phase 7c** rewritten for `output` on `add_card`, the 30-second bounded write and how
  to read `putSent`, `requestId`, and the placeholder start card.
- **Phase 7d** updated for `misplacedNotes`.
- **New Phase 4e** on `get_trigger_load` for "why did Homey disable this"; the old 4e
  (recent changes) became 4f and mentions revision merging.
- **Tools section** gained `get_trigger_load` and `get_notifications`, and the
  `get_diagnostics` entry now mentions version, build and tool list.
- **"Snapshot freshness"** rewritten: reads check for themselves, `refresh_snapshot` is
  no longer a ritual.
- **"`get_logs` returns the newest entries only"** replaced with guidance to bound the
  window at both ends.
- **"Homey's own flow-disable events"** moved out of "not available" into
  `get_notifications`, with the scope caveat.
- **"Check you have the right tool set"** now points at `get_diagnostics`.

Areas *not* revisited, which may deserve attention: Phases 1–3 (timezone handling, log
searching), Phase 8 (canvas notes), and the `homey-documentation` skill, which was not
touched by this work.
