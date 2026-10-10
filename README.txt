Homey Docs Companion provides two tools for understanding and documenting your Homey setup: a cross-reference viewer, and an MCP server that lets AI assistants read, and optionally edit, your Homey configuration directly.


CROSS-REFERENCE VIEWER

Shows which flows use each variable (Homey or Better Logic Library), FlowBits event, label, timer, and programmatic trigger. Use it to answer questions like "which flows write to this variable?" or "what fires this FlowBits event?" without reading through every flow individually.

Flows link directly to the Homey flow editor. The viewer has a search filter, collapsible entries, and role badges (reads, writes, triggers on, fires, checks, etc.) with tooltip descriptions.


ACCESSING THE CROSS-REFERENCE VIEWER

Option A — Via GitHub Pages (recommended, works in all browsers including Safari)

  https://jmdraper.github.io/homey-docs/cross-refs.html

  Log in with your Athom account when prompted. Your session is remembered so
  subsequent visits load directly without logging in again.

  Requires the companion app to be installed and running on your Homey.

Option B — Local network (advanced users)

  http://[homey-ip]:8734/

  Works in Chrome and Firefox on your local network without any additional setup.
  Safari requires either a reverse proxy providing HTTPS, or a one-time insecure
  content exception in Safari Settings → Websites.

  If you reach the viewer through a reverse proxy or any other domain name, add
  that hostname to the "Additional allowed hosts" app setting. Requests are only
  accepted for IP addresses, localhost and .local names by default, which is what
  prevents a website you visit from reaching Homey through your browser. A proxy
  forwards its own hostname, so without this the viewer returns 403 — which some
  proxies report as a 502.


AI ASSISTANT INTEGRATION (MCP)

An MCP (Model Context Protocol) server runs on Homey and gives AI assistants such as Claude direct access to your flows, devices, variables, and zones. Once connected, you can ask your AI to explain what a flow does, trace behaviour across several flows, or find what still references something you removed. Answers come from your live configuration each time, so there is no separate documentation to keep up to date.

It can also help work out why something happened. Besides the flows themselves, the assistant can read:
- Insights, Homey's own history of device values and Logic variables. A number log comes with a summary of first, last, lowest, highest and average; an on/off log comes as the moments it changed, what changed it, and how long it was on. Nothing in Insights is changed or deleted.
- Homey's notifications, including the one Homey sends when it disables a flow for firing too often, and an estimate of how often each flow fires, worked out from its trigger cards, to show which flows are at risk of that.
- The Simple (Sys) Log app's entries, if it is installed, and which apps are installed and running.


EDITING FLOWS (OPTIONAL)

Editing is off by default, and while it is off the MCP server is read-only. Turn on "Allow AI assistants to edit flows" in the app settings and paste in a Personal Access Token with flow write access (Homey web app → Settings → API Keys); the app's own token can read flows but not change them.

With editing on, the assistant can build and change advanced flows: add, copy, connect and remove cards, change card arguments, rename, enable, disable and move flows between folders, lay out a flow's canvas, and write notes on the canvas explaining why a section is built the way it is. It cannot delete a flow; that stays a manual action in the Homey app, because a re-created flow gets a new id and anything that triggers it would break. Removing a card needs explicit confirmation.

Every edit saves a copy of the flow first, so any change can be undone. Edits made within two minutes of each other share one saved copy, except a relayout, which always gets its own so it can be undone without losing other changes. The most recent 10 copies per flow are kept (up to 50, set in the app settings), plus one a day for 30 days. Adding a note never moves your other cards unless you ask for the flow to be laid out again.


SETUP

Setup takes three steps — all explained in the viewer's Setup panel:
1. Install mcp-remote on your Mac or PC (one-time)
2. Add a short config entry to Claude Desktop
3. Restart Claude Desktop

Reading needs no API tokens or external accounts beyond the AI tool itself. Editing needs the Personal Access Token described above.


REQUIREMENTS

- Homey Pro (local platform)
- Claude Desktop or another MCP-compatible AI tool for the AI integration features
- The cross-reference viewer works without any AI tool


GETTING STARTED

Open http://[homey-ip]:8734/ in a browser on your local network after installing the app. The Setup panel walks through connecting Claude and asking your first questions.
