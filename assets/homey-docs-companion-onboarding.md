# Homey Docs Companion — Working with Claude

The companion app exposes your Homey Pro to Claude over MCP: it can read your live
configuration, follow behaviour across flows, and — once you allow it — edit advanced
flows and write notes onto their canvases.

---

## Where knowledge lives

Three kinds of knowledge, each kept where its source of truth naturally sits.

**Wiring — what is connected to what.** Read live, every time. Never written down.
A description of wiring is out of date the moment anything is rewired, and this app
exists so that nothing has to be kept in step by hand.

**Why a section of a flow is built the way it is.** A note card on that flow's canvas,
beside the section it explains. Notes are part of the flow, so they are visible in the
Homey app, editable by hand, and included in flow backups.

**Everything else** — cross-flow design, decisions and the reasoning behind them,
approaches you tried and abandoned, notes about the house and its devices, conventions,
the backlog — lives outside Homey, wherever you keep your own notes. This app neither
stores it nor knows about it.

---

## Prerequisites

1. **Homey Docs Companion** installed and running on your Homey Pro
2. **MCP server** configured in your AI tool — the viewer's Setup panel walks through it
3. You can call `list_flows_metadata` and get valid JSON back

For editing, two further deliberate steps, both in the app's settings:

4. **Allow AI assistants to edit flows** turned on
5. A **Personal Access Token** with Flows access pasted in — the app's own token can
   read flows but not change them

Leave either unset and everything stays read-only.

---

## Onboarding prompt

Paste everything between the `---` markers into Claude.

---

```
I've connected you to my Homey Pro through the Homey Docs Companion MCP server.
Before I start asking questions, get oriented — and read these working rules first,
because they matter more than the tool list.

## Working rules

**Read wiring live. Never write it down.** If you want to know what a flow does, call
get_flow_summary. Do not record what it does in a note, a file, or anywhere else. A
saved description goes stale silently, and a stale description is worse than none.

**Notes explain why, not what.** When you write a note onto a flow, it should say
something the wiring cannot: why this test is here, what breaks without it, which
other flow it must not fight with, why the obvious simpler version does not work.
Never restate the wiring — the summary already shows it. A useful test: if a routine
rewire would make the note false, it is a bad note. Keep them to one short sentence —
the layout holds space beside a card for the note on it, so a long note pushes that
whole column apart and every connector into it has further to travel.

**Anything not about one specific flow goes in my own notes, not Homey.** Design that
spans flows, decisions and their reasoning, dead ends, device quirks, the backlog —
tell me and I will file it. Do not invent a place to keep it.

**Say when you are inferring.** My flows are my own; do not assume what they do from
their names.

## Explore from cheap to expensive

1. `list_flows_metadata` — every flow with name, folder, enabled, broken, card count.
2. `list_folders` — I group flows by area, so the folder is a strong hint.
3. `get_cross_references` — the index of which flows read, write or trigger on each
   device, variable, FlowBits event, mode, flag, timer and signal. Usually the fastest
   way to answer "what touches X?" without reading a flow at all.
4. `search_flows` — find flows by what they contain, rather than guessing names.
5. `trace_behaviour` — when something spans flows, this follows it. Give it any name —
   a device, variable, flow, or FlowBits entity — and it returns what affects it and
   what it affects. Start at depth 3 and raise it only if the answer looks cut off.
6. `get_flow_summary` — one flow, resolved and readable, with the author's notes in
   place. Prefer it to get_advanced_flow, which is raw ids and costs far more to read.

Avoid `get_all_advanced_flows` unless I ask for a full audit; it is very large.

## Reading a flow

Card ids look like `homey:app:com.example:some_card`. `get_app_actions` gives readable
titles for every installed app's cards.

Advanced flow cards carry their connections inline — `outputTrue`, `outputFalse`,
`outputSuccess`, `outputError` each hold the ids of the cards they lead to. Follow
those for execution order; the card list alone is unordered.

Notes already on the canvas are the author's own explanation. Read them before
inferring intent, and treat a red note as something I mean to change soon.

## Editing, if it is turned on

Every edit saves a revision first, so anything can be undone with revert_flow. Even so:

- Tell me what you intend to change and why, and wait, unless I have already said go.
- `set_flow_enabled(false)` is the reversible way to stop a flow. There is no delete
  tool, by design — recreating a flow gives it a new id and breaks everything that
  triggers it.
- Get card ids from `get_flow_summary` with `withCardIds: true`.
- After building or restructuring a flow, call `relayout_flow` — then add notes. A
  note records only its position, so one added before the cards are placed can end up
  labelling the wrong section.
- `remove_card` needs `confirm: true`. Ask me first.

## What I'd like from you now

1. Survey my setup: roughly how many flows, how they are grouped, which areas of the
   house they cover.
2. Flag anything that looks wrong: broken flows, flows disabled that look like they
   should not be, variables nothing reads, obvious duplication between flows.
3. Tell me which parts you would want to understand better, and I will point you at
   the ones that matter.

Don't write any documentation files, and don't write notes onto flows yet.
```

---

## After first run

Ask directly. Useful shapes of question:

- *"What turns on the hall lights, and under what conditions?"*
- *"What would break if I deleted this variable?"* — `trace_behaviour` answers this
- *"Why might the bedroom heating have come on at 3am?"* — pair with `get_logs` if the
  Simple (Sys) Log app is installed
- *"Is anything still referencing the porch sensor I removed?"*
- *"Add a note to this flow explaining why the delay is there."*

Claude reads the current state each time, so answers stay correct as you change things.
If you have just edited a flow and want certainty the cached index is current, ask it
to call `refresh_snapshot` — otherwise the cache is at most five minutes old.

---

## Seeing the same picture yourself

The cross-reference index Claude uses is browsable at `http://[homey-ip]:8734/`. It
lists every device, variable, FlowBits entity, timer and flow trigger, with the flows
that use each one and what they do with it.

Use the viewer to see the shape of things yourself, and Claude when you want an
explanation or a change.

---

## Tips

- **Be specific about scope.** "Explain my heating" pulls a lot of flows. "Explain how
  the upstairs thermostat decides its setpoint" pulls a few.
- **Ask for the reasoning**, not just the summary — "walk me through the card path".
- **Correct it.** If it infers something wrong about your intent, say so. It reads
  structure; it cannot read why you built things that way — which is exactly what the
  notes on the canvas are for.
- **Ask it to write a note** when it works something out that you would otherwise have
  to rediscover. That is the one thing worth persisting, and it belongs on the flow.
