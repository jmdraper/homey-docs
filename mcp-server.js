'use strict';

const http = require('http');
const { randomUUID } = require('crypto');

function vals(data) {
  if (!data) return [];
  return Array.isArray(data) ? data : Object.values(data);
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
    name: 'list_devices',
    description: 'List all devices connected to Homey, with their names, zones, and capabilities',
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
    name: 'get_changelog',
    description: 'Get recent Homey changes tracked by the companion app — flow creates/renames/modifications/deletions, device changes, variable changes.',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'ISO 8601 date-time string. Only return entries after this timestamp. Omit to get all entries.' },
        types: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by change type(s). Valid values: flow_created, flow_modified, flow_renamed, flow_deleted, flow_enabled, flow_disabled, device_created, device_modified, device_deleted, variable_created, variable_modified, variable_deleted. Omit to get all types.',
        },
      },
    },
  },
  {
    name: 'list_flows_metadata',
    description: 'List all flows (basic and advanced) with lightweight metadata — name, enabled, broken, card count, hash, folder. Faster than get_all_advanced_flows when you only need an overview.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'clear_changelog',
    description: 'Clear all entries from the companion app changelog. Use after the sync skill has processed and documented all pending changes.',
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
    description: 'Returns human-readable titles for all triggers, conditions, and actions exposed by each installed Homey app, keyed by their full card ID strings. Use this to translate opaque app card IDs in flow diffs into readable labels.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'trigger_sync_complete',
    description: "Trigger the Homey 'sync completed' flow card, firing any flows that use it as a WHEN trigger. Call this at the end of a successful sync.",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'poll_now',
    description: 'Force the companion app to poll Homey immediately for changes, rather than waiting for the next 5-minute interval. Call this at the start of the sync process to ensure the changelog is up to date.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_cross_references',
    description: "Get a cross-reference index showing which flows use each variable, FlowBits event, label, set, timer, and programmatic flow trigger. Use to answer 'which flows use variable X?' or 'what fires FlowBits event Y?'.",
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['variables', 'bll_variables', 'flowbits_events', 'flowbits_labels', 'flowbits_sets', 'timers', 'flow_triggers'],
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
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
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
          return this._text(await app._fetchAdvancedFlows());

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

        case 'list_devices': {
          const data = await app._apiGet('/manager/devices/device');
          return this._text(vals(data).map(d => ({
            id: d.id, name: d.name, zone: d.zoneName, class: d.class,
            capabilities: d.capabilities, available: d.available
          })));
        }

        case 'list_zones': {
          const data = await app._apiGet('/manager/zones/zone');
          return this._text(vals(data).map(z => ({ id: z.id, name: z.name, parent: z.parent })));
        }

        case 'list_folders': {
          const data = await app._apiGet('/manager/flow/folder');
          return this._text(vals(data).map(f => ({ id: f.id, name: f.name })));
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

        case 'get_changelog': {
          const since = args.since || null;
          const types = Array.isArray(args.types) && args.types.length > 0 ? args.types : null;
          return this._text(app.getChangelog(since, types));
        }

        case 'list_flows_metadata':
          return this._text(app.getFlowsMetadata());

        case 'clear_changelog':
          return this._text(app.clearChangelog());

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

        case 'trigger_sync_complete':
          return this._text(await app.triggerSyncCompleted());

        case 'poll_now':
          await app._poll();
          return this._text({ polled: true, changelog: app.changelog.length });

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
