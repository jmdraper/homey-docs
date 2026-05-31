Homey Docs Companion tracks changes to your flows, devices, variables, and zones, and provides two tools for understanding and documenting your Homey setup.


CROSS-REFERENCE VIEWER

A local web page (accessible at http://[homey-ip]:8734/) showing which flows use each variable, FlowBits event, label, timer, and programmatic trigger. Use it to answer questions like "which flows write to this variable?" or "what fires this FlowBits event?" without reading through every flow individually.

Flows link directly to the Homey flow editor. The viewer has a search filter, collapsible entries, and role badges (reads, writes, triggers on, fires, checks, etc.) with tooltip descriptions.


AI ASSISTANT INTEGRATION (MCP)

An MCP (Model Context Protocol) server runs on Homey and gives AI assistants such as Claude direct read access to your flows, devices, variables, zones, and change history. Once connected, you can ask your AI to explain what a flow does, find dependencies, or build and maintain a living documentation system that updates automatically when your flows change.

Setup takes three steps — all explained in the viewer's Setup panel:
1. Install mcp-remote on your Mac or PC (one-time)
2. Add a short config entry to Claude Desktop
3. Restart Claude Desktop

No API tokens or external accounts are required beyond the AI tool itself.


CHANGE TRACKING

The app polls Homey every five minutes and records when flows are created, modified, renamed, deleted, enabled, or disabled, along with changes to devices and variables. The changelog is available to AI assistants via the MCP server, so syncing documentation only requires fetching what actually changed rather than re-reading everything.


REQUIREMENTS

- Homey Pro (local platform)
- Claude Desktop or another MCP-compatible AI tool for the AI integration features
- The cross-reference viewer and change tracking work without any AI tool


GETTING STARTED

Open http://[homey-ip]:8734/ in a browser on your local network after installing the app. The Setup panel walks through connecting Claude and building your first documentation.
