'use strict';

const http = require('http');
const { randomUUID } = require('crypto');

function vals(data) {
  if (!data) return [];
  return Array.isArray(data) ? data : Object.values(data);
}

const PLAUSIBLE_ADDRESS_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/;
const ADDRESS_KEYS = ['address', 'ip', 'ipAddress', 'host', 'hostname'];

function findAddress(...sources) {
  for (const source of sources) {
    if (!source || typeof source !== 'object') continue;
    for (const key of ADDRESS_KEYS) {
      const value = source[key];
      if (typeof value === 'string' && PLAUSIBLE_ADDRESS_RE.test(value.trim())) {
        return value.trim();
      }
    }
  }
  return null;
}

function appIdFromDriverUri(driverUri) {
  if (typeof driverUri !== 'string') return null;
  const match = driverUri.match(/^homey:app:(.+)$/);
  return match ? match[1] : null;
}

const TOOLS = [
  {
    name: 'list_advanced_flows',
    description: 'List all Advanced Flows from Homey, including their names and IDs',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_advanced_flow',
    description: 'Get the full detail of a specific Advanced Flow by ID, including all cards and connections',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'The flow ID' } },
      required: ['id'],
    },
  },
  {
    name: 'get_flows_by_ids',
    description: 'Get the full detail of multiple Advanced Flows by their IDs in a single call. More efficient than calling get_advanced_flow repeatedly. Ideal for fetching 3–6 related flows at once.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Array of flow IDs to fetch' },
      },
      required: ['ids'],
    },
  },
  {
    name: 'get_all_advanced_flows',
    description: 'Get the full detail of ALL Advanced Flows — use this when you need a complete picture',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_flows',
    description: 'List all standard (basic) Flows from Homey. To get full card detail for any flow returned here, call get_basic_flows_by_ids.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_basic_flows_by_ids',
    description: 'Get full detail of one or more basic (simple If/Then/Else) flows by ID — trigger, conditions, and actions including all args. Note: basic flows use a flat structure, not a card graph like advanced flows.',
    inputSchema: {
      type: 'object',
      properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Array of basic flow IDs to fetch' },
      },
      required: ['ids'],
    },
  },
  {
    name: 'get_flow_summary',
    description: 'Get a readable summary of one flow: card ids resolved to their human titles, device/variable/zone ids resolved to names, tokens rendered inline, any notes the author wrote on the canvas, and the card graph as an indented tree showing execution order. Far cheaper to read than get_advanced_flow and much less error-prone — prefer it whenever you want to understand what a flow does, and fall back to get_advanced_flow only when you need raw ids or card coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The flow ID (basic or advanced)' },
        withCardIds: {
          type: 'boolean',
          description: 'Prefix each line with that card\'s id. Needed before editing, since the editing tools address cards by id; leave it off when only reading.',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'search_flows',
    description: 'Search every flow for a phrase, matching against flow names, canvas notes, resolved card titles, device and variable names, and card arguments. Returns matching flows with the specific lines that matched. Use this to locate flows by what they do rather than guessing ids, before pulling detail with get_flow_summary.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for, case-insensitive substring match.' },
        limit: { type: 'integer', description: 'Maximum flows to return. Default 20, max 100.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_devices',
    description: 'List all devices connected to Homey, with their names, zone (zoneId + resolved zoneName), capabilities, network address (when locally known), and owning app ID',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_zones',
    description: 'List all zones (rooms/areas) configured in Homey',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_folders',
    description: 'List all Advanced Flow folders from Homey, with their names and IDs. Flows include a folder ID — use this to map folder IDs to names.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_variables',
    description: 'List all logic variables with their names, types, and current values — includes native Homey variables (source: homey) and Better Logic Library variables (source: bll) if BLL is installed.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_flows_metadata',
    description: 'List all flows (basic and advanced) with lightweight metadata — name, enabled, broken, card count, folder. Faster than get_all_advanced_flows when you only need an overview.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_logs',
    description: 'Fetch log entries from the Simple (Sys) Log app. Returns entries newest-first. Each entry has: id, timestamp (ISO 8601), severity, app, message. To read a window that has since scrolled past, give both since and until — with only since, the newest `limit` entries come back, which for a window hours ago is everything except the window.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Case-insensitive substring filter applied to the message field.' },
        since: { type: 'string', description: 'ISO 8601 datetime — only return entries at or after this timestamp.' },
        until: { type: 'string', description: 'ISO 8601 datetime — only return entries at or before this timestamp. Pair it with since to bound a window; the limit then applies inside the window rather than to the whole log.' },
        limit: { type: 'integer', description: 'Maximum number of entries to return. Default 100, max 1000.' },
      },
    },
  },
  {
    name: 'list_apps',
    description: 'The apps installed on Homey, read live — id, name, version and whether each one is running. Worth checking when a flow looks correct but does not fire: a crashed or disabled app breaks every flow that uses its cards, and nothing in the flow itself shows that.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_app_actions',
    description: 'Returns human-readable titles for all triggers, conditions, and actions exposed by each installed Homey app, keyed by their full card ID strings. Use this to translate opaque app card IDs into readable labels.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'trace_behaviour',
    description: 'Follow a behaviour across flows. Give the name of anything — a device, variable, flow, or FlowBits event, mode, flag, timer or signal — and it returns what affects it (upstream) and what it affects (downstream), walking flow to flow through the things they share. Use it when a behaviour spans several flows and the cross-reference index only shows one hop.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Name of a device, variable, flow, or FlowBits entity' },
        depth: { type: 'integer', description: 'How many hops to follow. Default 3, max 6. Raise it only if the answer looks cut off — a busy variable reaches much of the estate.' },
        direction: { type: 'string', enum: ['both', 'upstream', 'downstream'], description: 'Default both.' },
      },
      required: ['target'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'add_flow_note',
    description: 'Write a note onto a flow\'s canvas. Notes are where an explanation belongs: say WHY a section is built as it is, not what it does — the summary already shows the wiring, and a note restating it goes stale the moment anything is rewired. Keep it short. Pass nearCardId to place it beside a particular card; add notes after relayout_flow, not before.',
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string' },
        text: { type: 'string', description: 'The note text. Short, and about intent rather than mechanism.' },
        nearCardId: { type: 'string', description: 'Card to place the note beside. Omit for a flow-level note.' },
        color: { type: 'string', enum: ['yellow', 'blue', 'green', 'red'], description: 'Default yellow. Red conventionally means "change this soon".' },
      },
      required: ['flowId', 'text'],
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'update_flow_note',
    description: 'Rewrite the text of an existing note card. Note text is not a card argument, so update_card_args cannot change it. Get note ids from get_flow_summary with withCardIds.',
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string' },
        noteCardId: { type: 'string' },
        text: { type: 'string' },
      },
      required: ['flowId', 'noteCardId', 'text'],
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: 'set_flow_folder',
    description: 'Move a flow into a folder, or pass no folderId to take it out of one. Folder ids come from list_folders. Creating and deleting folders stays a manual action.',
    inputSchema: {
      type: 'object',
      properties: { flowId: { type: 'string' }, folderId: { type: 'string' } },
      required: ['flowId'],
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: 'list_flow_revisions',
    description: 'List the saved pre-edit copies of a flow, newest first. Every edit saves one automatically. Use the revision number with revert_flow — but call this again first if anything has been written since, because revision 1 is always the most recent save and the numbers shift down as new ones are added.',
    inputSchema: {
      type: 'object',
      properties: { flowId: { type: 'string', description: 'The advanced flow ID' } },
      required: ['flowId'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'revert_flow',
    description: 'Restore a flow to a previously saved revision, numbered as list_flow_revisions reports them at the time of the call. The current state is saved first, so a revert can itself be reverted — which also means every revert shifts the existing numbers down by one, so list the revisions again rather than reusing numbers from before a write.',
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string', description: 'The advanced flow ID' },
        revision: { type: 'integer', description: 'Revision number from list_flow_revisions. Defaults to 1, the most recent.' },
      },
      required: ['flowId'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'set_flow_enabled',
    description: 'Enable or disable an advanced flow. This is the reversible way to stop a flow running — prefer it to deleting, which this server cannot do.',
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string' },
        enabled: { type: 'boolean' },
      },
      required: ['flowId', 'enabled'],
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: 'rename_flow',
    description: 'Rename an advanced flow.',
    inputSchema: {
      type: 'object',
      properties: { flowId: { type: 'string' }, name: { type: 'string' } },
      required: ['flowId', 'name'],
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: 'update_card_args',
    description: 'Change the arguments of one card. Arguments are merged into the existing ones unless replace is true. Get card ids from get_flow_summary with withCardIds: true.',
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string' },
        cardId: { type: 'string', description: 'Card id, or any unambiguous prefix of one' },
        args: { type: 'object', description: 'Argument names and values to set' },
        replace: { type: 'boolean', description: 'Replace all arguments instead of merging. Default false.' },
      },
      required: ['flowId', 'cardId', 'args'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'add_card',
    description: 'Add ONE card to an advanced flow. Pass `after` to place and connect it '
      + 'downstream of an existing card; otherwise it is placed below the flow, unconnected. '
      + 'Coordinates are chosen automatically so cards do not overlap. For more than two or '
      + 'three cards use apply_cards instead, which does the whole batch in one write and one '
      + 'revision — a flow built a card at a time costs a round trip each and a revision each.',
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string' },
        card: {
          type: 'object',
          description: 'The card: type (trigger/condition/action/all/any/delay/note), id (the full card id such as homey:device:<uuid>:on), ownerUri, and args. For a note, pass type \'note\' with a value (the text) and optionally a color — yellow, blue, green or red; notes are never connected, and `after` places one above the card it labels. Add notes LAST, after relayout_flow: a note records only its position, so one attached before the cards are laid out is filed against a position that then moves, and can end up labelling the wrong part of the flow.',
        },
        after: { type: 'string', description: 'Card id to place this one after and connect from' },
        output: {
          type: 'string',
          enum: ['outputTrue', 'outputFalse', 'outputSuccess', 'outputError'],
          description: 'Which output of `after` to connect from. Defaults to outputTrue for a '
            + 'condition and outputSuccess for everything else, which is why a card added after '
            + 'a condition used to be unreachable on the false branch. Valid outputs by card '
            + 'type: trigger, delay, all, any, start — outputSuccess only; condition — '
            + 'outputTrue, outputFalse, outputError; action — outputSuccess, outputError. '
            + 'Notes have none and are never connected.',
        },
        requestId: {
          type: 'string',
          description: 'An idempotency key of your choosing. Repeating a call with the same '
            + 'requestId within ten minutes returns the first call\'s result instead of adding '
            + 'a second card — so a retry after a timeout or a dropped connection is safe. Use '
            + 'a fresh id for every card you actually mean to add.',
        },
      },
      required: ['flowId', 'card'],
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'apply_cards',
    description: 'Add several cards and the connections between them to an advanced flow in one '
      + 'call — one read of the flow, one write, one revision, and either all of it applies or '
      + 'none of it does. Use this instead of a run of add_card / connect_cards calls: building '
      + 'a 70-card flow one card at a time takes about 80 round trips and is what exhausts a '
      + 'turn. Cards name each other with local refs such as "$fastLed"; a from/to that is not '
      + 'one of those refs is read as an existing card id or prefix in the flow, so a batch can '
      + 'hang off what is already there. Every connection names its output explicitly.',
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string' },
        cards: {
          type: 'array',
          description: 'The cards to add. Each needs a `ref` (any string, conventionally "$name") '
            + 'and a `type`. A trigger, condition or action also needs `id` (the full card id) '
            + 'and usually `ownerUri` and `args`; delay, all, any and start are structural and '
            + 'have no id. A note takes `value` and optionally `color`. Give `x` and '
            + '`y` to place a card exactly; leave them out and the batch is laid out in columns '
            + 'below the existing flow, following the connections.',
          items: { type: 'object' },
        },
        connections: {
          type: 'array',
          description: 'Connections to make, as { from, output, to }. `from` and `to` are refs '
            + 'from this batch or existing card ids. `output` is required and must be one the '
            + 'source card actually has: trigger, delay, all, any, start — outputSuccess; '
            + 'condition — outputTrue, outputFalse, outputError; action — outputSuccess, '
            + 'outputError.',
          items: { type: 'object' },
        },
        relayout: {
          type: 'boolean',
          description: 'Lay the whole flow out afterwards, in the same write. Worth it when the '
            + 'batch builds a flow; it moves existing cards too, so leave it off when adding to '
            + 'a flow someone has arranged by hand.',
        },
        requestId: {
          type: 'string',
          description: 'Idempotency key. Repeating a call with the same requestId within ten '
            + 'minutes returns the first call\'s result rather than adding everything twice.',
        },
      },
      required: ['flowId', 'cards'],
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'copy_cards',
    description: 'Copy a group of cards from one advanced flow to another, keeping their '
      + 'arguments, ownerUri, droptokens, relative positions and the connections between them, '
      + 'with fresh card ids. This is how a section moves between flows in one call rather than '
      + 'in eighty. Say what to copy either with cardIds or, better, with sectionNoteId — the '
      + 'yellow heading note above the section, which selects everything under it using the same '
      + 'attribution get_flow_summary uses to place notes. Connections crossing the edge of the '
      + 'selection are not copied and are listed in the result so you can rewire them, as are '
      + 'any cards left using a token produced by a card that stayed behind.',
    inputSchema: {
      type: 'object',
      properties: {
        fromFlowId: { type: 'string', description: 'The flow to copy from' },
        toFlowId: { type: 'string', description: 'The flow to copy into. It must already exist — '
          + 'create it with create_advanced_flow first.' },
        cardIds: {
          type: 'array', items: { type: 'string' },
          description: 'Card ids, or unambiguous prefixes, from the source flow. Get them from '
            + 'get_flow_summary with withCardIds.',
        },
        sectionNoteId: {
          type: 'string',
          description: 'The id of a yellow section-heading note in the source flow. Everything '
            + 'under that heading, down to the next one, is selected — the cards in its band and '
            + 'whatever they go on to drive.',
        },
        includeNotes: {
          type: 'boolean',
          description: 'Copy the notes attached to the selected cards, and the heading note '
            + 'itself. Default true.',
        },
        removeFromSource: {
          type: 'boolean',
          description: 'Delete the cards from the source flow once the copy has succeeded, '
            + 'turning the copy into a move. The copy is written first, so a failure leaves the '
            + 'source untouched.',
        },
        dryRun: {
          type: 'boolean',
          description: 'Report what would be copied — the cards, the connections that would be '
            + 'dropped, the tokens that would dangle — and write nothing. Worth doing first for '
            + 'a section selection, to check the section is the one you meant.',
        },
        requestId: { type: 'string', description: 'Idempotency key; see apply_cards.' },
      },
      required: ['fromFlowId', 'toFlowId'],
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'remove_card',
    description: 'Remove a card and every connection pointing at it. Requires confirm: true — ask the user before calling.',
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string' },
        cardId: { type: 'string' },
        confirm: { type: 'boolean', description: 'Must be true. Set it only after the user has agreed to the removal.' },
      },
      required: ['flowId', 'cardId', 'confirm'],
    },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'connect_cards',
    description: 'Connect or disconnect two cards. Valid outputs by card type: trigger, delay, '
      + 'all, any, start — outputSuccess only; condition — outputTrue, outputFalse, outputError; '
      + 'action — outputSuccess, outputError. Safe to retry: a connection that already exists '
      + 'comes back as alreadyConnected with wrote: false and nothing written, and disconnecting '
      + 'something already disconnected reports alreadyDisconnected rather than failing.',
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string' },
        fromCardId: { type: 'string' },
        output: { type: 'string', enum: ['outputTrue', 'outputFalse', 'outputSuccess', 'outputError'] },
        toCardId: { type: 'string' },
        connected: { type: 'boolean', description: 'false to disconnect. Default true.' },
      },
      required: ['flowId', 'fromCardId', 'output', 'toCardId'],
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'relayout_flow',
    description: 'Reposition every card in an advanced flow onto a tidy grid, following the spacing the rest of this Homey uses. Cards keep their connections and arguments; only coordinates change. Canvas notes move too, into space held for them beside the card each one annotates — which card that is comes from where the note currently sits, so a note that is already beside the wrong card stays with it. Running this twice changes nothing the second time.',
    inputSchema: {
      type: 'object',
      properties: { flowId: { type: 'string' } },
      required: ['flowId'],
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: 'create_advanced_flow',
    description: 'Create an advanced flow, disabled. Homey rejects a flow with no cards, so by '
      + 'default it is seeded with one start card — harmless, since a start card cannot fire on '
      + 'its own, but it is a real card that stays until removed, and it is why a newly created '
      + 'flow is not empty. Pass withStartCard: false to skip it, in which case add the first '
      + 'card immediately: Homey refuses to hold a flow with no cards at all. Enable it with '
      + 'set_flow_enabled once it is built.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        folder: { type: 'string', description: 'Folder id from list_folders' },
        withStartCard: {
          type: 'boolean',
          description: 'Seed a placeholder start card so the flow is valid on creation. Default '
            + 'true, and false is refused on its own — Homey will not hold a flow with no cards, '
            + 'so the only way to skip the placeholder is to create the flow with its real cards.',
        },
      },
      required: ['name'],
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: 'get_diagnostics',
    description: 'Report the companion app’s own health: API reachability, snapshot counts, which Homey endpoints resolved, and how many flow card titles and folder names were looked up. Use when data looks wrong or incomplete — for example if card titles appear as raw ids.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'refresh_snapshot',
    description: 'Force the companion app to re-read Homey immediately, refreshing its cached flow/device/variable/zone data and rebuilding the cross-reference index, rather than waiting for the next 5-minute refresh. Call this if you suspect the cached data is stale.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_cross_references',
    description: "Get a cross-reference index showing which flows use each device, Better Logic Library variable, Chronograph timer, programmatic flow trigger, and FlowBits entity (events, labels, sets, signals, modes, mode groups, timers, flags, cycles, sliders and no-repeat windows). Use to answer 'which flows use variable X?', 'what fires FlowBits event Y?' or 'what activates mode Z?'.",
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: [
            'devices', 'variables', 'bll_variables', 'timers', 'flow_triggers', 'trigger_tokens',
            'flowbits_events', 'flowbits_labels', 'flowbits_sets', 'flowbits_signals',
            'flowbits_modes', 'flowbits_mode_groups', 'flowbits_timers',
            'flowbits_flags', 'flowbits_cycles', 'flowbits_sliders', 'flowbits_windows',
          ],
          description: 'Filter to a single reference type. Omit to return all types.',
        },
      },
    },
  },
];

// An idle SSE connection dies silently at a router or NAT: the socket is gone,
// but neither end is told, so the server writes a response into nothing and the
// client waits for ever. Nothing in the protocol detects it and nothing here
// timed out. A comment line every 20s keeps the path warm and surfaces the
// failure as a write error on this side, which is what closes the session.
const SSE_KEEPALIVE_MS = 20000;

// Keep the last few calls so get_diagnostics can show what the server was
// doing. There was no record of a tool call at all, which is why the 27 Sep
// stall could only be diagnosed by reproducing it.
const CALL_LOG_LIMIT = 40;

class HomeyMcpServer {
  constructor(app) {
    this._app = app;
    this._server = null;
    this._sessions = new Map();          // SSE transport: sessionId -> { res, keepalive }
    this._streamableSessions = new Set(); // Streamable HTTP transport: active session IDs
    this._startedAt = new Date().toISOString();
    this._calls = [];
    this._callsStarted = 0;
  }

  start(port) {
    return new Promise((resolve, reject) => {
      this._server = http.createServer((req, res) => {
        this._handleHttp(req, res).catch(err => {
          this._app.error('MCP HTTP error:', err.message);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal error');
          }
        });
      });
      this._server.listen(port, '0.0.0.0', () => {
        this._app.log(`MCP server running on port ${port}`);
        resolve();
      });
      this._server.on('error', err => {
        this._app.error('MCP server error:', err.message);
        reject(err);
      });
    });
  }

  stop() {
    for (const session of this._sessions.values()) this._endSse(session);
    this._sessions.clear();
    return new Promise(resolve => {
      if (this._server) this._server.close(resolve);
      else resolve();
    });
  }

  _endSse(session) {
    if (session.keepalive) this._app.homey.clearInterval(session.keepalive);
    session.keepalive = null;
    try { session.res.end(); } catch (e) { /* already gone */ }
  }

  async _handleHttp(req, res) {
    // No CORS headers: this server has no browser client. mcp-remote is a local
    // Node process, which neither sends an Origin nor needs one honoured.
    // Serving Access-Control-Allow-Origin: * here previously let any website the
    // user visited read their entire flow and device inventory.
    const rejection = this._app._checkRequest(req);
    if (rejection) {
      this._app._recordRejection(req, rejection);
      this._app.log('MCP request rejected:', rejection);
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden: ' + rejection);
      return;
    }

    if (req.method === 'OPTIONS') {
      // A preflight can only come from a browser, which is not a client here
      res.writeHead(405, { Allow: 'POST, DELETE' });
      res.end();
      return;
    }

    const url = new URL(req.url, 'http://localhost');

    // ── Streamable HTTP transport (MCP 2025-03-26+) ──────────────────────────

    if (req.method === 'POST' && url.pathname === '/mcp') {
      let body;
      try { body = await this._readBody(req); }
      catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }));
        return;
      }

      const incomingSessionId = req.headers['mcp-session-id'];
      const messages = Array.isArray(body) ? body : [body];
      const isInitialize = messages.some(m => m.method === 'initialize');

      // Reject non-initialize requests with unknown session IDs
      if (!isInitialize && incomingSessionId && !this._streamableSessions.has(incomingSessionId)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this._sessionGone(incomingSessionId)));
        return;
      }

      const responses = [];
      let newSessionId = null;

      for (const msg of messages) {
        const response = await this._handleRpc(msg);
        if (response !== null) {
          responses.push(response);
          // Allocate a session ID when initialize succeeds
          if (msg.method === 'initialize' && response.result) {
            newSessionId = randomUUID();
            this._streamableSessions.add(newSessionId);
          }
        }
      }

      const headers = { 'Content-Type': 'application/json' };
      if (newSessionId) headers['Mcp-Session-Id'] = newSessionId;

      if (responses.length === 0) {
        res.writeHead(202, headers);
        res.end();
      } else {
        res.writeHead(200, headers);
        res.end(JSON.stringify(responses.length === 1 ? responses[0] : responses));
      }
      return;
    }

    // GET /mcp — server-push not needed for our tools; return 405 as spec allows
    if (req.method === 'GET' && url.pathname === '/mcp') {
      res.writeHead(405, { Allow: 'POST, DELETE, OPTIONS' });
      res.end();
      return;
    }

    // DELETE /mcp — client terminates the session
    if (req.method === 'DELETE' && url.pathname === '/mcp') {
      const sid = req.headers['mcp-session-id'];
      if (sid) this._streamableSessions.delete(sid);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }

    // ── SSE transport (MCP 2024-11-05, kept for backward compatibility) ───────

    // SSE endpoint — client establishes a persistent stream here
    if (req.method === 'GET' && url.pathname === '/sse') {
      const sessionId = randomUUID();

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      const session = { res, keepalive: null, openedAt: new Date().toISOString() };
      session.keepalive = this._app.homey.setInterval(() => {
        // A comment line: valid SSE, ignored by every client, and the write
        // fails once the socket is actually dead — which is the only way this
        // side ever finds out.
        try {
          res.write(': keepalive\n\n');
        } catch (e) {
          this._app.log('SSE session', sessionId, 'is dead, closing:', e.message);
          this._endSse(session);
          this._sessions.delete(sessionId);
        }
      }, SSE_KEEPALIVE_MS);

      this._sessions.set(sessionId, session);
      const close = () => {
        if (!this._sessions.has(sessionId)) return;
        this._endSse(session);
        this._sessions.delete(sessionId);
        this._app.log('SSE session closed:', sessionId, '—', this._sessions.size, 'open');
      };
      req.on('close', close);
      res.on('error', err => { this._app.log('SSE write failed:', err.message); close(); });

      this._app.log('SSE session opened:', sessionId, '—', this._sessions.size, 'open');

      // Send absolute URL — the MCP spec requires this, relative paths confuse some clients
      const host = req.headers.host || `localhost:${this._server.address().port}`;
      res.write(`event: endpoint\ndata: http://${host}/message?sessionId=${sessionId}\n\n`);
      return;
    }

    // Message endpoint — client POSTs JSON-RPC requests here
    if (req.method === 'POST' && url.pathname === '/message') {
      const sessionId = url.searchParams.get('sessionId');
      const session = sessionId ? this._sessions.get(sessionId) : null;

      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(this._sessionGone(sessionId)));
        return;
      }
      const sseStream = session.res;

      let body;
      try {
        body = await this._readBody(req);
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      // Acknowledge immediately; responses go via SSE
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end('{}');

      const messages = Array.isArray(body) ? body : [body];
      for (const msg of messages) {
        const response = await this._handleRpc(msg);
        if (response !== null) {
          sseStream.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
        }
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }

  _readBody(req) {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
      req.on('error', reject);
    });
  }

  async _handleRpc(msg) {
    if (!msg || msg.jsonrpc !== '2.0') {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
    }

    // Notifications (no id) require no response
    if (!('id' in msg)) return null;

    const { id, method, params = {} } = msg;

    try {
      switch (method) {
        case 'initialize':
          return {
            jsonrpc: '2.0', id,
            result: {
              protocolVersion: params.protocolVersion || '2024-11-05',
              capabilities: { tools: {} },
              serverInfo: { name: 'homey-mcp', version: this._app.appVersion() }
            }
          };

        case 'tools/list':
          return { jsonrpc: '2.0', id, result: { tools: TOOLS } };

        case 'tools/call':
          return { jsonrpc: '2.0', id, result: await this._callTool(params.name, params.arguments || {}) };

        default:
          return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
      }
    } catch (err) {
      return { jsonrpc: '2.0', id, error: { code: -32000, message: err.message } };
    }
  }

  _text(data) {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }

  // Pre-formatted text — JSON-encoding it would bury the layout in \n escapes
  _raw(text) {
    return { content: [{ type: 'text', text: String(text) }] };
  }

  async _callTool(name, args) {
    const startedMs = Date.now();
    this._callsStarted += 1;
    if (!this._inFlight) this._inFlight = new Set();
    const tag = name + '#' + this._callsStarted;
    this._inFlight.add(tag);
    try {
      const result = await this._runTool(name, args);
      const failed = !!(result && result.isError);
      this._recordCall(name, startedMs, failed ? 'error' : 'ok');
      // Only the slow ones, or the log becomes noise. Nothing here took longer
      // than about a second in testing, so anything at 5s is worth seeing.
      const took = Date.now() - startedMs;
      if (took > 5000) this._app.log('Slow MCP call:', name, took + 'ms');
      return result;
    } catch (err) {
      this._recordCall(name, startedMs, 'threw: ' + err.message);
      this._app.error('MCP call', name, 'threw after', (Date.now() - startedMs) + 'ms:', err.message);
      throw err;
    } finally {
      this._inFlight.delete(tag);
    }
  }

  async _runTool(name, args) {
    const app = this._app;

    try {
      switch (name) {

        case 'list_advanced_flows': {
          const data = await app._fetchAdvancedFlows();
          return this._text(vals(data).map(f => ({
            id: f.id, name: f.name, folder: f.folder ?? null, enabled: f.enabled, broken: f.broken
          })));
        }

        case 'get_advanced_flow': {
          if (!args.id) throw new Error('id is required');
          const data = await app._fetchAdvancedFlows();
          const flow = (data || {})[args.id];
          if (!flow) throw new Error(`Flow ${args.id} not found`);
          return this._text(flow);
        }

        case 'get_flows_by_ids': {
          if (!Array.isArray(args.ids) || args.ids.length === 0) throw new Error('ids must be a non-empty array');
          const data = await app._fetchAdvancedFlows();
          return this._text(args.ids.map(id => (data || {})[id] || { id, error: 'Flow not found' }));
        }

        case 'get_all_advanced_flows':
          return this._text(await app._fetchAdvancedFlows() || {});

        case 'list_flows': {
          const data = await app._apiGet('/manager/flow/flow');
          return this._text(vals(data).map(f => ({
            id: f.id, name: f.name, enabled: f.enabled, broken: f.broken
          })));
        }

        case 'get_basic_flows_by_ids': {
          if (!Array.isArray(args.ids) || args.ids.length === 0) throw new Error('ids must be a non-empty array');
          const data = await app._apiGet('/manager/flow/flow');
          return this._text(args.ids.map(id => (data || {})[id] || { id, error: 'Flow not found' }));
        }

        case 'get_flow_summary': {
          if (!args.id) throw new Error('id is required');
          const summary = await app.getFlowSummary(args.id, { withCardIds: args.withCardIds });
          return typeof summary === 'string' ? this._raw(summary) : this._text(summary);
        }

        case 'search_flows': {
          if (!args.query) throw new Error('query is required');
          return this._text(await app.searchFlows(args.query, args.limit));
        }

        case 'list_devices': {
          const [data, zonesData] = await Promise.all([
            app._apiGet('/manager/devices/device'),
            app._apiGet('/manager/zones/zone').catch(() => ({})),
          ]);
          const zoneNames = {};
          for (const [zoneId, zone] of Object.entries(zonesData || {})) {
            zoneNames[zoneId] = zone.name;
          }
          return this._text(vals(data).map(d => ({
            id: d.id, name: d.name, class: d.class,
            capabilities: d.capabilities, available: d.available,
            zoneId: d.zone || null,
            zoneName: (d.zone && zoneNames[d.zone]) || null,
            address: findAddress(d.settings, d.store),
            appId: appIdFromDriverUri(d.driverUri),
          })));
        }

        case 'list_zones': {
          const data = await app._apiGet('/manager/zones/zone');
          return this._text(vals(data).map(z => ({ id: z.id, name: z.name, parent: z.parent })));
        }

        case 'list_folders': {
          const names = await app._fetchFolderNames();
          return this._text(Object.entries(names).map(([id, name]) => ({ id, name })));
        }

        case 'list_variables': {
          let data;
          try { data = await app._apiGet('/manager/logic/variable'); }
          catch (e) { data = await app._apiGet('/manager/variable/variable'); }
          const native = Object.entries(data || {}).map(([id, v]) => ({
            id, name: v.name, type: v.type, value: v.value, source: 'homey'
          }));
          const { getBllVariables } = require('./bll-client.js');
          const bllVars = await getBllVariables(app);
          const bll = bllVars.map(v => ({ name: v.name, type: v.type, value: v.value, source: 'bll' }));
          return this._text([...native, ...bll]);
        }

        case 'list_flows_metadata':
          return this._text(app.getFlowsMetadata());

        case 'get_logs': {
          // An unparseable date silently matches nothing, which reads as "the
          // log is empty for that window" — say so instead.
          const bound = (name, value) => {
            if (value === undefined || value === null || value === '') return null;
            const at = new Date(value);
            if (Number.isNaN(at.getTime())) {
              throw new Error(`${name} is not a valid ISO 8601 datetime: ${JSON.stringify(value)}`);
            }
            return at;
          };
          const since = bound('since', args.since);
          const until = bound('until', args.until);
          if (since && until && since > until) {
            throw new Error('since is later than until, so the window is empty');
          }

          const data = await app._apiGet('/app/nl.nielsdeklerk.log/');
          let logs = (data && data.logs) || [];
          const held = logs.length;
          const oldestHeld = logs.length ? logs[logs.length - 1].timestamp : null;
          if (since) logs = logs.filter(e => new Date(e.timestamp) >= since);
          if (until) logs = logs.filter(e => new Date(e.timestamp) <= until);
          if (args.search) { const n = args.search.toLowerCase(); logs = logs.filter(e => e.message.toLowerCase().includes(n)); }
          const limit = Math.min(args.limit || 100, 1000);

          const result = { count: logs.length, returned: Math.min(logs.length, limit) };
          // Entries are newest-first, so the limit drops the OLDEST matches.
          // Without saying so, a truncated window reads as a complete one.
          if (logs.length > limit) {
            result.truncated = `${logs.length} entries matched; the newest ${limit} are `
              + 'returned and the older ones dropped. Narrow the window or raise limit.';
          }
          // Simple Log keeps a rolling buffer. A window that starts before the
          // oldest entry it still holds is not empty because nothing happened.
          if (since && oldestHeld && new Date(oldestHeld) > since) {
            result.beforeRetention = `Simple Log holds ${held} entries going back only to `
              + `${oldestHeld}, which is after the requested since. Anything earlier has `
              + 'already been discarded.';
          }
          result.logs = logs.slice(0, limit);
          return this._text(result);
        }

        case 'list_apps':
          return this._text(await app.listApps());

        case 'get_app_actions':
          return this._text(await app.getAppActions());

        case 'trace_behaviour': {
          if (!args.target) throw new Error('target is required');
          const trace = await app.traceBehaviour(args.target, args.depth, args.direction);
          return typeof trace === 'string' ? this._raw(trace) : this._text(trace);
        }

        case 'add_flow_note':
          return this._text(await app.addFlowNote(args.flowId, args.text, args.nearCardId, args.color));

        case 'update_flow_note':
          return this._text(await app.updateFlowNote(args.flowId, args.noteCardId, args.text));

        case 'set_flow_folder':
          return this._text(await app.setFlowFolder(args.flowId, args.folderId));

        case 'list_flow_revisions':
          return this._text(await app.listFlowRevisions(args.flowId));

        case 'revert_flow':
          return this._text(await app.revertFlow(args.flowId, args.revision));

        case 'set_flow_enabled':
          return this._text(await app.setFlowEnabled(args.flowId, args.enabled));

        case 'rename_flow':
          return this._text(await app.renameFlow(args.flowId, args.name));

        case 'update_card_args':
          return this._text(await app.updateCardArgs(args.flowId, args.cardId, args.args, args.replace));

        case 'apply_cards':
          return this._text(await app.applyCards(args.flowId, args.cards, args.connections, {
            relayout: args.relayout, requestId: args.requestId,
          }));

        case 'copy_cards':
          return this._text(await app.copyCards(args.fromFlowId, args.toFlowId, {
            cardIds: args.cardIds,
            sectionNoteId: args.sectionNoteId,
            includeNotes: args.includeNotes,
            removeFromSource: args.removeFromSource,
            dryRun: args.dryRun,
            requestId: args.requestId,
          }));

        case 'add_card':
          return this._text(await app.addCard(args.flowId, args.card, args.after, {
            output: args.output, requestId: args.requestId,
          }));

        case 'remove_card':
          return this._text(await app.removeCard(args.flowId, args.cardId, args.confirm));

        case 'connect_cards':
          return this._text(await app.connectCards(args.flowId, args.fromCardId, args.output, args.toCardId, args.connected));

        case 'relayout_flow':
          return this._text(await app.relayoutFlow(args.flowId));

        case 'create_advanced_flow':
          return this._text(await app.createAdvancedFlow(args.name, args.folder, {
            withStartCard: args.withStartCard,
          }));

        case 'get_diagnostics':
          return this._text(await app.getDiagnostics());

        case 'refresh_snapshot':
          return this._text(await app._refreshSnapshot());

        case 'get_cross_references': {
          const xref = await app.getCachedCrossReferences({ checkFreshness: true });
          const { _freshness, ...buckets } = xref;
          return this._text(args.type
            ? Object.assign({ [args.type]: buckets[args.type] }, _freshness)
            : Object.assign({}, buckets, _freshness));
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }

  // Sessions live in memory only, so an app restart invalidates every one of
  // them. Answering with a bare "Session not found" told the client nothing
  // about why, and reconnecting is the fix — which is what a restart of the
  // client turns out to do.
  _sessionGone(sessionId) {
    this._app.log('Rejected a request for unknown MCP session', sessionId,
      '— server started', this._startedAt);
    return {
      error: 'Session not found',
      sessionId: sessionId || null,
      serverStartedAt: this._startedAt,
      detail: 'MCP sessions are held in memory, so they do not survive a restart of the '
        + 'Homey Docs Companion app. This server started at ' + this._startedAt
        + '. Reconnect (initialize again) to get a new session.',
    };
  }

  _recordCall(name, startedMs, outcome) {
    this._calls.unshift({
      tool: name,
      at: new Date(startedMs).toISOString(),
      ms: Date.now() - startedMs,
      outcome,
    });
    if (this._calls.length > CALL_LOG_LIMIT) this._calls.pop();
  }

  // What the server has been asked to do lately, newest first. Reported by
  // get_diagnostics.
  recentCalls() {
    return {
      startedAt: this._startedAt,
      totalCalls: this._callsStarted,
      inFlight: this._inFlight ? Array.from(this._inFlight) : [],
      sseSessions: this._sessions.size,
      streamableSessions: this._streamableSessions.size,
      recent: this._calls,
    };
  }

  // The tools this build exposes. get_diagnostics reports these: a client
  // holding a stale connection presents whatever tool list it cached at
  // startup, and comparing the two is the only way to see that from inside a
  // conversation.
  toolNames() {
    return TOOLS.map(tool => tool.name).sort();
  }
}

module.exports = HomeyMcpServer;
module.exports.TOOLS = TOOLS;
