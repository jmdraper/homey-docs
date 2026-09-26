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
    description: 'Fetch log entries from the Simple (Sys) Log app. Returns entries newest-first. Each entry has: id, timestamp (ISO 8601), severity, app, message.',
    inputSchema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Case-insensitive substring filter applied to the message field.' },
        since: { type: 'string', description: 'ISO 8601 datetime — only return entries at or after this timestamp.' },
        limit: { type: 'integer', description: 'Maximum number of entries to return. Default 100, max 1000.' },
      },
    },
  },
  {
    name: 'get_app_actions',
    description: 'Returns human-readable titles for all triggers, conditions, and actions exposed by each installed Homey app, keyed by their full card ID strings. Use this to translate opaque app card IDs into readable labels.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_flow_revisions',
    description: 'List the saved pre-edit copies of a flow, newest first. Every edit saves one automatically. Use the revision number with revert_flow.',
    inputSchema: {
      type: 'object',
      properties: { flowId: { type: 'string', description: 'The advanced flow ID' } },
      required: ['flowId'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'revert_flow',
    description: 'Restore a flow to a previously saved revision. The current state is saved first, so a revert can itself be reverted.',
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
    description: 'Add a card to an advanced flow. Pass `after` to place and connect it downstream of an existing card; otherwise it is placed below the flow, unconnected. Coordinates are chosen automatically so cards do not overlap.',
    inputSchema: {
      type: 'object',
      properties: {
        flowId: { type: 'string' },
        card: {
          type: 'object',
          description: 'The card: type (trigger/condition/action/all/any/delay/note), id (the full card id such as homey:device:<uuid>:on), ownerUri, and args.',
        },
        after: { type: 'string', description: 'Card id to place this one after and connect from' },
      },
      required: ['flowId', 'card'],
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
    description: 'Connect or disconnect two cards. The output is outputTrue/outputFalse for conditions, or outputSuccess/outputError for actions.',
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
    description: 'Reposition every card in an advanced flow onto a tidy grid, following the spacing the rest of this Homey uses. Cards keep their connections and arguments; only coordinates change. Note cards are left where they are, since they are positioned beside what they describe.',
    inputSchema: {
      type: 'object',
      properties: { flowId: { type: 'string' } },
      required: ['flowId'],
    },
    annotations: { readOnlyHint: false, idempotentHint: true },
  },
  {
    name: 'create_advanced_flow',
    description: 'Create an empty advanced flow. It is created disabled; add cards with add_card, then enable it with set_flow_enabled.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        folder: { type: 'string', description: 'Folder id from list_folders' },
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

class HomeyMcpServer {
  constructor(app) {
    this._app = app;
    this._server = null;
    this._sessions = new Map();          // SSE transport: sessionId -> response stream
    this._streamableSessions = new Set(); // Streamable HTTP transport: active session IDs
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
    return new Promise(resolve => {
      if (this._server) this._server.close(resolve);
      else resolve();
    });
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
        res.end(JSON.stringify({ error: 'Session not found' }));
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

      this._sessions.set(sessionId, res);
      req.on('close', () => this._sessions.delete(sessionId));

      // Send absolute URL — the MCP spec requires this, relative paths confuse some clients
      const host = req.headers.host || `localhost:${this._server.address().port}`;
      res.write(`event: endpoint\ndata: http://${host}/message?sessionId=${sessionId}\n\n`);
      return;
    }

    // Message endpoint — client POSTs JSON-RPC requests here
    if (req.method === 'POST' && url.pathname === '/message') {
      const sessionId = url.searchParams.get('sessionId');
      const sseStream = sessionId ? this._sessions.get(sessionId) : null;

      if (!sseStream) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }

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
              serverInfo: { name: 'homey-mcp', version: '1.0.0' }
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
          const data = await app._apiGet('/app/nl.nielsdeklerk.log/');
          let logs = (data && data.logs) || [];
          if (args.since) { const d = new Date(args.since); logs = logs.filter(e => new Date(e.timestamp) >= d); }
          if (args.search) { const n = args.search.toLowerCase(); logs = logs.filter(e => e.message.toLowerCase().includes(n)); }
          const limit = Math.min(args.limit || 100, 1000);
          return this._text({ count: logs.length, logs: logs.slice(0, limit) });
        }

        case 'get_app_actions':
          return this._text(await app.getAppActions());

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

        case 'add_card':
          return this._text(await app.addCard(args.flowId, args.card, args.after));

        case 'remove_card':
          return this._text(await app.removeCard(args.flowId, args.cardId, args.confirm));

        case 'connect_cards':
          return this._text(await app.connectCards(args.flowId, args.fromCardId, args.output, args.toCardId, args.connected));

        case 'relayout_flow':
          return this._text(await app.relayoutFlow(args.flowId));

        case 'create_advanced_flow':
          return this._text(await app.createAdvancedFlow(args.name, args.folder));

        case 'get_diagnostics':
          return this._text(await app.getDiagnostics());

        case 'refresh_snapshot':
          return this._text(await app._refreshSnapshot());

        case 'get_cross_references': {
          const xref = await app.getCachedCrossReferences();
          return this._text(args.type ? { [args.type]: xref[args.type] } : xref);
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
}

module.exports = HomeyMcpServer;
