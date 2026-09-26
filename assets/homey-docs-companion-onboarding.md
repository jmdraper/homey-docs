# Homey Docs Companion — Working with Claude

The companion app exposes your Homey Pro to Claude over MCP. Instead of maintaining
a separate folder of documentation that slowly drifts out of date, Claude reads your
live configuration whenever you ask it something.

---

## What you'll be able to do

- Ask what a flow does, in plain English, without opening the flow editor
- Find every flow that touches a given variable, FlowBits event, timer or label
- Trace behaviour that spans several flows at once
- Work out why something fired — or why it didn't
- Audit for broken flows, orphaned variables, and duplicated logic

Nothing is written to disk and nothing drifts: every answer comes from the current
state of your Homey.

---

## Prerequisites

Before pasting the prompt below, confirm:

1. **Homey Docs Companion** is installed and running on your Homey Pro
2. **MCP server** is configured in your AI tool — the viewer's Setup panel walks
   through this
3. You can call `list_flows_metadata` and get back a valid JSON response

---

## Onboarding prompt

Paste everything between the `---` markers into Claude.

---

```
I've connected you to my Homey Pro through the Homey Docs Companion MCP server.
You can read my flows, devices, variables and zones directly. I'd like you to get
oriented before I start asking questions.

## About my setup

My flows, devices and variables are all my own — please don't assume anything about
what they do or how they're named. Read my actual Homey data before drawing any
conclusions, and tell me when you're inferring rather than reading.

## How to explore efficiently

Full Advanced Flow JSON is expensive — every card is a UUID and every connection is
an array of UUIDs. Work from cheap to expensive:

1. `list_flows_metadata` — every flow with name, enabled, broken, card count, folder.
   Start here for the shape of my setup.
2. `list_folders` — folder names, so you can group related behaviour.
3. `get_cross_references` — the index of which flows read, write, or trigger on each
   variable, FlowBits event, label, set, and timer. This is usually the fastest way
   to answer "what touches X?" without reading a single flow.
4. `list_variables`, `list_devices`, `list_zones` — names, types, current values,
   rooms. Needed to make sense of card arguments.
5. Only then pull specific flows: `get_flows_by_ids` for advanced flows (fetch 3–6
   related ones at once), `get_basic_flows_by_ids` for basic flows.

Avoid `get_all_advanced_flows` unless I explicitly ask for a complete audit — it will
consume a very large amount of context.

## Reading flow cards

Card IDs look like `homey:app:com.example:some_card`. Call `get_app_actions` to get
human-readable titles for every installed app's triggers, conditions and actions, and
use it to translate card IDs rather than guessing from the ID string.

Advanced Flow cards carry their connections inline: `outputTrue`, `outputFalse`,
`outputSuccess` and `outputError` each hold the IDs of the cards they lead to. Follow
those to understand execution order — the card list alone is unordered.

## What I'd like from you now

1. Survey my setup and tell me roughly how it's organised — how many flows, how
   they're grouped into folders, which areas of the home they cover.
2. Flag anything that looks like a problem: flows marked broken, flows that are
   disabled but look intentional, variables nothing reads, obvious duplication.
3. Give me a short list of the things you'd want to understand better, so I can tell
   you which matter.

Don't write any documentation files. I'll ask you questions directly from here.
```

---

## After first run

From this point on, just ask. Useful shapes of question:

- *"What turns on the hall lights, and under what conditions?"*
- *"Which flows write to the `HolidayMode` variable?"*
- *"Why might the bedroom heating have come on at 3am?"* — pair this with
  `get_logs` if you have the Simple (Sys) Log app installed
- *"Is anything still referencing the old porch sensor I removed?"*
- *"Show me every flow that runs between midnight and 6am."*

Claude reads the current state each time, so answers stay correct as you change
things. If you've just edited a flow and want to be certain the cached index is
current, ask it to call `refresh_snapshot` first — otherwise the cache is at most
five minutes old.

---

## Where to see the cross-references yourself

The same index Claude uses is browsable at `http://[homey-ip]:8734/`, or via GitHub
Pages if you've set that up. It shows every variable, FlowBits event, label, timer
and flow trigger, with the flows that use each one and what they do with it — reads,
writes, triggers on, fires, checks.

Use the viewer when you want to see the shape of things yourself, and Claude when you
want an explanation.

---

## Tips

- **Be specific about scope.** "Explain my heating" will pull a lot of flows.
  "Explain how the upstairs thermostat decides its setpoint" will pull a few.
- **Name things exactly.** Variable and flow names are matched literally; if you're
  unsure of a name, ask Claude to list the candidates first.
- **Ask for the reasoning.** "Walk me through the card path" gets you the execution
  order, not just a summary.
- **Correct it.** If Claude infers something wrong about your intent, say so — it's
  reading structure, not your reasons for building it that way.
