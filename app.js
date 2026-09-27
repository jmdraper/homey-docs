'use strict';

const Homey = require('homey');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// Writable fields on an advanced flow. id, uri and triggerable are read-only,
// and broken is derived by Homey, so sending them back invites a rejection.
const ADVANCED_FLOW_WRITABLE = ['name', 'enabled', 'folder', 'cards'];

// Spacing measured from the flows already on this Homey.
//
// Cards have a fixed width: the parent-to-child gap is 440px whatever the
// parent's arguments contain. Height is not fixed and is not knowable — Homey
// stores width/height only for note cards and computes every other card's size
// at render time — so the gap below a card has to be estimated from how much
// text it will show. Measured medians: 100px below a card with short
// arguments, 120 around 250 characters, 240 around 350. The estimate below is
// deliberately generous, because too much space is cosmetic while an overlap
// is not.
// Width varies by card type, not by content. Trigger, condition and action
// cards render as full-width boxes; start, delay, all and any render as
// compact pills. Spacing left edge to left edge by one constant therefore
// leaves a wide card almost touching its child while a pill sits marooned.
// These are the gaps measured per parent type on this Homey.
// Rough extents for measuring how near a note is to a card. Card width is
// effectively fixed — the parent-to-child gap is 440 whatever the card holds —
// and a note is roughly that wide too.
const CARD_WIDTH_ESTIMATE = 400;
const NOTE_WIDTH_ESTIMATE = 400;

// Gates render narrow enough to sit beside a card rather than under it
const GATE_TYPES = new Set(['all', 'any']);
// Measured off the canvas: a card is about five times the width of a gate
const GATE_WIDTH_ESTIMATE = 120;
// How far right of the cards at the same depth their gates are drawn
const GATE_LANE_OFFSET = 460;

const CARD_GAP_X_BY_TYPE = {
  start: 160,
  all: 180,
  any: 200,
  delay: 200,
  trigger: 440,
  action: 440,
  condition: 460,
};
const CARD_GAP_X = 440;
// Heights vary by type too. start, delay and any render short and fixed; an
// ALL card grows with the number of connections feeding it, measured here at
// roughly 120px at two inputs rising to 500px at ten.
// Compact card types render short whatever they contain
const CARD_GAP_Y_COMPACT = { start: 80, delay: 80, any: 80 };
// A full-size card with no arguments shows one line of text; with arguments it
// shows two or more. The measured "action median 100, mode 80" is these two
// populations, not one: device cards like Turn on carry no args and sit 80
// apart, while log cards carrying text sit 100 apart.
const CARD_GAP_Y_BARE = 80;
const CARD_GAP_Y_ALL_BASE = 24;   // fits the measured 120 at 2 inputs, 500 at 10
const CARD_GAP_Y_ALL_PER_INPUT = 48;
const CARD_GAP_Y = 100;
const CARD_GAP_Y_MAX = 220;
const CARD_ROW_GAP_Y = 260;
// Nothing is added between one behaviour and the next: a band's extent already
// runs to below its lowest card, so that allowance is the separation. Adding
// more on top pushes every behaviour progressively further down the canvas.
const CARD_BAND_GAP_Y = 0;
// Rounds of candidate layouts to try before settling; convergence is quick
const LAYOUT_ROUNDS = 6;
// How many times to re-read the note anchors before accepting a cycle
const LAYOUT_SETTLE_PASSES = 64;
// A ceiling on the search, for flows that drift instead of settling
const LAYOUT_MAX_ARRANGEMENTS = 48;
// Note height also grows with its text: measured 80 for a short note, rising
// 20 per 40 characters. A note sits its own height above the card it heads.
const NOTE_HEIGHT_BASE = 80;
const NOTE_HEIGHT_PER_CHARS = 40;
const NOTE_HEIGHT_MAX = 200;
// Breathing room between a heading note and whatever sits above it
const NOTE_GAP_ABOVE = 40;
// A note sits tighter to the card it labels than to anything else — that
// asymmetry is what makes it read as belonging to that card rather than to
// whatever is on its other side.
const NOTE_ATTACH_GAP = 16;
// Homey's canvas controls float over the top of the flow, so anything up there
// is hidden at the default scroll position. Flows on this Homey start at y=0,
// 20, 40 or 60 and none above it — the one exception was a note this app
// placed at -80, which is what prompted the margin.
const CANVAS_TOP_MARGIN = 60;
// How close a note must be to a card before it is taken to be about that card,
// measured centre to centre. Distance between bounding boxes was tried first
// and is worse: it saturates at zero the moment two boxes overlap, so a note
// sitting among several cards ties with all of them and attaches to none.
// Centres separate them. Over 517 notes the median is 100 and the 95th
// percentile 238, with a tail to 3841 — notes near nothing in particular.
const NOTE_ATTACH_DISTANCE = 240;
// And how much closer it must be to that card than to the next. Only 25 of the
// 517 are within 20px of two cards; those are genuine ties and guessing
// between them is worse than leaving the note at flow level.
const NOTE_ATTACH_MARGIN = 20;

const CARD_TYPES = new Set(['trigger', 'condition', 'action', 'all', 'any', 'delay', 'note', 'start']);
const CARD_OUTPUTS = ['outputTrue', 'outputFalse', 'outputSuccess', 'outputError'];

// Which outputs each card type can actually drive. Taken from what the 5,003
// cards on this Homey use, not from guesswork: a condition really does have an
// outputError (16 cards use it), and an action really has no true/false branch.
// Used to check explicit requests only — never to validate a whole draft, since
// a flow written by hand is allowed to be odder than this.
const OUTPUTS_BY_TYPE = {
  trigger: ['outputSuccess'],
  delay: ['outputSuccess'],
  all: ['outputSuccess'],
  any: ['outputSuccess'],
  start: ['outputSuccess'],
  condition: ['outputTrue', 'outputFalse', 'outputError'],
  action: ['outputSuccess', 'outputError'],
  note: [],
};

// Pre-edit copies live on disk; app settings hold only the index. Ten revisions
// of a 213-card flow is far too much to keep in settings alongside the snapshot.
const REVISION_DIR = '/userdata/revisions';
const DEFAULT_REVISION_DEPTH = 10;

// How long a write may take before the caller is told rather than left waiting.
// The work is not cancelled — an HTTP PUT already sent cannot be recalled — so
// the answer says which phase it reached and whether Homey has the change.
// Measured: a write on the largest flow here costs about 0.6s, and the slowest
// seen across a 70-card build was 3.1s, so 30s is far outside normal.
const WRITE_TIMEOUT_MS = 30000;

// How long a requestId can be replayed for. Long enough to cover a client
// reconnecting and retrying, short enough that a genuinely new call reusing an
// old id is not silently answered with a stale result.
const REQUEST_REPLAY_MS = 10 * 60 * 1000;

// Rebuilding the cross-reference page walks every card in every flow and
// writes a page of a couple of hundred kilobytes into settings. That is fine
// once, but a burst of writes — building a flow card by card makes dozens —
// repeats it for each one. Coalesce them into a single rebuild once the writes
// stop.
const XREF_REBUILD_DEBOUNCE_MS = 4000;

// A flow that writes, fires or controls something is upstream of it; one that
// reads, checks or triggers on it is downstream. Tracing follows cause rather
// than structure, so "what does this affect" and "what affects this" are
// answerable separately.
const PRODUCING_ROLES = new Set([
  'writes', 'fires', 'activates', 'deactivates', 'toggles', 'clears', 'sends',
  'starts', 'stops', 'controls', 'advances',
]);
const CONSUMING_ROLES = new Set([
  'reads', 'checks', 'triggers_on', 'triggered_by', 'received_by', 'cleared_by',
  'started_by', 'bll_coding',
]);

// Buckets that describe an entity flows act on. flow_triggers and trigger_tokens
// are excluded: the first is flow-to-flow and handled directly, the second keys
// on opaque card ids.
const TRACEABLE_BUCKETS = {
  devices: 'device', variables: 'variable', bll_variables: 'BLL variable',
  timers: 'Chronograph timer', flowbits_events: 'FlowBits event',
  flowbits_labels: 'FlowBits label', flowbits_sets: 'FlowBits set',
  flowbits_signals: 'FlowBits signal', flowbits_modes: 'FlowBits mode',
  flowbits_mode_groups: 'FlowBits mode group', flowbits_timers: 'FlowBits timer',
  flowbits_flags: 'FlowBits flag', flowbits_cycles: 'FlowBits cycle',
  flowbits_sliders: 'FlowBits slider', flowbits_windows: 'no-repeat window',
};

const TRACE_DEFAULT_DEPTH = 3;

// Addresses that cannot be pointed at this Homey by an attacker's DNS: IPv4 and
// IPv6 literals, localhost, and mDNS .local names (resolved by mDNS, not DNS).
const UNREBINDABLE_HOST_RE = /^(?:\[[0-9a-f:]+\]|\d{1,3}(?:\.\d{1,3}){3}|localhost|[a-z0-9-]+\.local)$/i;

// Flow card registries — used to turn card ids into human titles
const FLOW_CARD_PATHS = {
  trigger: '/manager/flow/flowcardtrigger',
  condition: '/manager/flow/flowcardcondition',
  action: '/manager/flow/flowcardaction',
};

// Folder listing moved at some point; probe in order, first success wins
const FLOW_FOLDER_PATHS = [
  '/manager/flow/flowfolder',
  '/manager/flow/advancedflowfolder',
  '/manager/flow/folder',
  '/manager/flowfolder/flowfolder',
];

// Candidate paths for advanced flows — tried in order, first success wins
const ADVANCED_FLOW_PATHS = [
  '/manager/flow/advancedflow',
  '/manager/flow/advanced_flow',
  '/manager/advancedflow/advanced_flow',
  '/manager/flow2/flow',
];

// ─── FlowBits card families ──────────────────────────────────────────────────
// FlowBits identifies entities by card-ID prefix, not by argument shape: mode
// cards and cycle cards both carry the entity name in `args.name`, so dispatching
// on which argument is present cannot tell them apart.
//
// Order matters. `mode_group_` must be tested before `mode_`, and the base cycle
// action is the bare id `cycle` with no trailing underscore.
//
// Autocomplete arguments always serialise as { name: string }. Cards with no
// entity argument at all (mode_active, flag_active, event_clear_all,
// mode_reactivate_current) reference nothing specific and fall out naturally.
//
// `trigger` / `condition` / `action` map a card type to a role, either directly
// or via a function of the card id. Families with a `memberField` are two-level
// (a set and its states, a group and its modes).
const FLOWBITS_FAMILIES = [
  {
    prefix: 'mode_group_', bucket: 'flowbits_mode_groups',
    keyArg: 'group', memberArg: 'name', memberField: 'modes',
    trigger: 'triggers_on', condition: 'checks',
    action: id => (id === 'mode_group_toggle' ? 'toggles'
                 : id.startsWith('mode_group_deactivate') ? 'deactivates' : 'activates'),
  },
  {
    prefix: 'mode_', bucket: 'flowbits_modes', keyArg: 'name',
    trigger: 'triggers_on', condition: 'checks',
    action: id => (id === 'mode_toggle' ? 'toggles'
                 : id.startsWith('mode_deactivate') ? 'deactivates' : 'activates'),
  },
  {
    prefix: 'event_', bucket: 'flowbits_events', keyArg: 'event',
    trigger: id => (id === 'event_cleared' ? 'cleared_by' : 'triggered_by'),
    condition: 'checks',
    action: id => (id.startsWith('event_clear') ? 'clears' : 'fires'),
  },
  {
    prefix: 'label_', bucket: 'flowbits_labels', keyArg: 'label',
    trigger: 'triggers_on', condition: 'checks',
    action: id => (id === 'label_clear' ? 'clears' : 'writes'),
  },
  {
    prefix: 'set_', bucket: 'flowbits_sets',
    keyArg: 'set', memberArg: 'state', memberField: 'states',
    trigger: 'triggers_on', condition: 'checks',
    action: id => (id.startsWith('set_deactivate') ? 'deactivates'
                 : id.startsWith('set_toggle') ? 'toggles' : 'activates'),
  },
  {
    prefix: 'signal_', bucket: 'flowbits_signals', keyArg: 'signal',
    trigger: 'received_by', condition: null, action: 'sends',
  },
  {
    prefix: 'timer_', bucket: 'flowbits_timers', keyArg: 'timer',
    trigger: 'triggers_on', condition: 'checks',
    action: id => (id === 'timer_info' ? 'reads'
                 : (id === 'timer_pause' || id === 'timer_stop') ? 'stops' : 'starts'),
  },
  {
    prefix: 'flag_', bucket: 'flowbits_flags', keyArg: 'flag',
    trigger: 'triggers_on', condition: 'checks',
    action: id => (id === 'flag_deactivate' ? 'deactivates'
                 : id === 'flag_toggle' ? 'toggles' : 'activates'),
  },
  {
    prefix: 'cycle', bucket: 'flowbits_cycles', keyArg: 'name',
    trigger: 'triggers_on', condition: 'checks',
    action: id => (id === 'cycle_to' ? 'writes' : 'advances'),
  },
  {
    prefix: 'slider_', bucket: 'flowbits_sliders', keyArg: 'slider',
    trigger: 'triggers_on', condition: null, action: 'writes',
  },
  {
    prefix: 'no_repeat_', bucket: 'flowbits_windows', keyArg: 'window',
    trigger: null, condition: 'checks', action: 'clears',
  },
];

class HomeyDocsCompanion extends Homey.App {

  async onInit() {
    this._startedAt = new Date().toISOString();
    this.log('Homey Docs Companion ' + this.appVersion() + ' initialising...');

    this.snapshot = this.homey.settings.get('snapshot') || {
      flows: {}, variables: {}, devices: {}, zones: {},
      initialised_at: null
    };
    // One-time cleanup: change tracking was removed, so drop its persisted data
    if (this.homey.settings.get('changelog') !== null) {
      this.homey.settings.unset('changelog');
      this.log('Removed obsolete changelog data');
    }

    try {
      this._baseUrl = await this.homey.api.getLocalUrl();
      this._token = await this.homey.api.getOwnerApiToken();
      this.log('Auth ready, base URL:', this._baseUrl);
    } catch (e) {
      this.error('Failed to get auth credentials:', e.message);
      return;
    }

    // Fetch Homey cloud ID for flow links in the xref viewer
    this._homeyId = null;
    try {
      this._homeyId = await this.homey.cloud.getHomeyId();
      this.log('Homey cloud ID:', this._homeyId);
    } catch (e) {
      this.log('Could not get Homey cloud ID:', e.message);
    }

    // The web app URL is baked into the generated page, so rebuild it whenever
    // the setting changes rather than waiting for the next restart
    this.homey.settings.on('set', key => {
      if (key !== 'xref_base_url') return;
      this.log('Web app URL changed, regenerating cross-reference page');
      this.regenerateXrefPage()
        .catch(e => this.error('Regenerate after settings change failed:', e.message));
    });

    // Resolved before the snapshot refresh, which regenerates the xref page and
    // needs the port to render the MCP setup instructions
    this._mcpPort = parseInt(this.homey.settings.get('mcp_port'), 10) || 8735;

    // Discover advanced flow path once and cache it
    this._advancedFlowPath = this.homey.settings.get('advancedFlowPath') || null;

    // Servers first, so a restart does not take the viewer and MCP offline while
    // Homey is re-read. Both serve from state persisted in settings — the stored
    // page and the previous snapshot — so they answer correctly straight away,
    // at worst with data one refresh interval old. Anything behind a reverse
    // proxy sees a 502 for the whole of this window otherwise.
    await this._startXrefServer();
    await this._startMcpServer();

    // The snapshot is a cache, not a record — rebuild it on every start.
    // Not awaited: it is a background warm-up, and a slow or failing read must
    // not hold up the rest of onInit. Failure is non-fatal for the same reason
    // the servers come first; the interval below retries.
    this._refreshSnapshot()
      .catch(e => this.error('Initial snapshot refresh failed (continuing):', e.message));

    // Keep the cache warm
    this.homey.setInterval(
      () => this._refreshSnapshot().catch(e => this.error('Refresh error:', e.message)),
      REFRESH_INTERVAL_MS
    );

    // Register the flow action card
    this.homey.flow
      .getActionCard('regenerate_xref')
      .registerRunListener(async () => {
        await this.regenerateXrefPage();
        return true;
      });

    this.log(`Ready. Serving ${Object.keys(this.snapshot.flows).length} cached flows, ${Object.keys(this.snapshot.devices).length} devices; refreshing in background.`);
  }

  // ─── HTTP helper ────────────────────────────────────────────────────────────

  _httpsGet(hostname, urlPath) {
    return new Promise((resolve, reject) => {
      const req = https.get({ hostname, path: urlPath, headers: { 'User-Agent': 'homey-docs-companion/1.0' } }, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} for ${urlPath}`)); return; }
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`JSON parse failed for ${urlPath}`)); }
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error(`Timeout: ${urlPath}`)); });
    });
  }

  _apiRequest(method, path, body) {
    const url = `${this._baseUrl}/api${path}`;
    // getLocalUrl() returns http:// or https:// depending on how the app is
    // running — picking the wrong client throws "Protocol not supported"
    const client = url.startsWith('https:') ? https : http;
    const payload = body === undefined ? null : JSON.stringify(body);
    const writeToken = method === 'GET' ? null : this._writeToken();
    const headers = { Authorization: `Bearer ${writeToken || this._token}` };
    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    return new Promise((resolve, reject) => {
      const req = client.request(url, { method, headers }, res => {
        let text = '';
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            // Homey explains rejected writes in the body; a bare status code
            // leaves no way to tell a bad card from a missing permission
            let detail = text.slice(0, 400);
            try {
              const parsed = JSON.parse(text);
              detail = parsed.error || parsed.message || detail;
            } catch (e) { /* keep the raw text */ }
            reject(new Error(`HTTP ${res.statusCode} for ${method} ${path}`
              + (detail ? ` — ${detail}` : '')));
            return;
          }
          if (!text) { resolve(null); return; }
          try { resolve(JSON.parse(text)); }
          catch (e) { reject(new Error(`JSON parse failed for ${path}`)); }
        });
      });
      req.on('error', reject);
      req.setTimeout(20000, () => { req.destroy(); reject(new Error(`Timeout: ${method} ${path}`)); });
      if (payload !== null) req.write(payload);
      req.end();
    });
  }

  _apiGet(path) {
    return this._apiRequest('GET', path);
  }

  // ─── Snapshot helpers ───────────────────────────────────────────────────────

  _flowMeta(flow, isAdvanced = false) {
    // Advanced flows use `cards`, basic flows use trigger/conditions/actions
    const cardPayload = flow.cards || {
      trigger: flow.trigger || null,
      conditions: flow.conditions || [],
      actions: flow.actions || []
    };
    const cardCount = flow.cards
      ? Object.keys(flow.cards).length
      : (flow.trigger ? 1 : 0) + (flow.conditions || []).length + (flow.actions || []).length;
    return {
      name: flow.name,
      folder: flow.folder || null,
      enabled: flow.enabled !== false,
      broken: flow.broken || false,
      cards: cardCount,
      isAdvanced,
      cards_snapshot: JSON.parse(JSON.stringify(cardPayload))
    };
  }

  _deviceMeta(device) {
    const capIds = device.capabilities || [];
    const capObj = device.capabilitiesObj || {};
    const capability_labels = {};
    for (const capId of capIds) {
      const cap = capObj[capId];
      capability_labels[capId] = (cap && (cap.title || (cap.titleObj && cap.titleObj.en))) || capId;
    }
    return {
      name: device.name,
      driverId: device.driverId,
      driverUri: device.driverUri,
      zone: device.zone,
      available: device.available !== false,
      capabilities: capIds,
      capability_labels
    };
  }

  _variableMeta(v) {
    return { name: v.name, type: v.type, value: v.value };
  }

  _zoneMeta(zone) {
    return { name: zone.name, parent: zone.parent || null };
  }

  // ─── Advanced flow path discovery ───────────────────────────────────────────

  async _fetchAdvancedFlows() {
    // Use cached path if already discovered
    if (this._advancedFlowPath) {
      try {
        return await this._apiGet(this._advancedFlowPath);
      } catch (e) {
        this.log('Cached advanced flow path failed, rediscovering...');
        this._advancedFlowPath = null;
      }
    }

    for (const path of ADVANCED_FLOW_PATHS) {
      try {
        const data = await this._apiGet(path);
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          this.log('Advanced flows found at:', path, '—', Object.keys(data).length, 'flows');
          this._advancedFlowPath = path;
          this.homey.settings.set('advancedFlowPath', path);
          return data;
        }
      } catch (e) {
        // try next path
      }
    }

    this.log('Advanced flow path not found — only basic flows tracked');
    return null;
  }

  async _saveState() {
    this.homey.settings.set('snapshot', this.snapshot);
  }

  // ─── Fetch all current state ─────────────────────────────────────────────────

  // Returns null when nothing could be fetched, so callers can tell a genuinely
  // empty Homey from a failed read and avoid clobbering a good cache.
  async _fetchAllFlows() {
    const flows = {};
    let ok = false;

    try {
      const basic = await this._apiGet('/manager/flow/flow');
      for (const [id, flow] of Object.entries(basic || {})) {
        flows[id] = this._flowMeta(flow, false);
      }
      ok = true;
      this.log('Basic flows fetched:', Object.keys(flows).length);
    } catch (e) {
      this.log('Could not fetch basic flows:', e.message);
    }

    try {
      const advanced = await this._fetchAdvancedFlows();
      if (advanced) {
        for (const [id, flow] of Object.entries(advanced)) {
          flows[id] = this._flowMeta(flow, true);
        }
        ok = true;
      }
    } catch (e) {
      this.log('Could not fetch advanced flows:', e.message);
    }

    return ok ? flows : null;
  }

  async _fetchAllDevices() {
    try {
      const data = await this._apiGet('/manager/devices/device');
      const result = {};
      for (const [id, device] of Object.entries(data || {})) {
        result[id] = this._deviceMeta(device);
      }
      return result;
    } catch (e) {
      this.log('Could not fetch devices:', e.message);
      return null;
    }
  }

  async _fetchAllVariables() {
    const paths = ['/manager/logic/variable', '/manager/variable/variable'];
    for (const path of paths) {
      try {
        const data = await this._apiGet(path);
        if (data && typeof data === 'object') {
          const result = {};
          for (const [id, v] of Object.entries(data)) {
            result[id] = this._variableMeta(v);
          }
          return result;
        }
      } catch (e) { /* try next */ }
    }
    this.log('Could not fetch variables');
    return null;
  }

  async _fetchAllZones() {
    try {
      const data = await this._apiGet('/manager/zones/zone');
      const result = {};
      for (const [id, zone] of Object.entries(data || {})) {
        result[id] = this._zoneMeta(zone);
      }
      return result;
    } catch (e) {
      this.log('Could not fetch zones:', e.message);
      return null;
    }
  }

  // ─── Snapshot ────────────────────────────────────────────────────────────────

  // The snapshot is a read cache for the cross-reference builder and the listing
  // tools — not a record of history. Refreshing overwrites it wholesale.
  async _refreshSnapshot() {
    const flows = await this._fetchAllFlows();
    if (flows) this.snapshot.flows = flows;
    else this.error('Flow read failed — keeping the cached index rather than emptying it');

    const devices = await this._fetchAllDevices();
    if (devices) this.snapshot.devices = devices;

    const variables = await this._fetchAllVariables();
    if (variables) this.snapshot.variables = variables;

    const zones = await this._fetchAllZones();
    if (zones) this.snapshot.zones = zones;

    if (!this.snapshot.initialised_at) this.snapshot.initialised_at = new Date().toISOString();

    await this._saveState();
    this.log(`Snapshot refreshed: ${Object.keys(this.snapshot.flows).length} flows, ${Object.keys(this.snapshot.devices).length} devices, ${Object.keys(this.snapshot.zones).length} zones`);

    await this.regenerateXrefPage();
    return { refreshed: true, flows: Object.keys(this.snapshot.flows).length };
  }

  // ─── Public API (called by api.js) ───────────────────────────────────────────

  getSnapshot() {
    const slim = {
      initialised_at: this.snapshot.initialised_at,
      flows: {}, variables: this.snapshot.variables,
      devices: this.snapshot.devices, zones: this.snapshot.zones
    };
    for (const [id, f] of Object.entries(this.snapshot.flows)) {
      const { cards_snapshot, ...rest } = f;
      slim.flows[id] = rest;
    }
    return slim;
  }

  getFlowsMetadata() {
    const result = {};
    for (const [id, f] of Object.entries(this.snapshot.flows)) {
      const { cards_snapshot, ...rest } = f;
      result[id] = rest;
    }
    return result;
  }

  // ─── Flow revisions ──────────────────────────────────────────────────────────

  _revisionDepth() {
    const configured = parseInt(this.homey.settings.get('revision_depth'), 10);
    if (!Number.isFinite(configured) || configured < 1) return DEFAULT_REVISION_DEPTH;
    return Math.min(configured, 50);
  }

  _revisionKey(flowId) {
    return 'revisions_' + flowId;
  }

  // Called before every write. A single pre-edit slot would be overwritten by
  // the next edit in the same session, which is exactly when a revert is wanted.
  async _saveRevision(flowId, flow) {
    const dir = path.join(REVISION_DIR, flowId);
    await fs.promises.mkdir(dir, { recursive: true });

    const now = new Date().toISOString();
    const file = now.replace(/[:.]/g, '-') + '.json';
    await fs.promises.writeFile(path.join(dir, file), JSON.stringify(flow), 'utf8');

    const key = this._revisionKey(flowId);
    const index = this.homey.settings.get(key) || [];
    index.unshift({ file, ts: now, name: flow.name, cards: Object.keys(flow.cards || {}).length });

    for (const dropped of index.splice(this._revisionDepth())) {
      await fs.promises.unlink(path.join(dir, dropped.file)).catch(() => {});
    }
    this.homey.settings.set(key, index);
    return index[0];
  }

  async listFlowRevisions(flowId) {
    if (!flowId) return { error: 'flowId is required' };
    const index = this.homey.settings.get(this._revisionKey(flowId)) || [];
    const current = (this.snapshot.flows || {})[flowId];
    return {
      flowId,
      name: current ? current.name : null,
      depth: this._revisionDepth(),
      revisions: index.map((entry, position) => ({
        revision: position + 1,
        savedAt: entry.ts,
        nameAtSave: entry.name,
        cards: entry.cards
      }))
    };
  }

  async _readRevision(flowId, position) {
    const index = this.homey.settings.get(this._revisionKey(flowId)) || [];
    const entry = index[(position || 1) - 1];
    if (!entry) return null;
    const raw = await fs.promises.readFile(path.join(REVISION_DIR, flowId, entry.file), 'utf8');
    return { entry, flow: JSON.parse(raw) };
  }

  // ─── Card graph validation ───────────────────────────────────────────────────

  // Homey will accept a graph with dangling references and leave the flow
  // subtly broken, so check before writing rather than after.
  _validateCards(cards) {
    if (!cards || typeof cards !== 'object' || Array.isArray(cards)) {
      return ['cards must be an object keyed by card id'];
    }
    const problems = [];
    const known = new Set(Object.keys(cards));

    for (const [cardId, card] of Object.entries(cards)) {
      if (!card || typeof card !== 'object') {
        problems.push(`card ${cardId} is not an object`);
        continue;
      }
      if (!CARD_TYPES.has(card.type)) {
        problems.push(`card ${cardId} has unknown type "${card.type}"`);
      }
      if (typeof card.x !== 'number' || typeof card.y !== 'number') {
        problems.push(`card ${cardId} is missing numeric x/y coordinates`);
      }
      for (const output of CARD_OUTPUTS) {
        if (card[output] === undefined) continue;
        if (!Array.isArray(card[output])) {
          problems.push(`card ${cardId}.${output} must be an array of card ids`);
          continue;
        }
        for (const target of card[output]) {
          if (!known.has(target)) {
            problems.push(`card ${cardId}.${output} points at ${target}, which is not in this flow`);
          }
          if (target === cardId) {
            problems.push(`card ${cardId}.${output} points at itself`);
          }
        }
      }
    }

    // An ALL card's input array must agree with the edges that actually reach it
    for (const [cardId, card] of Object.entries(cards)) {
      if (!card || card.type !== 'all') continue;
      const reaching = [];
      for (const [otherId, other] of Object.entries(cards)) {
        if (!other || typeof other !== 'object') continue;
        for (const output of CARD_OUTPUTS) {
          if ((other[output] || []).includes(cardId)) reaching.push(otherId + '::' + output);
        }
      }
      const declared = Array.isArray(card.input) ? card.input : [];
      if (declared.length !== reaching.length
          || reaching.some(entry => !declared.includes(entry))) {
        problems.push(`ALL card ${cardId} lists ${declared.length} input(s) but `
          + `${reaching.length} connection(s) reach it`);
      }
    }

    const runnable = Object.values(cards)
      .some(card => card && (card.type === 'trigger' || card.type === 'start'));
    if (!runnable) problems.push('flow has no trigger or start card, so it could never run');

    return problems;
  }

  // An ALL card carries an explicit `input` array of "<cardId>::<output>"
  // entries, one per incoming connection — no other card type has one, and
  // Homey sizes the card from it. Editing an output array without updating it
  // leaves the gate rendering the wrong number of sockets and disagreeing with
  // its own connections, so rebuild it from the edges after every change.
  // Existing entries keep their order, so a write does not reshuffle sockets
  // the author arranged.
  _syncAllInputs(cards) {
    const incoming = {};
    for (const [cardId, card] of Object.entries(cards)) {
      if (!card || typeof card !== 'object') continue;
      for (const output of CARD_OUTPUTS) {
        for (const target of (card[output] || [])) {
          (incoming[target] = incoming[target] || []).push(cardId + '::' + output);
        }
      }
    }
    for (const [cardId, card] of Object.entries(cards)) {
      if (!card || card.type !== 'all') continue;
      const actual = incoming[cardId] || [];
      const existing = Array.isArray(card.input) ? card.input : [];
      const kept = existing.filter(entry => actual.includes(entry));
      card.input = kept.concat(actual.filter(entry => !kept.includes(entry)));
    }
  }

  // Accepts a full card id or any unambiguous prefix, so the short ids shown by
  // get_flow_summary can be used directly.
  _resolveCardId(cards, given) {
    if (!given) return { error: 'cardId is required' };
    if (cards[given]) return { cardId: given };
    const matches = Object.keys(cards).filter(id => id.startsWith(given));
    if (matches.length === 1) return { cardId: matches[0] };
    if (matches.length === 0) return { error: `no card in this flow starts with "${given}"` };
    return { error: `"${given}" matches ${matches.length} cards; use more characters` };
  }

  // The output to connect from, given what the caller asked for and what the
  // source card can drive. Defaulting silently to outputSuccess is what made a
  // card added after a condition land on the true branch when the false one was
  // meant, with nothing in the result to say so.
  _resolveOutput(card, requested) {
    const valid = OUTPUTS_BY_TYPE[card.type] || CARD_OUTPUTS;
    if (!requested) {
      if (!valid.length) return { error: 'a ' + card.type + ' card has no outputs to connect from' };
      return { output: valid[0] };
    }
    if (!CARD_OUTPUTS.includes(requested)) {
      return { error: 'output must be one of ' + CARD_OUTPUTS.join(', ') };
    }
    if (!valid.includes(requested)) {
      const list = valid.length > 1
        ? valid.slice(0, -1).join(', ') + ' or ' + valid[valid.length - 1]
        : valid[0];
      return { error: 'a ' + card.type + ' card has no ' + requested
        + (valid.length ? '; it drives ' + list : ' — it has no outputs at all') };
    }
    return { output: requested };
  }

  appVersion() {
    return (this.homey && this.homey.manifest && this.homey.manifest.version) || 'unknown';
  }

  // ─── Request guards ──────────────────────────────────────────────────────────

  // Read through rather than cached. This was previously read once at startup,
  // so editing it in the app's settings left flow links pointing at the old URL
  // until the app restarted — with no sign that anything had been missed.
  _getXrefBaseUrl() {
    return String(this.homey.settings.get('xref_base_url') || 'https://my.homey.app')
      .trim().replace(/\/$/, '');
  }

  // The scopes of the owner API token, read from the JWT payload. Writes to
  // flows need homey.flow, while reads only need homey.flow.readonly, and a
  // token short of the former fails with a bare "Missing Scopes". The token
  // itself is never returned — only which scopes it carries.
  _tokenScopes() {
    try {
      const segments = String(this._token || '').split('.');
      if (segments.length < 2) return 'token is not a JWT';
      const payload = JSON.parse(Buffer.from(segments[1], 'base64', 'utf8').toString('utf8'));
      const scope = payload.scope || payload.scopes;
      if (!scope) return { noScopeClaim: Object.keys(payload) };
      return Array.isArray(scope) ? scope : String(scope).split(/[\s,]+/);
    } catch (e) {
      return 'could not decode: ' + e.message;
    }
  }

  // Writes need the homey.flow scope; the owner API token only carries
  // homey.flow.readonly, so Homey answers a write with "Missing Scopes". A
  // Personal Access Token created by the user can carry the write scope, and
  // requiring them to provision one deliberately suits a feature that edits
  // their automations.
  _writeToken() {
    const token = String(this.homey.settings.get('write_token') || '').trim();
    return token || null;
  }

  _allowedHosts() {
    return String(this.homey.settings.get('allowed_hosts') || '')
      .split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
  }

  // Rejections are kept so the cause is visible in diagnostics. A reverse proxy
  // forwards its own hostname, and an upstream 403 can surface as a 502 at the
  // proxy, which hides the reason entirely — this is how you find out which
  // host to allow.
  _recordRejection(req, reason) {
    if (!this._rejections) this._rejections = [];
    const host = String(req.headers.host || '(none)');
    const existing = this._rejections.find(e => e.host === host && e.reason === reason);
    if (existing) {
      existing.count += 1;
      existing.lastSeen = new Date().toISOString();
      return;
    }
    this._rejections.unshift({
      host, origin: req.headers.origin || null, reason,
      count: 1, lastSeen: new Date().toISOString()
    });
    if (this._rejections.length > 10) this._rejections.pop();
  }

  // Returns null when a request is acceptable, or a reason to reject it.
  //
  // The attack these guard against is not a peer on the LAN — it is the user's
  // own browser. A page they visit can resolve an attacker-controlled name to
  // this Homey and then talk to these servers, which no amount of network trust
  // prevents. Requiring the Host header to name an address that cannot be
  // rebound closes that; anything else can be allowlisted in settings, which is
  // what a Tailscale MagicDNS name needs.
  //
  // allowSameOrigin is for the cross-reference viewer, whose own page must be
  // able to POST back to it. The MCP server has no browser client at all —
  // mcp-remote is a local Node process and sends no Origin — so any Origin
  // there is a browser that has no business talking to it.
  _checkRequest(req, options) {
    const allowSameOrigin = !!(options && options.allowSameOrigin);
    const hostHeader = String(req.headers.host || '').toLowerCase();
    const hostname = hostHeader.replace(/:\d+$/, '');

    if (!hostname) return 'missing Host header';
    if (!UNREBINDABLE_HOST_RE.test(hostname) && !this._allowedHosts().includes(hostname)) {
      return 'Host "' + hostname + '" is not a local address — add it to the '
        + '"Additional allowed hosts" app setting if this is expected';
    }

    const origin = req.headers.origin;
    if (!origin) return null;
    if (!allowSameOrigin) return 'requests carrying an Origin header are not accepted';
    let originHost;
    try { originHost = new URL(origin).host.toLowerCase(); }
    catch (e) { return 'malformed Origin header'; }
    if (originHost !== hostHeader) return 'cross-origin request from ' + origin + ' rejected';
    return null;
  }

  // ─── Writing advanced flows ──────────────────────────────────────────────────

  _writesEnabled() {
    const value = this.homey.settings.get('writes_enabled');
    return value === true || value === 'true';
  }

  _explainWriteFailure(error) {
    const message = String(error && error.message || error);
    if (!/missing scopes/i.test(message)) return 'Homey rejected the write: ' + message;
    return 'Homey rejected the write for lack of permission. Editing flows needs the '
      + '"homey.flow" scope, which the app\'s own token does not carry — it can only '
      + 'read flows. Create a Personal Access Token with flow write access in the Homey '
      + 'web app and paste it into "Personal Access Token" in this app\'s settings. '
      + '(' + message + ')';
  }

  async _installedAppIds() {
    if (this._appIds && (Date.now() - this._appIdsAt) < 60000) return this._appIds;
    try {
      const apps = await this._apiGet('/manager/apps/app');
      this._appIds = new Set(Object.keys(apps || {}));
      this._appIdsAt = Date.now();
    } catch (e) {
      this._appIds = null;   // unknown, so skip the check rather than block a write
    }
    return this._appIds;
  }

  // The installed apps, read live. This used to be held in the snapshot, but
  // nothing ever filled it: the field was declared, a _appMeta shaper was
  // written for it, and no polling path ever called either. Reading it fresh
  // is right anyway — an app that crashed two minutes ago has silently broken
  // every flow that uses its cards, and a five-minute-old copy would not say so.
  async listApps() {
    const apps = await this._apiGet('/manager/apps/app');
    if (!apps || typeof apps !== 'object') {
      return { error: 'could not read the installed apps from Homey' };
    }
    return Object.entries(apps).map(([id, app]) => {
      const entry = { id, name: (app && app.name) || id };
      // Pass through only what Homey actually sent, so a field it stops
      // returning shows as absent rather than as a confident wrong answer.
      for (const field of ['version', 'channel', 'origin', 'state', 'enabled', 'crashed']) {
        if (app && app[field] !== undefined) entry[field] = app[field];
      }
      return entry;
    }).sort((a, b) => a.name.localeCompare(b.name));
  }

  // Writes to one flow run one at a time. Every write is a read-modify-write of
  // the whole card graph, so two overlapping calls both read the same state and
  // both PUT it — and the second silently discards the first. Nothing reports
  // that; cards simply go missing. Queueing per flow costs nothing (writes take
  // under a second) and removes the failure entirely. Different flows still run
  // in parallel.
  _queueFlowWrite(flowId, work) {
    if (!this._flowWrites) this._flowWrites = new Map();
    const previous = this._flowWrites.get(flowId) || Promise.resolve();
    const queued = previous.then(work, work);
    // The chain must not break on a rejection, or every later write to this
    // flow inherits it
    const settled = queued.then(() => {}, () => {});
    this._flowWrites.set(flowId, settled);
    settled.then(() => {
      if (this._flowWrites.get(flowId) === settled) this._flowWrites.delete(flowId);
    });
    return queued;
  }

  // Answer the caller within WRITE_TIMEOUT_MS whatever happens. The work keeps
  // running — an HTTP PUT cannot be unsent, and abandoning it midway would leave
  // our caches describing a state Homey does not have — so the timeout is a
  // report, not a cancellation. What the caller needs to know is whether Homey
  // has already been told, which is the difference between "retry" and "check
  // first", and that is what `phase` carries.
  //
  // Before this, nothing bounded a tool call at all: the per-request socket
  // timeout covers one HTTP round trip, and a call makes several with file and
  // settings writes between them.
  async _answerWithin(phase, work) {
    let timer = null;
    const expired = Symbol('expired');
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => resolve(expired), WRITE_TIMEOUT_MS);
      if (timer.unref) timer.unref();
    });

    const result = await Promise.race([work, timeout]);
    clearTimeout(timer);
    if (result !== expired) return result;

    // Saying "nothing was written" is only honest if the write is also stopped.
    // Everything up to the PUT is local work, so a timeout that arrives before
    // it abandons the call outright — set here, checked in the one synchronous
    // breath before the PUT goes out, so there is no window where both sides
    // think the other is handling it. Once the PUT is away it cannot be
    // recalled, and the answer says so instead.
    const wasQueued = phase.name === 'queued';
    if (!phase.putSent) phase.abandoned = true;

    const seconds = Math.round(WRITE_TIMEOUT_MS / 1000);
    const common = {
      timedOut: true, afterSeconds: seconds, phase: phase.name,
      putSent: phase.putSent, putSentAt: phase.putAt,
    };
    if (phase.putSent) {
      return Object.assign({ error: 'Timed out after ' + seconds + 's waiting for Homey to '
        + 'acknowledge the write. The PUT was sent at ' + phase.putAt + ', so Homey may well '
        + 'have applied it. Do not retry blind — read the flow back and check. A revision was '
        + 'saved before the write, so revert_flow undoes it either way.' }, common);
    }
    if (wasQueued) {
      return Object.assign({ error: 'Timed out after ' + seconds + 's still queued behind '
        + 'earlier writes to this flow. This call has been abandoned and wrote nothing, so it '
        + 'is safe to retry — but something is holding that queue, so find out what before '
        + 'retrying or this will queue behind it too.' }, common);
    }
    return Object.assign({ error: 'Timed out after ' + seconds + 's during "' + phase.name
      + '". The call has been abandoned before anything was sent to Homey, so nothing was '
      + 'written and this is safe to retry.' }, common);
  }

  // A repeated requestId returns the first call's result instead of doing the
  // work again. The point is a retry after a timeout or a dropped connection:
  // without it, the only safe response to "did that add_card land?" is to read
  // the flow back and compare, and the unsafe response is to call it again and
  // end up with two cards.
  //
  // A plain failure is not remembered — it wrote nothing, so a retry should
  // really retry. A timeout is, because the original work is still running and
  // the retry should wait for it and report what it did.
  _replayable(result) {
    if (!result || typeof result !== 'object') return true;
    // Remember a failure only when Homey may already have the change. Anything
    // that demonstrably wrote nothing should be genuinely retried, not answered
    // with a stale copy of its own failure.
    if (result.error) return !!result.putSent;
    return true;
  }

  async _idempotent(requestId, work) {
    if (!requestId) return work();
    const id = String(requestId);
    if (!this._requests) this._requests = new Map();

    const cutoff = Date.now() - REQUEST_REPLAY_MS;
    for (const [key, entry] of this._requests) {
      if (entry.startedMs < cutoff) this._requests.delete(key);
    }

    const existing = this._requests.get(id);
    if (existing) {
      const result = await existing.promise;
      this.log('requestId ' + id + ' replayed rather than repeated');
      return Object.assign({}, result, {
        replayed: true, requestId: id, originallyRanAt: existing.at,
        replayNote: 'This is the result of the earlier call with the same requestId, not a '
          + 'second write. Nothing was written again.',
      });
    }

    const entry = { at: new Date().toISOString(), startedMs: Date.now() };
    entry.promise = Promise.resolve().then(work).then(result => {
      if (!this._replayable(result)) this._requests.delete(id);
      return result;
    }, error => {
      this._requests.delete(id);
      throw error;
    });
    this._requests.set(id, entry);
    const result = await entry.promise;
    return Object.assign({}, result, { requestId: id });
  }

  // Every write goes through here: gate, read the live flow, keep a copy,
  // mutate a draft, validate, PUT, then bring our own caches back in line.
  // Reading live rather than from the snapshot matters — the snapshot can be
  // five minutes old, and writing from it would silently revert a change made
  // in the flow editor in the meantime.
  async _mutateAdvancedFlow(flowId, describe, mutate, options) {
    if (!this._writesEnabled()) {
      return { error: 'Editing is turned off. Enable "Allow AI assistants to edit flows" in the app settings first.' };
    }
    if (!flowId) return { error: 'flowId is required' };

    const phase = { name: 'queued', putSent: false, putAt: null };
    const work = this._queueFlowWrite(flowId,
      () => this._writeAdvancedFlow(flowId, describe, mutate, phase, options || {}));
    // Never leave an unhandled rejection behind when the timeout answers first
    work.catch(e => this.error('Write to ' + flowId + ' failed after the caller was answered:', e.message));
    return this._answerWithin(phase, work);
  }

  _abandoned(phase, where) {
    return { error: 'Abandoned while ' + where + ': the caller had already been told this call '
      + 'timed out. Nothing was written.', abandoned: true, timedOut: true, putSent: false };
  }

  async _writeAdvancedFlow(flowId, describe, mutate, phase, options) {
    const startedMs = Date.now();
    if (phase.abandoned) return this._abandoned(phase, 'still queued');
    phase.name = 'reading the flow';

    let flow;
    try {
      flow = await this._apiGet('/manager/flow/advancedflow/' + flowId);
    } catch (e) {
      return { error: 'Could not read flow ' + flowId + ': ' + e.message };
    }
    if (!flow || !flow.cards) {
      return { error: 'Flow ' + flowId + ' is not an advanced flow (only advanced flows can be edited)' };
    }

    const draft = JSON.parse(JSON.stringify(flow));
    let outcome;
    phase.name = 'applying the edit';
    try {
      outcome = await mutate(draft);
    } catch (e) {
      return { error: 'Edit failed: ' + e.message };
    }
    if (outcome && outcome.error) return outcome;

    // An edit that changes nothing still cost a revision and a PUT, which is
    // how a retry of something that had already worked looked identical to a
    // fresh write. Say so instead, and touch nothing.
    if (outcome && outcome.noChange) {
      const { noChange, ...rest } = outcome;
      return Object.assign({
        ok: true, flowId, flow: draft.name,
        changed: 'nothing — the flow was already in this state',
        wrote: false,
      }, rest);
    }

    this._syncAllInputs(draft.cards);
    phase.name = 'validating';
    const problems = this._validateCards(draft.cards);
    if (problems.length) {
      return { error: 'Refusing to write — the result would be a broken flow', problems };
    }

    // Only once the edit is known to be good. Saving before attempting it meant
    // a rejected edit still consumed a revision, pushing the one worth keeping
    // down the stack — so a revert after a failed call restored the state the
    // failure had left, not the state before the last real change.
    phase.name = 'saving a revision';
    const revision = await this._saveRevision(flowId, flow);

    const body = {};
    for (const field of ADVANCED_FLOW_WRITABLE) {
      if (draft[field] !== undefined) body[field] = draft[field];
    }

    // The atomic point. Nothing may await between the check and setting
    // putSent, or a timeout landing in the gap would be told nothing was sent
    // while the PUT went out anyway.
    if (phase.abandoned) return this._abandoned(phase, 'about to write');
    phase.name = 'writing to Homey';
    phase.putSent = true;
    phase.putAt = new Date().toISOString();
    try {
      await this._apiRequest('PUT', '/manager/flow/advancedflow/' + flowId, body);
    } catch (e) {
      return { error: this._explainWriteFailure(e), putSent: true, putSentAt: phase.putAt };
    }

    phase.name = 'refreshing our own caches';
    await this._resyncFlow(flowId);
    phase.name = 'done';
    return Object.assign({
      ok: true,
      flowId,
      flow: draft.name,
      changed: describe,
      wrote: true,
      revisionSaved: revision.ts,
      revisionMergedWrites: revision.writes > 1 ? revision.writes : undefined,
      tookMs: Date.now() - startedMs,
      revertWith: 'revert_flow'
    }, outcome || {});
  }

  // A write leaves the snapshot and the cross-reference index describing the
  // previous state; without this the viewer serves a stale picture until the
  // next refresh.
  async _resyncFlow(flowId) {
    try {
      const fresh = await this._apiGet('/manager/flow/advancedflow/' + flowId);
      if (fresh) this.snapshot.flows[flowId] = this._flowMeta(fresh, true);
      await this._saveState();
      // The cache is dropped at once, so the next reader recomputes; only the
      // expensive page rebuild is deferred
      this._xrefCache = null;
      this._scheduleXrefRebuild();
    } catch (e) {
      this.error('Post-write resync failed (the write succeeded):', e.message);
    }
  }

  _scheduleXrefRebuild() {
    if (this._xrefRebuildTimer) this.homey.clearTimeout(this._xrefRebuildTimer);
    this._xrefRebuildTimer = this.homey.setTimeout(() => {
      this._xrefRebuildTimer = null;
      this.regenerateXrefPage()
        .catch(e => this.error('Deferred cross-reference rebuild failed:', e.message));
    }, XREF_REBUILD_DEBOUNCE_MS);
  }

  async setFlowEnabled(flowId, enabled) {
    return this._mutateAdvancedFlow(flowId, enabled ? 'enabled the flow' : 'disabled the flow',
      draft => { draft.enabled = !!enabled; });
  }

  async renameFlow(flowId, name) {
    if (!name || typeof name !== 'string' || !name.trim()) return { error: 'name is required' };
    return this._mutateAdvancedFlow(flowId, 'renamed to "' + name.trim() + '"',
      draft => { draft.name = name.trim(); });
  }

  async updateCardArgs(flowId, cardId, args, replace) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return { error: 'args must be an object' };
    }
    return this._mutateAdvancedFlow(flowId, 'updated card arguments', draft => {
      const found = this._resolveCardId(draft.cards, cardId);
      if (found.error) return found;
      const card = draft.cards[found.cardId];
      const before = card.args || {};
      card.args = replace ? args : Object.assign({}, before, args);
      return { cardId: found.cardId, argsBefore: before, argsAfter: card.args };
    });
  }

  async removeCard(flowId, cardId, confirm) {
    if (confirm !== true) {
      return { error: 'Removing a card is destructive. Pass confirm: true once the user has agreed.' };
    }
    return this._mutateAdvancedFlow(flowId, 'removed a card', draft => {
      const found = this._resolveCardId(draft.cards, cardId);
      if (found.error) return found;
      const removed = draft.cards[found.cardId];
      delete draft.cards[found.cardId];

      // Every reference to it must go too, or the graph is left dangling
      let unlinked = 0;
      for (const card of Object.values(draft.cards)) {
        for (const output of CARD_OUTPUTS) {
          if (!Array.isArray(card[output])) continue;
          const before = card[output].length;
          card[output] = card[output].filter(target => target !== found.cardId);
          unlinked += before - card[output].length;
        }
      }
      return {
        removedCardId: found.cardId,
        removedType: removed.type,
        removedCard: removed.id || null,
        incomingLinksRemoved: unlinked
      };
    });
  }

  async connectCards(flowId, fromCardId, output, toCardId, connected) {
    if (!CARD_OUTPUTS.includes(output)) {
      return { error: 'output must be one of ' + CARD_OUTPUTS.join(', ') };
    }
    const join = connected !== false;
    return this._mutateAdvancedFlow(flowId, join ? 'connected two cards' : 'disconnected two cards', draft => {
      const from = this._resolveCardId(draft.cards, fromCardId);
      if (from.error) return from;
      const to = this._resolveCardId(draft.cards, toCardId);
      if (to.error) return to;

      const card = draft.cards[from.cardId];
      const valid = this._resolveOutput(card, output);
      if (valid.error) return valid;

      const links = Array.isArray(card[output]) ? card[output] : [];
      const already = links.includes(to.cardId);
      const common = { from: from.cardId, output, to: to.cardId, connected: join };

      // Both directions report the no-op rather than hiding it. Connecting was
      // silently successful whether or not it did anything, so a retry after a
      // dropped response looked exactly like the first call and there was no
      // way to tell the two apart. Disconnecting an absent link was an error,
      // which made the same retry look like a failure. Neither told the truth:
      // the flow is in the state that was asked for, and nothing was written.
      if (join && already) {
        return Object.assign({ noChange: true, alreadyConnected: true }, common);
      }
      if (!join && !already) {
        return Object.assign({ noChange: true, alreadyDisconnected: true }, common);
      }

      if (join) links.push(to.cardId);
      else links.splice(links.indexOf(to.cardId), 1);
      card[output] = links;
      return Object.assign({ alreadyConnected: false }, common);
    });
  }

  _columnGapAfter(card) {
    return CARD_GAP_X_BY_TYPE[card && card.type] || CARD_GAP_X;
  }

  // How far below a card the next sibling should sit, given how tall it will
  // render. Argument length is the only signal available before rendering.
  _noteHeight(note) {
    const length = String((note && note.value) || '').length;
    const height = NOTE_HEIGHT_BASE
      + (Math.floor(length / NOTE_HEIGHT_PER_CHARS) * 20);
    return Math.min(height, NOTE_HEIGHT_MAX);
  }

  // Calibrated against the smallest gaps that appear between cards sharing a
  // column in hand-drawn flows. Those are a lower bound on how tall a card
  // renders, because nobody overlaps them deliberately — unlike the median,
  // which reflects taste rather than the constraint.
  _siblingGapBelow(card) {
    const type = card && card.type;

    // An ALL card is sized by how many connections feed into it
    if (type === 'all') {
      const inputs = Array.isArray(card.input) ? card.input.length : 0;
      return CARD_GAP_Y_ALL_BASE + (inputs * CARD_GAP_Y_ALL_PER_INPUT);
    }
    if (CARD_GAP_Y_COMPACT[type]) return CARD_GAP_Y_COMPACT[type];
    if (type === 'note') return this._noteHeight(card);

    let text = '';
    try { text = JSON.stringify(card.args || {}); } catch (e) { text = ''; }
    if (text.length <= 20) return CARD_GAP_Y_BARE;     // no arguments to show
    // Grows in 20px steps rather than staying flat to 200 characters, which
    // left log cards carrying a sentence overlapping the card below them
    const extra = Math.ceil((text.length - 20) / 80) * 20;
    return Math.min(CARD_GAP_Y + extra, CARD_GAP_Y_MAX);
  }

  async addCard(flowId, card, after, options) {
    const opts = options || {};
    if (opts.requestId) {
      return this._idempotent(opts.requestId,
        () => this.addCard(flowId, card, after, Object.assign({}, opts, { requestId: null })));
    }
    if (!card || typeof card !== 'object') return { error: 'card must be an object' };
    if (!CARD_TYPES.has(card.type)) {
      return { error: 'card.type must be one of ' + Array.from(CARD_TYPES).join(', ') };
    }
    if (opts.output && !after) {
      return { error: 'output only means something with after — it names which output of that card to connect from' };
    }

    const ownerApp = String(card.ownerUri || '').match(/^homey:app:([^:]+)$/);
    if (ownerApp) {
      const installed = await this._installedAppIds();
      if (installed && !installed.has(ownerApp[1])) {
        return { error: 'app ' + ownerApp[1] + ' is not installed, so its cards cannot be added' };
      }
    }

    return this._mutateAdvancedFlow(flowId, 'added a ' + card.type + ' card', draft => {
      const newCard = Object.assign({}, card);
      const cardId = crypto.randomUUID();
      const existing = Object.values(draft.cards);
      const result = {};

      // A note labels the section beside it. It is never connected, and Homey
      // sizes it at render time, so width and height stay null.
      const isNote = newCard.type === 'note';
      if (isNote) {
        if (!newCard.value) return { error: 'a note card needs a value (the text to show)' };
        if (!newCard.color) newCard.color = 'yellow';
        newCard.width = null;
        newCard.height = null;
      }

      let anchorId = null;
      let needsRoom = false;
      if (after) {
        const anchor = this._resolveCardId(draft.cards, after);
        if (anchor.error) return anchor;
        anchorId = anchor.cardId;
      }

      if (isNote && typeof newCard.x !== 'number') {
        const anchor = anchorId ? draft.cards[anchorId] : null;
        const height = this._noteHeight(newCard);
        const clearance = height + NOTE_GAP_ABOVE;
        const column = anchor ? (anchor.x || 0) : 0;
        const base = anchor ? (anchor.y || 0)
          : (existing.length ? Math.min.apply(null, existing.map(c => c.y || 0)) : 0);

        // Clear of every card already placed, and below the canvas controls
        const free = y => y >= CANVAS_TOP_MARGIN && !existing.some(card => {
          if (Math.abs((card.x || 0) - column) >= CARD_GAP_X) return false;
          const top = card.y || 0;
          return y < top + this._siblingGapBelow(card) && top < y + height;
        });

        // A note is read as belonging to whichever card it is nearest — that is
        // how get_flow_summary attributes it, and how a person reads the canvas.
        // So a position is only good if the anchor is what it lands nearest to.
        // Placing it merely somewhere clear is not enough: in a dense flow the
        // gap above a card can be closer to its neighbour than to the card the
        // note is about, and the note then reads as annotating the wrong thing.
        const anchorIsNearest = y => {
          if (!anchorId) return true;
          const noteCentreX = column + (NOTE_WIDTH_ESTIMATE / 2);
          const noteCentreY = y + (height / 2);
          let nearest = null;
          let nearestDistance = Infinity;
          for (const [otherId, other] of Object.entries(draft.cards)) {
            if (!other || other.type === 'note') continue;
            const dx = ((other.x || 0) + (CARD_WIDTH_ESTIMATE / 2)) - noteCentreX;
            const dy = ((other.y || 0) + (this._siblingGapBelow(other) / 2)) - noteCentreY;
            const distance = Math.sqrt((dx * dx) + (dy * dy));
            if (distance < nearestDistance) { nearestDistance = distance; nearest = otherId; }
          }
          return nearest === anchorId && nearestDistance <= NOTE_ATTACH_DISTANCE;
        };

        // Above the card it labels reads best, below is the next choice, and
        // beyond that step further out.
        const below = anchor ? this._siblingGapBelow(anchor) + NOTE_GAP_ABOVE : clearance;
        const candidates = [];
        for (let step = 0; step < 10; step++) {
          candidates.push(base - clearance - (step * (height + NOTE_GAP_ABOVE)));
          candidates.push(base + below + (step * (height + NOTE_GAP_ABOVE)));
        }

        let chosen = candidates.find(y => free(y) && anchorIsNearest(y));
        if (chosen === undefined) {
          // Nowhere both clear and unambiguous: the flow is packed tightly
          // enough that every gap beside the anchor reads as belonging to a
          // neighbour. Put the note somewhere clear for now and mark it to be
          // laid out again below — this time with the anchor stated outright,
          // so the packing can open a gap for it rather than squeeze it in.
          chosen = candidates.find(free);
          if (chosen === undefined) chosen = Math.max(base - clearance, CANVAS_TOP_MARGIN);
          needsRoom = true;
        }
        newCard.x = column;
        newCard.y = chosen;
      } else if (typeof newCard.x !== 'number' || typeof newCard.y !== 'number') {
        if (anchorId) {
          const source = draft.cards[anchorId];
          // Sit level with the anchor unless it already has children, in which
          // case stack below the lowest of them
          const siblings = CARD_OUTPUTS
            .reduce((all, output) => all.concat(source[output] || []), [])
            .map(id => draft.cards[id])
            .filter(Boolean);
          newCard.x = (source.x || 0) + this._columnGapAfter(source);
          if (siblings.length) {
            // Stack below the lowest existing child, clearing however tall it is
            const lowest = siblings.reduce((a, b) => ((a.y || 0) > (b.y || 0) ? a : b));
            newCard.y = (lowest.y || 0) + this._siblingGapBelow(lowest);
          } else {
            newCard.y = source.y || 0;
          }
        } else {
          // Unattached: start a new row below everything already placed
          newCard.x = existing.length ? Math.min.apply(null, existing.map(c => c.x || 0)) : 0;
          newCard.y = existing.length
            ? Math.max.apply(null, existing.map(c => c.y || 0)) + CARD_ROW_GAP_Y
            : 0;
        }
        // Never land on top of something already there
        // Never land on top of something already there. Compare against the
        // occupant's own height, since a short card may sit above a tall one.
        let guard = 0;
        while (guard++ < 200) {
          const clash = existing.find(c => c.x === newCard.x
            && Math.abs((c.y || 0) - newCard.y) < this._siblingGapBelow(c));
          if (!clash) break;
          newCard.y = (clash.y || 0) + this._siblingGapBelow(clash);
        }
      }

      draft.cards[cardId] = newCard;

      // Make room. The anchor is passed in explicitly: inferring it from where
      // the note sits would read back the very position that was the problem.
      if (needsRoom && anchorId) {
        this._layoutCards(draft.cards, { [cardId]: anchorId });
        result.relaidOut = 'There was no gap beside that card wide enough for the note to '
          + 'read as belonging to it, so the flow has been laid out again to open one. '
          + 'Other cards will have moved.';
      }

      let linked = null;
      if (anchorId && !isNote) {
        const source = draft.cards[anchorId];
        const chosen = this._resolveOutput(source, opts.output);
        if (chosen.error) return chosen;
        source[chosen.output] = (source[chosen.output] || []).concat([cardId]);
        linked = { from: anchorId, output: chosen.output, requested: opts.output || null };
      }
      result.addedCardId = cardId;
      result.position = { x: newCard.x, y: newCard.y };
      result.linkedFrom = linked;

      // A note's position is the only record of what it labels — Homey stores
      // no anchor — so it can only be placed against where its anchor sits
      // *now*. In a flow that has not been laid out, cards are still stacked in
      // one column, so the note is filed against a meaningless position and
      // relayout later reads it as heading whichever behaviour it happens to
      // sit above. Cheap to detect: an unlaid flow has nearly every card at one x.
      if (isNote && anchorId) {
        const placed = Object.values(draft.cards).filter(c => c && c.type !== 'note');
        const sharing = placed.filter(c => (c.x || 0) === (draft.cards[anchorId].x || 0));
        if (placed.length > 2 && sharing.length > placed.length / 2) {
          // Colour it red. A warning in the result reaches only the assistant
          // that made the call, and the app log is not somewhere anyone looks;
          // the canvas is where this will be noticed, and red already means
          // "needs attention" in flows written here.
          const asked = newCard.color;
          newCard.color = 'red';
          result.colour = { requested: asked, applied: 'red' };
          result.warning = 'This flow does not look laid out yet — most of its cards share '
            + 'one column — so this note has been placed against a position that is about to '
            + 'change, and may end up labelling the wrong section. It has been coloured red to '
            + 'mark it for attention. Run relayout_flow, then delete and re-add this note'
            + (asked && asked !== 'red' ? ' as ' + asked + '.' : '.');
          this.error('Note added to "' + draft.name + '" before the flow was laid out. '
            + 'Coloured red; run relayout_flow, then re-add it.');
        }
      }
      return result;
    });
  }

  // Independent behaviours get their own horizontal band. Laying every card
  // out in shared columns interleaves unrelated logic — four triggers for three
  // behaviours all land in column 0 — and drags long connections across the
  // canvas. Flows written by hand keep each behaviour in its own band.
  _connectedGroups(ids, parents, children) {
    const owner = {};
    const find = id => {
      while (owner[id] !== id) { owner[id] = owner[owner[id]]; id = owner[id]; }
      return id;
    };
    for (const id of ids) owner[id] = id;
    for (const id of ids) {
      for (const other of parents[id].concat(children[id])) {
        const a = find(id);
        const b = find(other);
        if (a !== b) owner[a] = b;
      }
    }
    const groups = new Map();
    for (const id of ids) {
      const root = find(id);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(id);
    }
    return Array.from(groups.values());
  }

  // Where each note should be re-placed, as the card it belongs to and which
  // side of that card it sits on. The association comes from the one shared
  // rule, so a note the summary reports on a card stays on that card.
  _captureNoteAnchors(cards) {
    const { attached, headings, nearest } = this._noteAttachments(cards);
    const anchors = {};
    // Orphans have no card the summary will name, but leaving them where they
    // are would strand them as the cards move out from under them, so they
    // travel with whatever they are nearest.
    const placement = Object.assign({}, nearest, attached);
    for (const [noteId, cardId] of Object.entries(placement)) {
      // A heading names the section beneath it; any other note sits on
      // whichever side of its card it is already on.
      const above = headings.has(noteId)
        || (cards[noteId].y || 0) < (cards[cardId].y || 0);
      anchors[noteId] = { anchor: cardId, dx: 0, dy: above ? -1 : 1 };
    }
    return anchors;
  }

  // Place one column's cards at their preferred positions, clustering those
  // that want the same spot and centring each cluster on it.
  _placeColumn(cards, members, desired, placedY, columnX, reserve) {
    const slotFor = id => (reserve && reserve[id]) || { above: 0, below: 0 };
    members.sort((a, b) => desired[a] - desired[b] || (cards[a].y || 0) - (cards[b].y || 0));

    const clusters = [];
    for (const id of members) {
      const last = clusters[clusters.length - 1];
      if (last && Math.abs(desired[id] - last.desired) < 1) last.ids.push(id);
      else clusters.push({ desired: desired[id], ids: [id] });
    }

    let moved = 0;
    // No floor: a cluster must be free to sit above where the column started,
    // or a parent ends up level with its first child rather than centred on
    // them. The band is shifted into place once it is complete.
    let cursor = -Infinity;
    for (const cluster of clusters) {
      const gaps = cluster.ids.map(id => this._siblingGapBelow(cards[id]));
      // A card's footprint is its own height plus whatever has been set aside
      // for the notes that belong to it, so packing leaves them somewhere to go
      const footprints = cluster.ids.map((id, index) => {
        const slot = slotFor(id);
        return slot.above + gaps[index] + slot.below;
      });
      const extent = footprints.slice(0, -1).reduce((total, size) => total + size, 0);
      let y = Math.round((cluster.desired - (extent / 2)) / 20) * 20;
      if (y < cursor) y = cursor;

      cluster.ids.forEach((id, index) => {
        const card = cards[id];
        const slot = slotFor(id);
        y += slot.above;
        if (card.x !== columnX || card.y !== y) moved += 1;
        card.x = columnX;
        card.y = y;
        placedY[id] = y;
        y += gaps[index] + slot.below;
      });
      cursor = y;
    }
    return { moved, bottom: cursor };
  }

  _layoutGroup(cards, group, parents, children, originX, bandTop, reserve) {
    const inGroup = new Set(group);
    const depth = {};
    const visiting = new Set();
    const depthOf = id => {
      if (depth[id] !== undefined) return depth[id];
      if (visiting.has(id)) return 0;
      visiting.add(id);
      const above = parents[id].filter(p => inGroup.has(p));
      depth[id] = above.length ? Math.max.apply(null, above.map(depthOf)) + 1 : 0;
      visiting.delete(id);
      return depth[id];
    };
    group.forEach(depthOf);

    // A gate renders about a fifth as wide as a card, so a gate and a card at
    // the same depth can sit side by side in the space one card needs. Packed
    // into one column they cannot: a card landing among the gates pushes them
    // apart, and everything feeding them stretches to follow. Splitting them
    // into two lanes lets each pack against its own neighbours. The lanes are
    // numbered so a depth's cards come before its gates, which is the order
    // they are drawn in left to right.
    const laneOf = id => (depth[id] * 2) + (GATE_TYPES.has(cards[id].type) ? 1 : 0);
    const columns = {};
    for (const id of group) (columns[laneOf(id)] = columns[laneOf(id)] || []).push(id);
    const order = Object.keys(columns).map(Number).sort((a, b) => a - b);

    const columnX = {};
    let nextX = originX;
    for (let column = 0; column <= order[order.length - 1]; column++) {
      const members = columns[column];
      if (!members) continue;
      columnX[column] = nextX;
      // A card lane is followed by its gate lane, which needs only the gates'
      // own width; the gap to the next depth is taken from whichever lane
      // reaches furthest right.
      const gap = Math.max.apply(null, members.map(id => this._columnGapAfter(cards[id])));
      nextX += (column % 2 === 0 && columns[column + 1]) ? GATE_LANE_OFFSET : gap;
    }

    const placedY = {};
    let moved = 0;

    // A card sits level with the middle of whatever it connects to. Sweeping
    // left to right settles it against its parents; sweeping back settles it
    // against its children. Doing both matters for fan-outs: a gate placed only
    // by its parents sits well above the cards it feeds, so every connection
    // leaves it at a steep angle and the lines bunch together. Two passes is
    // the usual compromise — more rarely changes anything a reader notices.
    const midpointOf = (id, side) => {
      const neighbours = side[id]
        .filter(other => inGroup.has(other))
        .map(other => placedY[other])
        .filter(value => value !== undefined);
      if (!neighbours.length) return null;
      return (Math.min.apply(null, neighbours) + Math.max.apply(null, neighbours)) / 2;
    };

    const sweep = (sequence, side) => {
      let bottom = bandTop;
      for (const column of sequence) {
        const desired = {};
        for (const id of columns[column]) {
          const target = midpointOf(id, side);
          desired[id] = target === null ? (placedY[id] === undefined ? 0 : placedY[id]) : target;
        }
        const placed = this._placeColumn(cards, columns[column], desired, placedY, columnX[column], reserve);
        moved += placed.moved;
        bottom = Math.max(bottom, placed.bottom);
      }
      return bottom;
    };

    // How far the connectors in this behaviour have to travel vertically.
    // Readability tracks this more closely than crossing count: on these flows
    // the crossings are fixed by the topology, but a gate placed badly leaves
    // every line steep. Lower is flatter is easier to follow.
    const travel = () => {
      let total = 0;
      for (const id of group) {
        for (const child of children[id]) {
          if (!inGroup.has(child)) continue;
          total += Math.abs((placedY[child] || 0) - (placedY[id] || 0));
        }
      }
      return total;
    };
    const snapshot = () => group.map(id => cards[id].y);
    const restore = saved => group.forEach((id, index) => {
      cards[id].y = saved[index];
      placedY[id] = saved[index];
    });

    // Sweeping one way settles each card against its parents, the other way
    // against its children. Neither alone is right, and the useful answer is
    // often a mix: a gate feeding six cards wants to stay beside the two
    // conditions that feed it while those six spread out below — which no
    // single sweep produces, because each re-places a whole column by one rule
    // and so collapses whatever the previous sweep spread out. Running a second
    // sweep over all but the end column keeps that spread while settling
    // everything upstream of it.
    const reversed = order.slice().reverse();
    const allButLast = order.slice(0, -1);
    const allButFirst = reversed.slice(0, -1);
    const candidates = [
      () => sweep(order, parents),
      () => sweep(reversed, children),
      () => { sweep(reversed, children); sweep(allButLast, parents); },
      () => { sweep(order, parents); sweep(allButFirst, children); },
      () => { sweep(reversed, children); sweep(allButLast, parents); sweep(allButFirst, children); },
    ];

    // Each candidate is evaluated from the best layout found so far, not from
    // the positions the flow arrived with, and the round repeats while anything
    // improves. Evaluating once from the starting positions makes the result
    // depend on them: a flow built card by card lands somewhere arbitrary, and
    // a single round from there settles into a worse arrangement than the same
    // flow already tidied — which showed up as a second relayout improving on
    // the first.
    const initial = snapshot();
    restore(initial);
    candidates[0]();
    let best = { y: snapshot(), cost: travel() };

    for (let round = 0; round < LAYOUT_ROUNDS; round++) {
      const start = best.y;
      let improved = false;
      for (const build of candidates) {
        restore(start);
        build();
        const cost = travel();
        if (cost < best.cost) {
          best = { y: snapshot(), cost };
          improved = true;
        }
      }
      if (!improved) break;
    }
    restore(best.y);

    // Slide whole columns. Every column is packed from its own preferred
    // positions, which fixes the spacing inside it but says nothing about
    // where it should sit as a whole — so a column made tall by the cards or
    // notes in it ends up too low for the ones feeding it, and every
    // connector into it runs down the canvas. Moving a column moves all of it
    // at once, so the spacing inside is untouched and no overlap can appear.
    //
    // The useful offsets are the ones that flatten a connector completely, so
    // only those are tried.
    for (let round = 0; round < LAYOUT_ROUNDS; round++) {
      let improved = false;
      for (const column of order) {
        const members = columns[column];
        const offsets = new Set([0]);
        for (const id of members) {
          for (const other of parents[id].concat(children[id])) {
            if (!inGroup.has(other) || laneOf(other) === column) continue;
            offsets.add((placedY[other] || 0) - (placedY[id] || 0));
          }
        }
        let bestOffset = 0;
        let bestCost = travel();
        for (const offset of offsets) {
          if (!offset) continue;
          for (const id of members) placedY[id] = (placedY[id] || 0) + offset;
          const cost = travel();
          for (const id of members) placedY[id] = (placedY[id] || 0) - offset;
          if (cost < bestCost) { bestCost = cost; bestOffset = offset; }
        }
        if (!bestOffset) continue;
        for (const id of members) {
          placedY[id] = (placedY[id] || 0) + bestOffset;
          cards[id].y = placedY[id];
        }
        improved = true;
      }
      if (!improved) break;
    }

    // Slide the finished band into position
    const top = Math.min.apply(null, group.map(id => cards[id].y || 0));
    const shift = bandTop - top;
    for (const id of group) {
      cards[id].y = (cards[id].y || 0) + shift;
      placedY[id] = cards[id].y;
    }

    let bottom = bandTop;
    for (const id of group) {
      const slot = (reserve && reserve[id]) || { above: 0, below: 0 };
      bottom = Math.max(bottom, (cards[id].y || 0) + this._siblingGapBelow(cards[id]) + slot.below);
    }

    return { moved, columns: order.length, bottom, lastColumnX: columnX[order[order.length - 1]] };
  }

  // Which card each note belongs to. There is nothing in the file that says —
  // Homey stores no anchor — so position is the only evidence, and every part
  // of this app that needs the answer has to derive it the same way. It did
  // not used to: the summary measured centre to centre while the layout
  // measured corner to corner, so laying a flow out moved notes to cards the
  // summary had never said they were on.
  //
  // Returns { attached: { noteId: cardId }, headings: Set(noteId),
  // orphans: [noteId], nearest: { noteId: cardId } } — `nearest` is the raw
  // winner with no distance or ambiguity test applied, for the layout, which
  // has to move every note somewhere even when the summary declines to say
  // what it annotates.
  _noteAttachments(cards) {
    const positioned = Object.entries(cards).filter(([, c]) => c && c.type !== 'note');
    const leftEdge = positioned.length
      ? Math.min.apply(null, positioned.map(([, c]) => c.x || 0)) : 0;
    const attached = {};
    const headings = new Set();
    const orphans = [];
    const nearest = {};

    for (const [noteId, note] of Object.entries(cards)) {
      if (!note || note.type !== 'note') continue;

      // Centre to centre. A note's width and height are null — Homey sizes it
      // at render time — so both are estimated, the note's from its text and a
      // card's from its arguments.
      const noteX = (note.x || 0) + (NOTE_WIDTH_ESTIMATE / 2);
      const noteY = (note.y || 0) + (this._noteHeight(note) / 2);

      const ranked = positioned.map(([cardId, card]) => {
        const dx = ((card.x || 0) + (CARD_WIDTH_ESTIMATE / 2)) - noteX;
        const dy = ((card.y || 0) + (this._siblingGapBelow(card) / 2)) - noteY;
        return { cardId, distance: Math.sqrt((dx * dx) + (dy * dy)) };
      }).sort((a, b) => a.distance - b.distance);

      // A note at the left margin heads a section and reads correctly above it;
      // one out in the flow annotates a single card and belongs beneath it.
      const heading = (note.x || 0) <= leftEdge;
      if (heading) headings.add(noteId);

      let chosen = ranked[0];
      const runnerUp = ranked[1];
      const tooFar = !chosen || chosen.distance > NOTE_ATTACH_DISTANCE;
      let ambiguous = runnerUp && (runnerUp.distance - chosen.distance) < NOTE_ATTACH_MARGIN;

      // A heading placed between two sections is equidistant from both, and
      // that happens often — it sits below one section and above the one it
      // names. Direction settles it where distance cannot.
      if (!tooFar && ambiguous && heading) {
        const beneath = ranked.filter(entry => (cards[entry.cardId].y || 0) >= (note.y || 0));
        if (beneath.length && beneath[0].distance <= NOTE_ATTACH_DISTANCE) {
          chosen = beneath[0];
          ambiguous = false;
        }
      }
      if (chosen) nearest[noteId] = chosen.cardId;
      if (tooFar || ambiguous) { orphans.push(noteId); continue; }
      attached[noteId] = chosen.cardId;
    }

    return { attached, headings, orphans, nearest };
  }

  // How much room a stack of notes needs on one side of the card it labels.
  // Not simply their height: get_flow_summary reads a note as belonging to
  // whichever card is nearest centre to centre, so the card on the far side
  // has to be pushed back far enough to lose that comparison — and by more
  // than NOTE_ATTACH_MARGIN, or the summary calls the note ambiguous and
  // files it at flow level instead. Assumes the shortest possible neighbour,
  // since which card lands there is not known until the layout has run.
  _noteStackDepth(cards, cardId, noteIds) {
    if (!noteIds.length) return 0;
    let stack = 0;
    let outermost = 0;
    for (const noteId of noteIds) {
      outermost = this._noteHeight(cards[noteId]);
      stack += outermost + NOTE_ATTACH_GAP;
    }
    const separation = Math.max(NOTE_GAP_ABOVE,
      stack - outermost
        + (this._siblingGapBelow(cards[cardId]) / 2)
        - (CARD_GAP_Y_BARE / 2)
        + NOTE_ATTACH_MARGIN);
    return stack + separation;
  }

  // The same measure the per-behaviour packing minimises, but over the whole
  // flow: how far the connectors have to travel vertically. Used to choose
  // between arrangements the layout will not settle between on its own.
  _flowTravel(cards) {
    let total = 0;
    for (const card of Object.values(cards)) {
      if (!card || card.type === 'note') continue;
      for (const output of CARD_OUTPUTS) {
        for (const childId of (card[output] || [])) {
          const child = cards[childId];
          if (child) total += Math.abs((child.y || 0) - (card.y || 0));
        }
      }
    }
    return total;
  }

  // Cards sharing a column that would render on top of each other. Heights are
  // estimated from the arguments, so the count is too high in absolute terms —
  // it flags hand-drawn layouts that look fine. It is only ever used to compare
  // two arrangements of the same flow, where the same estimate applies to both.
  _overlapCount(cards) {
    const list = Object.values(cards).filter(Boolean);
    const heightOf = card =>
      (card.type === 'note' ? this._noteHeight(card) : this._siblingGapBelow(card));
    // A gate is narrow, so the next column can sit close to it without
    // touching. Measuring every card as one width counted those as overlaps
    // and made a layout that puts gates in their own lane look far worse than
    // it is.
    const widthOf = card =>
      (GATE_TYPES.has(card.type) ? GATE_WIDTH_ESTIMATE : CARD_WIDTH_ESTIMATE);
    let count = 0;
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        if ((list[a].x || 0) >= (list[b].x || 0) + widthOf(list[b])
          || (list[b].x || 0) >= (list[a].x || 0) + widthOf(list[a])) continue;
        if ((list[a].y || 0) < (list[b].y || 0) + heightOf(list[b])
          && (list[b].y || 0) < (list[a].y || 0) + heightOf(list[a])) count++;
      }
    }
    return count;
  }

  // How many notes would not read as belonging to the card they annotate.
  // Zero is the whole point of holding space for them; a note that loses this
  // comparison is reported by get_flow_summary as annotating a neighbour, or
  // as belonging to no card at all.
  // Returns the notes that would read as annotating a different card than the
  // one they arrived on — as a list, not a count, because a bare number tells
  // the caller a note has gone astray without telling them which one to look at.
  _notesMisattached(cards, noteAnchors) {
    const { attached } = this._noteAttachments(cards);
    const wrong = [];
    for (const [noteId, anchor] of Object.entries(noteAnchors)) {
      if (attached[noteId] !== anchor.anchor) {
        wrong.push({ noteId, wanted: anchor.anchor, landedOn: attached[noteId] || null });
      }
    }
    return wrong;
  }

  // Lay out a flow's cards. knownAnchors maps a note id to the card it belongs
  // to, for callers that know the association rather than having to guess it
  // from where the note currently sits.
  //
  // One pass is not enough. Positioning reads the current arrangement — which
  // behaviour sits above which, which card each note belongs to — so its
  // output is a new arrangement that would position differently again. Most
  // flows reach a point where nothing more moves after two passes, a few
  // oscillate between two or three arrangements for ever, and the difference
  // matters because the user runs this by hand and expects a second run to be
  // a no-op. So iterate until an arrangement repeats, and keep the best of
  // everything seen: first by how many notes end up reading as belonging to
  // the card they annotate, then by how far the connectors have to travel.
  // Scoring everything visited rather than taking the last pass is also what
  // settles the flows that cycle, since the same arrangements are visited
  // whichever member of the cycle the flow happens to be sitting on.
  _layoutCards(cards, knownAnchors) {
    const ids = Object.keys(cards).filter(id => cards[id] && cards[id].type !== 'note');
    if (!ids.length) return { error: 'this flow has no cards to lay out' };

    const before = this._copyPositions(cards);
    const key = state => JSON.stringify(Object.keys(state).sort()
      .map(id => [id, state[id].x, state[id].y]));
    const anchorsFor = state => {
      const anchors = this._captureNoteAnchors(state);
      for (const [noteId, anchorId] of Object.entries(knownAnchors || {})) {
        // An anchor the caller states is authoritative: reading it back off the
        // note's position cannot repair a note that is already misplaced,
        // because it reads the same position that misplaced it.
        if (state[noteId] && state[anchorId]) {
          anchors[noteId] = { anchor: anchorId, dx: 0, dy: -1 };
        }
      }
      return anchors;
    };

    // Score an arrangement: cards rendering on top of each other first, since
    // that is a defect anyone can see, then notes that read as annotating the
    // wrong card, then how far the connectors travel.
    //
    // Always against the associations the flow arrived with. Scoring against
    // the ones each step re-read off its own input lets them drift: a note
    // moves a little, the next step reads it as belonging to its new
    // neighbour, and every step after that agrees — so the arrangement scores
    // perfectly while the note now annotates a card the author never put it on.
    const original = anchorsFor(cards);
    const score = state => {
      const astray = this._notesMisattached(state, original);
      const overlaps = this._overlapCount(state);
      return { wrong: astray.length, astray, overlaps,
        defects: astray.length + overlaps, travel: this._flowTravel(state) };
    };
    // Two cards on top of each other and a note that has drifted onto the
    // wrong card are both defects a reader would notice, and neither is worth
    // trading for the other, so they are counted together. Travel only
    // separates arrangements with the same number of defects.
    const better = (a, b) => {
      for (const field of ['defects', 'travel']) {
        if (a[field] !== b[field]) return a[field] < b[field] ? a : b;
      }
      return a.key <= b.key ? a : b;
    };

    // Explore every arrangement reachable from this one, rather than following
    // a single chain to its first repeat. Both matter: which arrangement a
    // chain ends on depends on where it started, so the answer would change
    // from one run to the next — and the flow arrived in one of those
    // arrangements, so the search has to be able to come back to it.
    //
    // Holding space beside annotated cards makes their column taller, and
    // every connector into that column then has to reach further down. Often
    // it buys nothing, because the packing left a big enough gap by itself, so
    // both are tried and scored.
    const seen = new Map();
    let failed = null;
    const add = state => {
      const k = key(state);
      if (seen.has(k)) return null;
      const entry = Object.assign({ key: k, cards: state }, score(state));
      seen.set(k, entry);
      return entry;
    };

    add(this._copyPositions(cards));
    const queue = Array.from(seen.values());
    while (queue.length && seen.size < LAYOUT_MAX_ARRANGEMENTS) {
      const from = queue.shift();
      for (const holdSpace of [true, false]) {
        const anchors = anchorsFor(from.cards);
        const next = this._copyPositions(from.cards);
        const result = this._positionCards(next, anchors, holdSpace);
        if (result && result.error) { failed = result; continue; }
        const entry = add(next);
        if (entry) { entry.result = result; queue.push(entry); }
      }
    }
    if (seen.size <= 1) return failed || { error: 'this flow could not be laid out' };

    const best = Array.from(seen.values()).reduce(better);

    this._adoptPositions(cards, best.cards);
    let moved = 0;
    for (const [id, card] of Object.entries(cards)) {
      if (!before[id]) continue;
      if (card.x !== before[id].x || card.y !== before[id].y) moved++;
    }
    // Name them. A count on its own leaves the reader to find the stray note by
    // eye across a canvas that has just moved wholesale, which is the one moment
    // it is hardest to do.
    const misplaced = best.astray.map(entry => {
      const note = cards[entry.noteId];
      const landedOn = entry.landedOn ? cards[entry.landedOn] : null;
      return {
        noteId: entry.noteId,
        text: String((note && note.value) || '').replace(/\s+/g, ' ').trim(),
        colour: (note && note.color) || null,
        wasBeside: entry.wanted,
        nowReadsAsLabelling: entry.landedOn
          ? this._cardLabel(landedOn, this._cardTitles || {})
          : 'nothing — it is too far from any card, so it now reads as a flow-level note',
      };
    });

    return Object.assign({
      independentBehaviours: null, widestBehaviour: null, notesMoved: null,
    }, best.result, { cardsRepositioned: moved, notesMisplaced: misplaced.length,
      misplacedNotes: misplaced.length ? misplaced : undefined,
      misplacedNotesAdvice: misplaced.length
        ? 'Each of these now sits nearest a different card than before, so get_flow_summary '
          + 'will show it under that one. Move or re-add them with add_flow_note, naming the '
          + 'card each belongs to.'
        : undefined,
      arrangementsTried: seen.size });
  }

  _copyPositions(cards) {
    const copy = {};
    for (const [id, card] of Object.entries(cards)) copy[id] = Object.assign({}, card);
    return copy;
  }

  _adoptPositions(cards, from) {
    for (const [id, card] of Object.entries(from)) {
      if (!cards[id]) continue;
      cards[id].x = card.x;
      cards[id].y = card.y;
    }
  }

  // One pass: position every card and drop the notes into the space held for
  // them, given a fixed idea of which card each note belongs to.
  _positionCards(cards, noteAnchors, holdSpace) {
    const ids = Object.keys(cards).filter(id => cards[id] && cards[id].type !== 'note');
    if (!ids.length) return { error: 'this flow has no cards to lay out' };

    const parents = {};
    const children = {};
    for (const id of ids) { parents[id] = []; children[id] = []; }
    for (const id of ids) {
      for (const output of CARD_OUTPUTS) {
        for (const child of (cards[id][output] || [])) {
          if (parents[child]) { parents[child].push(id); children[id].push(child); }
        }
      }
    }

    const groups = this._connectedGroups(ids, parents, children);
    // Keep the author's top-to-bottom ordering of behaviours
    groups.sort((a, b) =>
      Math.min.apply(null, a.map(id => cards[id].y || 0))
      - Math.min.apply(null, b.map(id => cards[id].y || 0)));

    const originX = Math.min.apply(null, ids.map(id => cards[id].x || 0));
    const originY = Math.min.apply(null, ids.map(id => cards[id].y || 0));
    // Finish with the flow's topmost element clear of the canvas controls.
    // Preserving wherever it currently starts would keep any drift it has
    // already accumulated, and the origin carries no meaning of its own.
    const topBefore = CANVAS_TOP_MARGIN;

    // Set aside room beside each annotated card before anything is placed.
    // Notes were previously squeezed in afterwards, which works only where
    // the layout happens to have left a gap — and a note with nowhere to go
    // ends up nearer some other card, so it reads as annotating that one.
    const reserve = {};
    for (const [noteId, anchor] of Object.entries(noteAnchors)) {
      const slot = reserve[anchor.anchor]
        || (reserve[anchor.anchor] = { above: 0, below: 0, aboveNotes: [], belowNotes: [] });
      if (anchor.dy <= 0) slot.aboveNotes.push(noteId);
      else slot.belowNotes.push(noteId);
    }
    // Holding space costs connector travel — a column carrying three notes is
    // several hundred pixels taller, and everything feeding it drops to reach
    // it. Worth paying only where the packing would not have left a big enough
    // gap anyway, which is not knowable until the flow is laid out, so both
    // are tried and the better one kept.
    for (const [cardId, slot] of Object.entries(reserve)) {
      slot.above = holdSpace ? this._noteStackDepth(cards, cardId, slot.aboveNotes) : 0;
      slot.below = holdSpace ? this._noteStackDepth(cards, cardId, slot.belowNotes) : 0;
    }

    let moved = 0;
    let widest = 0;
    let bandTop = originY;
    const laidOut = [];
    for (const group of groups) {
      const laid = this._layoutGroup(cards, group, parents, children, originX, bandTop, reserve);
      laidOut.push({ group, laid });
      moved += laid.moved;
      widest = Math.max(widest, laid.columns);
      bandTop = laid.bottom + CARD_BAND_GAP_Y;
    }

    // Right-align the last column of every behaviour. Bands end at different
    // depths, so their final cards otherwise land a little apart — close
    // enough to read as a mistake rather than a choice.
    const finalX = Math.max.apply(null, laidOut.map(entry => entry.laid.lastColumnX));
    for (const entry of laidOut) {
      if (entry.laid.lastColumnX === finalX) continue;
      for (const id of entry.group) {
        if (cards[id].x === entry.laid.lastColumnX) cards[id].x = finalX;
      }
    }

    // Drop each note into the space held for it, stacking where a card has
    // more than one. Its position is then guaranteed to be the gap belonging
    // to that card, which is what makes it read as annotating it.
    for (const [cardId, slot] of Object.entries(reserve)) {
      const target = cards[cardId];
      if (!target) continue;

      let y = (target.y || 0) - NOTE_ATTACH_GAP;
      for (const noteId of slot.aboveNotes.slice().reverse()) {
        y -= this._noteHeight(cards[noteId]);
        cards[noteId].x = target.x || 0;
        cards[noteId].y = y;
        y -= NOTE_ATTACH_GAP;
      }
      let below = (target.y || 0) + this._siblingGapBelow(target) + NOTE_ATTACH_GAP;
      for (const noteId of slot.belowNotes) {
        cards[noteId].x = target.x || 0;
        cards[noteId].y = below;
        below += this._noteHeight(cards[noteId]) + NOTE_ATTACH_GAP;
      }
    }

    const topAfter = Math.min.apply(null, Object.values(cards).map(card => card.y || 0));
    const correction = topBefore - topAfter;
    if (correction !== 0) {
      for (const card of Object.values(cards)) card.y = (card.y || 0) + correction;
    }

    return {
      cardsRepositioned: moved,
      independentBehaviours: groups.length,
      widestBehaviour: widest,
      notesMoved: Object.keys(noteAnchors).length
    };
  }

  async relayoutFlow(flowId) {
    return this._mutateAdvancedFlow(flowId, 'repositioned the cards',
      draft => this._layoutCards(draft.cards));
  }

  async createAdvancedFlow(name, folder, options) {
    const opts = options || {};
    if (!this._writesEnabled()) {
      return { error: 'Editing is turned off. Enable "Allow AI assistants to edit flows" in the app settings first.' };
    }
    if (!name || typeof name !== 'string' || !name.trim()) return { error: 'name is required' };

    // Homey rejects a flow with no cards ("Advanced Flow is empty, add at least
    // one Flow card"), so by default seed a start card: the minimal valid flow,
    // and one that cannot fire on its own. It is a real card, though, and it
    // stays on the canvas until something removes it — which surprises anyone
    // who asked for an empty flow — so it can now be declined. Created disabled
    // either way.
    // Homey refuses to create a flow with no cards at all — "Advanced Flow is
    // empty, add at least one Flow card" — so declining the placeholder only
    // makes sense when the caller is supplying the real cards in the same call.
    const withStartCard = opts.withStartCard !== false;
    if (!withStartCard) {
      return { error: 'Homey will not create a flow with no cards ("Advanced Flow is empty, '
        + 'add at least one Flow card"), so withStartCard: false is only possible when the '
        + 'flow is created with its real cards. Either leave the placeholder in and remove it '
        + 'once the flow has a trigger, or build the flow with apply_cards / copy_cards.' };
    }
    const startCardId = withStartCard ? crypto.randomUUID() : null;
    const body = {
      name: name.trim(),
      enabled: false,
      cards: withStartCard
        ? { [startCardId]: { type: 'start', x: 0, y: 0, outputSuccess: [] } }
        : {}
    };
    if (folder) body.folder = folder;

    let created;
    try {
      created = await this._apiRequest('POST', '/manager/flow/advancedflow', body);
    } catch (e) {
      return { error: this._explainWriteFailure(e) };
    }
    const flowId = created && created.id;
    if (flowId) await this._resyncFlow(flowId);
    return {
      ok: true, flowId, flow: body.name, enabled: false, startCardId,
      note: withStartCard
        ? 'Created disabled, containing one placeholder start card — that card is why the '
          + 'flow is not empty. Build it with apply_cards or copy_cards, or add_card one at a '
          + 'time (pass after: startCardId to chain from it), then enable it. Remove the start '
          + 'card once something else triggers the flow.'
        : 'Created disabled and empty. Add cards before anything else reads it: Homey will not '
          + 'hold a flow with no cards, so an empty flow may not survive.'
    };
  }

  async revertFlow(flowId, revision) {
    if (!this._writesEnabled()) {
      return { error: 'Editing is turned off. Enable "Allow AI assistants to edit flows" in the app settings first.' };
    }
    let found;
    try {
      found = await this._readRevision(flowId, revision);
    } catch (e) {
      return { error: 'Could not read that revision: ' + e.message };
    }
    if (!found) return { error: 'No revision ' + (revision || 1) + ' stored for flow ' + flowId };

    // Going through the normal write path means the current state is itself
    // saved first, so a revert can be undone
    return this._mutateAdvancedFlow(flowId, 'reverted to the revision saved at ' + found.entry.ts, draft => {
      for (const field of ADVANCED_FLOW_WRITABLE) {
        if (found.flow[field] !== undefined) draft[field] = found.flow[field];
      }
      return { revertedTo: found.entry.ts, nameAtSave: found.entry.name };
    });
  }

  async addFlowNote(flowId, text, nearCardId, colour) {
    if (!text || !String(text).trim()) return { error: 'text is required — a note with no words says nothing' };
    return this.addCard(flowId, {
      type: 'note',
      value: String(text).trim(),
      color: colour || 'yellow',
    }, nearCardId);
  }

  async updateFlowNote(flowId, noteCardId, text) {
    if (!text || !String(text).trim()) return { error: 'text is required' };
    return this._mutateAdvancedFlow(flowId, 'rewrote a note', draft => {
      const found = this._resolveCardId(draft.cards, noteCardId);
      if (found.error) return found;
      const card = draft.cards[found.cardId];
      // A note's text is `value`, a top-level field, so update_card_args cannot
      // reach it — which is why this tool exists rather than reusing that one.
      if (card.type !== 'note') {
        return { error: 'Card ' + found.cardId + ' is a ' + card.type + ' card, not a note. '
          + 'Use update_card_args to change a card\'s arguments.' };
      }
      const before = card.value;
      const heightBefore = this._noteHeight(card);
      card.value = String(text).trim();

      // A note grows and shrinks with its text, from its top edge, so its
      // centre moves — and the centre is what decides which card it reads as
      // annotating. Shortening a note was enough, on its own, to hand it to
      // the card above. Keep the centre where the author put it.
      const drift = (heightBefore - this._noteHeight(card)) / 2;
      if (drift) card.y = (card.y || 0) + drift;

      return { noteCardId: found.cardId, textBefore: before, textAfter: card.value,
        movedBy: drift || undefined };
    });
  }

  async setFlowFolder(flowId, folderId) {
    const folders = await this._fetchFolderNames();
    if (folderId && !folders[folderId]) {
      return { error: 'No folder with id ' + folderId + '. Call list_folders to see them.' };
    }
    const where = folderId ? 'folder "' + folders[folderId] + '"' : 'no folder';
    return this._mutateAdvancedFlow(flowId, 'moved to ' + where, draft => {
      draft.folder = folderId || null;
      return { folder: folderId || null, folderName: folderId ? folders[folderId] : null };
    });
  }

  // ─── Tracing behaviour across flows ──────────────────────────────────────────

  // The cross-reference index is already a bipartite graph — flows on one side,
  // the things they touch on the other — it has simply never been walked.
  async _behaviourGraph() {
    const xref = await this.getCachedCrossReferences();
    const entities = new Map();
    const flows = new Map();

    const flowNode = (flowId, flowName) => {
      if (!flows.has(flowId)) {
        const meta = (this.snapshot.flows || {})[flowId];
        flows.set(flowId, {
          id: flowId,
          name: (meta && meta.name) || flowName || flowId,
          enabled: meta ? meta.enabled : true,
          links: [],
        });
      }
      return flows.get(flowId);
    };

    for (const [bucket, kind] of Object.entries(TRACEABLE_BUCKETS)) {
      for (const [key, entry] of Object.entries(xref[bucket] || {})) {
        if (!entry || !entry.flows) continue;
        const id = bucket + '::' + key;
        const node = {
          id, kind,
          label: entry.name || key,
          zone: entry.zone || null,
          links: [],
        };
        entities.set(id, node);

        for (const [flowId, use] of Object.entries(entry.flows)) {
          const flow = flowNode(flowId, use.flowName);
          const roles = use.roles || [];
          const produces = roles.some(role => PRODUCING_ROLES.has(role));
          const consumes = roles.some(role => CONSUMING_ROLES.has(role));
          node.links.push({ flow: flow.id, roles, produces, consumes });
          flow.links.push({ entity: id, roles, produces, consumes });
        }
      }
    }

    // Flows that start other flows programmatically are a direct edge
    for (const [flowId, entry] of Object.entries(xref.flow_triggers || {})) {
      const flow = flowNode(flowId, entry.flowName);
      for (const [callerId, caller] of Object.entries(entry.calledBy || {})) {
        flowNode(callerId, caller.flowName).starts = (flowNode(callerId, caller.flowName).starts || []).concat([flowId]);
        flow.startedBy = (flow.startedBy || []).concat([callerId]);
      }
    }

    return { entities, flows };
  }

  _resolveTraceTarget(query, graph) {
    const needle = String(query || '').trim().toLowerCase();
    if (!needle) return { error: 'target is required' };

    const matches = [];
    for (const node of graph.entities.values()) {
      const label = String(node.label).toLowerCase();
      if (label === needle) matches.unshift({ node, exact: true });
      else if (label.includes(needle)) matches.push({ node, exact: false });
    }
    for (const flow of graph.flows.values()) {
      const name = String(flow.name).toLowerCase();
      if (name === needle) matches.unshift({ flow, exact: true });
      else if (name.includes(needle)) matches.push({ flow, exact: false });
    }

    if (!matches.length) return { error: 'Nothing called "' + query + '" appears in any flow.' };
    const exact = matches.filter(m => m.exact);
    if (exact.length === 1) return exact[0];
    if (matches.length === 1) return matches[0];

    const pool = exact.length ? exact : matches;
    if (pool.length === 1) return pool[0];
    return {
      error: '"' + query + '" matches ' + pool.length + ' things; name one exactly.',
      candidates: pool.slice(0, 12).map(m => m.flow
        ? 'flow "' + m.flow.name + '"'
        : graph.entities.get(m.node.id).kind + ' "' + m.node.label + '"'),
    };
  }

  async traceBehaviour(target, depth, direction) {
    const graph = await this._behaviourGraph();
    const found = this._resolveTraceTarget(target, graph);
    if (found.error) return found;

    const maxDepth = Math.min(Math.max(parseInt(depth, 10) || TRACE_DEFAULT_DEPTH, 1), 6);
    const want = direction === 'upstream' || direction === 'downstream' ? [direction] : ['downstream', 'upstream'];

    const describeEntity = node => node.kind + ' "' + node.label + '"' + (node.zone ? ' [' + node.zone + ']' : '');
    const describeFlow = flow => 'flow "' + flow.name + '"' + (flow.enabled === false ? ' (disabled)' : '');
    // Roles read better after the thing they apply to: "flow X — checks", not
    // "checks by flow X"
    const withRoles = (text, roles) => (roles && roles.length)
      ? text + '  — ' + roles.map(role => role.replace(/_/g, ' ')).join(', ')
      : text;

    const out = [];
    out.push('Trace: ' + (found.flow ? describeFlow(found.flow) : describeEntity(found.node)));
    out.push('Depth ' + maxDepth + '. Upstream is what changes a thing; downstream is what reacts to it.');

    for (const way of want) {
      out.push('');
      out.push(way === 'downstream' ? 'DOWNSTREAM — what this affects' : 'UPSTREAM — what affects this');
      const seen = new Set();
      const lines = [];

      // From an entity, step to the flows on the matching side of it; from a
      // flow, step to the entities it touches on that side. The two alternate.
      const walkEntity = (node, level, prefix) => {
        const key = 'e:' + node.id;
        if (seen.has(key)) { lines.push('  '.repeat(level) + withRoles(describeEntity(node), prefix) + '  (shown above)'); return; }
        seen.add(key);
        lines.push('  '.repeat(level) + withRoles(describeEntity(node), prefix));
        if (level >= maxDepth) return;
        for (const link of node.links) {
          const relevant = way === 'downstream' ? link.consumes : link.produces;
          if (!relevant) continue;
          const flow = graph.flows.get(link.flow);
          if (flow) walkFlow(flow, level + 1, link.roles);
        }
      };

      const walkFlow = (flow, level, prefix) => {
        const key = 'f:' + flow.id;
        if (seen.has(key)) { lines.push('  '.repeat(level) + withRoles(describeFlow(flow), prefix) + '  (shown above)'); return; }
        seen.add(key);
        lines.push('  '.repeat(level) + withRoles(describeFlow(flow), prefix));
        if (level >= maxDepth) return;
        for (const link of flow.links) {
          const relevant = way === 'downstream' ? link.produces : link.consumes;
          if (!relevant) continue;
          const node = graph.entities.get(link.entity);
          if (node) walkEntity(node, level + 1, link.roles);
        }
        const chained = way === 'downstream' ? (flow.starts || []) : (flow.startedBy || []);
        for (const otherId of chained) {
          const other = graph.flows.get(otherId);
          if (other) walkFlow(other, level + 1, [way === 'downstream' ? 'starts' : 'started by']);
        }
      };

      if (found.flow) walkFlow(found.flow, 0, []);
      else walkEntity(found.node, 0, []);

      out.push(...(lines.length > 1 ? lines.slice(1) : ['  (nothing)']));
    }

    return out.join('\n');
  }

  // ─── Flow summaries and search ───────────────────────────────────────────────

  // Homey registers every flow card with a human title. Resolving card ids this
  // way turns "homey:manager:presence:user_athome" into "Someone is at home",
  // which is the difference between a readable summary and UUID soup.
  // Titles are kept per card type. Card ids are only unique within a type —
  // "on" is both a condition ("Is turned on") and an action ("Turn on") — so a
  // single flat map hands actions their condition's wording.
  async _fetchFlowCardTitles() {
    if (this._cardTitles) return this._cardTitles;
    const titles = { trigger: {}, condition: {}, action: {}, any: {} };
    const probe = {};
    const titleOf = t => (typeof t === 'string' ? t : (t && (t.en || Object.values(t)[0])) || null);
    const put = (map, key, text) => { if (key && text && !map[key]) map[key] = text; };

    for (const [type, path] of Object.entries(FLOW_CARD_PATHS)) {
      try {
        const data = await this._apiGet(path);
        const entries = Object.entries(data || {});
        let added = 0;
        for (const [key, card] of entries) {
          const text = titleOf(card && card.title);
          if (!text) continue;
          put(titles[type], key, text);
          if (card.uri && card.id) put(titles[type], card.uri + ':' + card.id, text);
          if (card.id) put(titles[type], card.id, text);
          put(titles.any, key, text);
          added++;
        }
        probe[path] = { ok: true, entries: entries.length, titled: added };
      } catch (e) {
        probe[path] = { ok: false, error: e.message };
      }
    }

    try {
      const apps = await this.getAppActions();
      const group = { triggers: 'trigger', conditions: 'condition', actions: 'action' };
      for (const app of Object.values(apps || {})) {
        for (const [key, type] of Object.entries(group)) {
          for (const [cardId, text] of Object.entries(app[key] || {})) {
            put(titles[type], cardId, text);
            put(titles.any, cardId, text);
          }
        }
      }
      probe.appManifests = { ok: true, apps: Object.keys(apps || {}).length };
    } catch (e) {
      probe.appManifests = { ok: false, error: e.message };
    }

    this._cardTitleProbe = probe;
    this._cardTitles = titles;
    this.log('Flow card titles resolved:', Object.keys(titles.any).length);
    return titles;
  }

  // Homey titles carry inversion markup, e.g. "Is turned !{{on|off}}" and
  // "A user !{{is|is not}} at home" — the second option applies to an
  // inverted card.
  _renderTitleTemplate(text, inverted) {
    return String(text)
      .replace(/!\{\{([^|}]*)\|([^}]*)\}\}/g, (m, plain, negated) => (inverted ? negated : plain))
      .replace(/\{\{([^|}]*)\|([^}]*)\}\}/g, (m, a, b) => (inverted ? b : a))
      .trim();
  }

  _lookupCardTitle(card, titles) {
    const id = String(card.id || '');
    const byType = titles[card.type] || {};
    const bare = id.split(':').pop();
    const found = byType[id] || byType[bare] || titles.any[id];
    return found ? this._renderTitleTemplate(found, card.inverted) : null;
  }

  async _fetchFolderNames() {
    if (this._folderNames) return this._folderNames;
    const names = {};
    this._folderProbe = {};
    for (const path of FLOW_FOLDER_PATHS) {
      try {
        const data = await this._apiGet(path);
        for (const [id, folder] of Object.entries(data || {})) {
          if (folder && folder.name) names[id] = folder.name;
        }
        this._folderProbe[path] = { ok: true, folders: Object.keys(data || {}).length };
        if (Object.keys(names).length) break;
      } catch (e) {
        this._folderProbe[path] = { ok: false, error: e.message };
      }
    }
    this._folderNames = names;
    return names;
  }

  // Replace token references with readable placeholders, e.g. {Outside temp}
  _resolveTokens(text) {
    return String(text)
      .replace(/\[\[homey:manager:logic\|([a-f0-9-]{36})\]\]/g, (m, id) => {
        const v = (this.snapshot.variables || {})[id];
        return '{' + (v ? v.name : 'unknown variable') + '}';
      })
      .replace(/\[\[homey:device:([a-f0-9-]{36})\|([^\]]+)\]\]/g, (m, id, cap) => {
        const d = (this.snapshot.devices || {})[id];
        return '{' + (d ? d.name : 'unknown device') + '.' + cap + '}';
      })
      .replace(/\[\[trigger::[a-f0-9-]{36}::([\w-]+)\]\]/g, '{trigger.$1}')
      .replace(/\[\[action::[a-f0-9-]{36}::([\w-]+)\]\]/g, '{action.$1}');
  }

  _argSummary(args) {
    const parts = [];
    for (const [key, value] of Object.entries(args || {})) {
      let out;
      if (value && typeof value === 'object') {
        const dev = value.id && (this.snapshot.devices || {})[value.id];
        const variable = value.id && (this.snapshot.variables || {})[value.id];
        out = dev ? dev.name : variable ? variable.name : (value.name || value.id || JSON.stringify(value));
      } else {
        out = String(value);
      }
      out = this._resolveTokens(out).replace(/\s+/g, ' ').trim();
      if (out.length > 70) out = out.slice(0, 67) + '...';
      if (out) parts.push(key + '=' + out);
    }
    return parts.join(', ');
  }

  // Delay args are { number, multiplier }, where the multiplier converts to
  // seconds. Rendering the raw object says nothing a reader can use.
  _delaySummary(args) {
    const delay = args && args.delay;
    if (!delay || delay.number === undefined) return this._argSummary(args || {});
    const seconds = Number(delay.number) * Number(delay.multiplier || 1);
    if (!Number.isFinite(seconds)) return this._argSummary(args);
    const unit = (value, name) => value + ' ' + name + (value === 1 ? '' : 's');
    if (seconds >= 3600 && seconds % 3600 === 0) return unit(seconds / 3600, 'hour');
    if (seconds >= 60 && seconds % 60 === 0) return unit(seconds / 60, 'minute');
    return unit(seconds, 'second');
  }

  _cardLabel(card, titles) {
    if (card.type === 'all')   return 'ALL of:';
    if (card.type === 'any')   return 'ANY of:';
    if (card.type === 'start') return 'WHEN started by another flow';
    if (card.type === 'delay') return 'DELAY ' + this._delaySummary(card.args);

    const id = String(card.id || '');
    const title = this._lookupCardTitle(card, titles);
    let subject = null;
    let name = title;

    const dev = id.match(/^homey:device:([a-f0-9-]{36}):(.+)$/);
    const zoneCard = id.match(/^homey:zone:([a-f0-9-]{36}):(.+)$/);
    if (dev) {
      const meta = (this.snapshot.devices || {})[dev[1]];
      const zone = meta && (this.snapshot.zones || {})[meta.zone];
      subject = (meta ? meta.name : 'unknown device') + (zone ? ' [' + zone.name + ']' : '');
      name = title || dev[2];
    } else if (zoneCard) {
      const zone = (this.snapshot.zones || {})[zoneCard[1]];
      subject = zone ? zone.name : 'unknown zone';
      name = title || zoneCard[2];
    } else if (!title) {
      name = id.split(':').pop() || id;
    }

    const kind = card.type === 'trigger' ? 'WHEN'
      : card.type === 'condition' ? (card.inverted ? 'IF NOT' : 'IF')
      : 'THEN';
    const args = this._argSummary(card.args || {});
    const token = card.droptoken ? this._resolveTokens('[[' + card.droptoken + ']]') : null;
    // Where the card names no subject the droptoken is its left operand, so it
    // belongs in front of the verb: "IF {Shortfall} is greater than" rather than
    // "IF is greater than on {Shortfall}". Device and zone cards already lead
    // with their subject, so there the token follows the title.
    const parts = subject
      ? [kind, subject + ' -', name, token ? 'on ' + token : null]
      : [kind, token, name];
    parts.push(args ? '(' + args + ')' : null);
    return parts.filter(Boolean).join(' ');
  }

  // Shortest prefix that still distinguishes every card, so the ids shown are
  // as short as they can be while remaining unambiguous to _resolveCardId.
  _shortIdLength(cards) {
    const ids = Object.keys(cards);
    for (let length = 6; length < 36; length++) {
      if (new Set(ids.map(id => id.slice(0, length))).size === ids.length) return length;
    }
    return 36;
  }

  _renderCardGraph(cards, titles, notes, showIds) {
    const referenced = new Set();
    const OUTPUTS = [['outputTrue', 'TRUE:'], ['outputFalse', 'FALSE:'],
                     ['outputSuccess', ''], ['outputError', 'ERROR:']];
    for (const card of Object.values(cards)) {
      for (const [key] of OUTPUTS) for (const id of (card[key] || [])) referenced.add(id);
    }
    const roots = Object.entries(cards)
      .filter(([id, c]) => c.type !== 'note' && !referenced.has(id))
      .sort((a, b) => (a[1].y || 0) - (b[1].y || 0) || (a[1].x || 0) - (b[1].x || 0));

    // Anchor each note to the nearest card on the canvas. Notes are placed three
    // ways: as a section header at the left margin above its section, as a label
    // directly above a card, and as a label directly below one — on branching
    // layouts the note for the upper branch sits under it. Measuring from the
    // note's rectangle rather than its corner treats all three the same, so no
    // directional assumption is needed.
    const { attached, headings, orphans } = this._noteAttachments(cards);
    const noteLabel = noteId => (showIds
      ? noteId.slice(0, this._shortIdLength(cards)) + ' ' : '')
      + '# ' + String(cards[noteId].value).replace(/\s+/g, ' ').trim();

    const notesByCard = new Map();
    for (const [noteId, cardId] of Object.entries(attached)) {
      if (!notesByCard.has(cardId)) notesByCard.set(cardId, { above: [], below: [] });
      notesByCard.get(cardId)[headings.has(noteId) ? 'above' : 'below'].push(noteLabel(noteId));
    }
    const orphanNotes = orphans.map(noteLabel);

    // Cards reached from more than one place get a stable marker, so a
    // cross-reference points at one specific card rather than at a label that
    // may occur many times in the same flow.
    const inDegree = {};
    for (const card of Object.values(cards)) {
      for (const [key] of OUTPUTS) {
        for (const id of (card[key] || [])) inDegree[id] = (inDegree[id] || 0) + 1;
      }
    }

    const idLength = showIds ? this._shortIdLength(cards) : 0;
    // Lines that are not a card still need to sit in the same column as those
    // that are, or the tree structure stops being legible
    const gutter = showIds ? ' '.repeat(idLength + 2) : '';
    const lines = [];
    const rendered = new Map();
    let marker = 0;
    const walk = (id, depth, branch) => {
      const card = cards[id];
      const pad = '  '.repeat(depth);
      if (!card) { lines.push(gutter + pad + (branch ? branch + ' ' : '') + '[missing card]'); return; }
      const head = pad + (branch ? branch + ' ' : '');
      if (rendered.has(id)) {
        const at = rendered.get(id);
        lines.push(gutter + head + (at
          ? '-> continues at [' + at + ']'
          : '-> continues at "' + this._cardLabel(card, titles) + '" above'));
        return;
      }
      let tag = '';
      if ((inDegree[id] || 0) > 1) {
        marker += 1;
        rendered.set(id, marker);
        tag = '[' + marker + '] ';
      } else {
        rendered.set(id, null);
      }
      const attached = notesByCard.get(id) || { above: [], below: [] };
      for (const note of attached.above) lines.push(gutter + pad + note);
      const idPrefix = showIds ? id.slice(0, idLength) + '  ' : '';
      lines.push(idPrefix + head + tag + this._cardLabel(card, titles));
      for (const note of attached.below) lines.push(gutter + pad + '  ' + note);
      for (const [key, label] of OUTPUTS) {
        const children = card[key] || [];
        if (!children.length) continue;
        if (label) {
          // Name the branch once rather than repeating it on every child
          lines.push(gutter + '  '.repeat(depth + 1) + label);
          for (const child of children) walk(child, depth + 2, '');
        } else {
          for (const child of children) walk(child, depth + 1, '');
        }
      }
    };
    for (const [id] of roots) { walk(id, 0, ''); lines.push(''); }

    // Notes anchored to cards no tree reaches would otherwise vanish
    const stranded = [];
    for (const [cardId, attached] of notesByCard) {
      if (!rendered.has(cardId)) stranded.push(...attached.above, ...attached.below);
    }
    for (const note of stranded.concat(orphanNotes)) lines.push(note);
    return lines;
  }

  async getFlowSummary(id, options) {
    const meta = (this.snapshot.flows || {})[id];
    if (!meta) return { error: 'Flow ' + id + ' not in snapshot' };
    const titles = await this._fetchFlowCardTitles();
    const folders = await this._fetchFolderNames();
    const cards = meta.cards_snapshot || {};

    const showIds = !!(options && options.withCardIds);
    const out = [];
    out.push('Flow: ' + meta.name);
    const facts = [meta.isAdvanced ? 'advanced' : 'basic'];
    if (!meta.enabled) facts.push('DISABLED');
    if (meta.broken) facts.push('BROKEN');
    if (meta.folder) facts.push('folder: ' + (folders[meta.folder] || meta.folder));
    out.push('(' + facts.join(', ') + ')');

    if (meta.isAdvanced) {
      const notes = Object.values(cards)
        .filter(c => c && c.type === 'note' && c.value)
        .sort((a, b) => (a.y || 0) - (b.y || 0));
      if (notes.length) {
        out.push('', 'Lines beginning # are notes the author wrote on the canvas,');
        out.push('shown above the section they sit over.');
      }
      out.push('');
      if (showIds) {
        out.push('The value before each line is that card\'s id, for use with the editing tools.');
      }
      out.push(...this._renderCardGraph(cards, titles, notes, showIds));
    } else {
      out.push('');
      if (cards.trigger) out.push(this._cardLabel(cards.trigger, titles));
      for (const c of (cards.conditions || [])) out.push('  ' + this._cardLabel(c, titles));
      for (const c of (cards.actions || [])) out.push('  ' + this._cardLabel(c, titles));
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  async searchFlows(query, limit) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return { error: 'query is required' };
    const titles = await this._fetchFlowCardTitles();
    const max = Math.min(limit || 20, 100);
    const results = [];

    for (const [flowId, meta] of Object.entries(this.snapshot.flows || {})) {
      const matches = [];
      if (String(meta.name || '').toLowerCase().includes(q)) matches.push('name: ' + meta.name);

      const snap = meta.cards_snapshot || {};
      const cards = [];
      for (const value of Object.values(snap)) {
        if (Array.isArray(value)) cards.push(...value);
        else if (value && typeof value === 'object') cards.push(value);
      }
      for (const card of cards) {
        if (!card || typeof card !== 'object') continue;
        if (card.type === 'note') {
          const text = String(card.value || '').replace(/\s+/g, ' ').trim();
          if (text.toLowerCase().includes(q)) matches.push('note: ' + text.slice(0, 90));
          continue;
        }
        const label = this._cardLabel(card, titles);
        if (label.toLowerCase().includes(q)) matches.push(label.slice(0, 110));
      }
      if (matches.length) {
        results.push({
          id: flowId, name: meta.name,
          type: meta.isAdvanced ? 'advanced' : 'basic',
          enabled: meta.enabled, broken: meta.broken,
          matches: Array.from(new Set(matches)).slice(0, 5)
        });
      }
    }
    results.sort((a, b) => b.matches.length - a.matches.length || a.name.localeCompare(b.name));
    return { query, matched: results.length, returned: Math.min(results.length, max), results: results.slice(0, max) };
  }

  async getAppActions() {
    const result = {};

    // Collect unique third-party app IDs referenced in flow cards
    const usedAppIds = new Set();
    for (const flowMeta of Object.values(this.snapshot.flows)) {
      for (const card of Object.values(flowMeta.cards_snapshot || {})) {
        const match = (card.id || '').match(/^homey:app:([^:]+):/);
        if (match) usedAppIds.add(match[1]);
      }
    }

    // Get installed app names for display
    let appMeta = {};
    try {
      appMeta = await this._apiGet('/manager/apps/app') || {};
    } catch (e) {
      this.log('getAppActions: could not fetch app names:', e.message);
    }

    // Fetch each app manifest from the Athom store
    for (const appId of usedAppIds) {
      try {
        const data = await this._httpsGet('apps-api.athom.com', `/api/v1/app/${appId}`);
        const flow = (data.liveBuild || {}).flow || {};
        const entry = {
          name: (appMeta[appId] && appMeta[appId].name) || (data.liveBuild && data.liveBuild.name) || appId,
          triggers: {},
          conditions: {},
          actions: {}
        };
        for (const cap of (flow.triggers || [])) {
          entry.triggers[`homey:app:${appId}:${cap.id}`] = (cap.title && cap.title.en) || cap.id;
        }
        for (const cap of (flow.conditions || [])) {
          entry.conditions[`homey:app:${appId}:${cap.id}`] = (cap.title && cap.title.en) || cap.id;
        }
        for (const cap of (flow.actions || [])) {
          entry.actions[`homey:app:${appId}:${cap.id}`] = (cap.title && cap.title.en) || cap.id;
        }
        result[appId] = entry;
      } catch (e) {
        this.log(`Warning: skipping app ${appId} —`, e.message);
      }
    }

    return result;
  }

  async onUninit() {
    if (this._xrefServer) {
      this._xrefServer.close(() => this.log('Cross-reference server stopped'));
    }
    if (this._mcpServer) {
      await this._mcpServer.stop();
      this.log('MCP server stopped');
    }
  }

  // ─── Cross-reference HTTP server ─────────────────────────────────────────────

  async _startMcpServer() {
    const HomeyMcpServer = require('./mcp-server.js');
    this._mcpServer = new HomeyMcpServer(this);
    await this._mcpServer.start(this._mcpPort);
  }

  async _startXrefServer() {
    const port = parseInt(this.homey.settings.get('xref_port'), 10) || 8734;

    this._xrefServer = http.createServer((req, res) => {
      // The viewer's own page POSTs back to /settings and /refresh, so a
      // same-origin Origin is expected here; anything else is not.
      const rejection = this._checkRequest(req, { allowSameOrigin: true });
      if (rejection) {
        this._recordRejection(req, rejection);
        this.log('Viewer request rejected:', rejection);
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden: ' + rejection);
        return;
      }

      if (req.method === 'GET' && req.url === '/onboarding') {
        const mdPath = path.join(__dirname, 'assets', 'homey-docs-companion-onboarding.md');
        let onboardingHtml = '<p>Could not load instructions.</p>';
        try {
          const content = fs.readFileSync(mdPath, 'utf8');

          // ── Extract the three sections ──────────────────────────────────────
          const afterFirstRunPos = content.indexOf('\n## After first run');
          const pastePos = content.indexOf('## Onboarding prompt');
          const startSep = content.indexOf('\n---\n', pastePos);
          const endSep = content.lastIndexOf('\n---\n', afterFirstRunPos > 0 ? afterFirstRunPos : content.length);

          const before = startSep >= 0 ? content.substring(0, startSep) : content;
          const after  = endSep >= 0   ? content.substring(endSep + 5)  : '';

          let promptText = '';
          if (startSep >= 0 && endSep > startSep) {
            let section = content.substring(startSep + 5, endSep).trim();
            const FENCE = '```';
            if (section.startsWith(FENCE)) {
              const nl = section.indexOf('\n');
              if (nl >= 0) section = section.substring(nl + 1);
              if (section.endsWith('\n' + FENCE)) section = section.substring(0, section.length - FENCE.length - 1).trimEnd();
              else if (section.endsWith(FENCE)) section = section.substring(0, section.length - FENCE.length).trimEnd();
            }
            promptText = section;
          }

          // ── Simple markdown → HTML renderer ────────────────────────────────
          const escHtml = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          const inline = s => s
            .replace(/`([^`]+)`/g, (_, c) => '<code>' + escHtml(c) + '</code>')
            .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/\*([^*\n]+)\*/g, '<em>$1</em>');

          function mdToHtml(md) {
            const lines = md.split('\n');
            const out = [];
            let inCode = false, codeLang = '', codeLines = [];
            let inList = false, listType = null, listItems = [];
            const flushList = () => {
              if (!inList) return;
              out.push('<' + listType + '>');
              listItems.forEach(item => out.push('<li>' + inline(item) + '</li>'));
              out.push('</' + listType + '>');
              listItems = []; inList = false; listType = null;
            };
            lines.forEach(line => {
              if (inCode) {
                if (line.trim() === '```') {
                  out.push('<pre><code' + (codeLang ? ' class="lang-' + codeLang + '"' : '') + '>' + codeLines.map(escHtml).join('\n') + '</code></pre>');
                  codeLines = []; codeLang = ''; inCode = false;
                } else codeLines.push(line);
                return;
              }
              const fenceM = line.match(/^```(\w*)$/);
              if (fenceM) { flushList(); inCode = true; codeLang = fenceM[1]; return; }
              if (/^-{3,}$/.test(line.trim())) { flushList(); out.push('<hr>'); return; }
              if (line.startsWith('### ')) { flushList(); out.push('<h3>' + inline(line.slice(4)) + '</h3>'); return; }
              if (line.startsWith('## '))  { flushList(); out.push('<h2>' + inline(line.slice(3)) + '</h2>'); return; }
              if (line.startsWith('# '))   { flushList(); out.push('<h1>' + inline(line.slice(2)) + '</h1>'); return; }
              if (line.startsWith('> '))   { flushList(); out.push('<blockquote>' + inline(line.slice(2)) + '</blockquote>'); return; }
              const olM = line.match(/^\d+\.\s+(.*)/);
              if (olM) { if (!inList || listType !== 'ol') { flushList(); inList = true; listType = 'ol'; } listItems.push(olM[1]); return; }
              const ulM = line.match(/^[-*]\s+(.*)/);
              if (ulM) { if (!inList || listType !== 'ul') { flushList(); inList = true; listType = 'ul'; } listItems.push(ulM[1]); return; }
              if (line.trim() === '') { flushList(); out.push(''); return; }
              flushList();
              out.push('<p>' + inline(line) + '</p>');
            });
            flushList();
            return out.join('\n');
          }

          const promptEscaped = escHtml(promptText).replace(/'/g, '&#39;');
          const promptRaw = promptText.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

          onboardingHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Homey Docs — Getting Started</title>
<style>
  body{max-width:780px;margin:40px auto;padding:0 24px 80px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.7;color:#1a1a1a}
  h1{font-size:22px;margin:32px 0 8px}h2{font-size:17px;margin:28px 0 6px}h3{font-size:15px;margin:20px 0 4px}
  p{margin:10px 0}ul,ol{padding-left:24px;margin:10px 0}li{margin:4px 0}
  code{font-family:'SF Mono','Menlo','Monaco',monospace;font-size:13px;background:#f0efec;padding:2px 5px;border-radius:4px}
  pre{background:#f0efec;border:1px solid #ddd;border-radius:6px;padding:14px 16px;overflow-x:auto;margin:10px 0}
  pre code{background:none;padding:0;font-size:12px;line-height:1.5}
  hr{border:none;border-top:1px solid #ddd;margin:24px 0}
  blockquote{border-left:3px solid #ddd;margin:12px 0;padding:4px 16px;color:#555}
  a{color:#185FA5}strong{font-weight:600}
  .prompt-box{border:2px solid #2d6cdf;border-radius:10px;margin:28px 0;overflow:hidden}
  .prompt-header{background:#2d6cdf;color:#fff;display:flex;align-items:center;gap:12px;padding:10px 16px}
  .prompt-header span{font-size:14px;font-weight:600;flex:1}
  .prompt-header button{padding:5px 14px;font-size:12px;font-weight:500;border:1.5px solid rgba(255,255,255,0.5);border-radius:6px;background:rgba(255,255,255,0.15);color:#fff;cursor:pointer;transition:background 0.12s}
  .prompt-header button:hover{background:rgba(255,255,255,0.3)}
  .prompt-text{background:#f7f9ff;margin:0;border-radius:0;border:none;padding:20px;font-size:13px;line-height:1.6;white-space:pre-wrap;word-break:break-word}
  @media(prefers-color-scheme:dark){
    body{background:#1c1c1c;color:#e8e8e8}code{background:#2e2e2e}
    pre{background:#2e2e2e;border-color:#444}hr{border-color:#444}
    blockquote{border-color:#555;color:#aaa}a{color:#B5D4F4}
    .prompt-box{border-color:#4a8af4}
    .prompt-header{background:#1e55c0}
    .prompt-text{background:#1a2540}
  }
</style>
</head>
<body>
${mdToHtml(before)}
<div class="prompt-box">
  <div class="prompt-header">
    <span>AI Prompt &mdash; paste this into your AI assistant</span>
    <button onclick="copyPrompt()">Copy</button>
  </div>
  <pre class="prompt-text">${promptEscaped}</pre>
</div>
${mdToHtml(after)}
<script>
function copyPrompt(){
  const text=${JSON.stringify(promptText)};
  const btn=document.querySelector('.prompt-header button');
  if(navigator.clipboard&&window.isSecureContext){
    navigator.clipboard.writeText(text).then(()=>{btn.textContent='Copied!';setTimeout(()=>btn.textContent='Copy',2000)});
  } else {
    const ta=document.createElement('textarea');ta.value=text;ta.style.cssText='position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);ta.focus();ta.select();
    const ok=document.execCommand('copy');document.body.removeChild(ta);
    if(ok){btn.textContent='Copied!';setTimeout(()=>btn.textContent='Copy',2000);}
  }
}
</script>
</body>
</html>`;
        } catch (e) {
          this.error('Failed to render onboarding page:', e.message);
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(onboardingHtml);
        return;
      }

      if (req.method === 'GET' && (req.url === '/onboarding-prompt' || req.url === '/onboarding-prompt-text')) {
        const filePath = path.join(__dirname, 'assets', 'homey-docs-companion-onboarding.md');
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          if (req.url === '/onboarding-prompt-text') {
            // Extract the prompt: everything between the two --- section markers
            // (after "Paste everything between the --- markers" and before "## After first run"),
            // then strip the outer ``` code fence.
            const afterFirstRunPos = content.indexOf('\n## After first run');
            const pastePos = content.indexOf('## Onboarding prompt');
            const startSep = content.indexOf('\n---\n', pastePos);
            const endSep = content.lastIndexOf('\n---\n', afterFirstRunPos > 0 ? afterFirstRunPos : content.length);
            let prompt = content;
            if (startSep >= 0 && endSep > startSep) {
              let section = content.substring(startSep + 5, endSep).trim();
              // Strip surrounding ``` fence
              const FENCE = '```';
              if (section.startsWith(FENCE)) {
                const nl = section.indexOf('\n');
                if (nl >= 0) section = section.substring(nl + 1);
                if (section.endsWith('\n' + FENCE)) section = section.substring(0, section.length - FENCE.length - 1).trimEnd();
                else if (section.endsWith(FENCE)) section = section.substring(0, section.length - FENCE.length).trimEnd();
              }
              prompt = section;
            }
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
            res.end(prompt);
          } else {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
            res.end(content);
          }
        } catch (e) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not found');
        }
        return;
      }

      if (req.method === 'POST' && req.url === '/refresh') {
        // Re-read Homey as well as redrawing — otherwise the button rebuilds the
        // page from cached data and appears to do nothing after a flow changes
        this._refreshSnapshot()
          .then(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
          })
          .catch(err => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: err.message }));
          });
        return;
      }
      if (req.method !== 'GET' || req.url !== '/') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const html = this.homey.settings.get('xref_html');
      if (!html) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('Cross-reference page not yet generated. Trigger "Update cross-reference index" in a flow.');
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache'
      });
      res.end(html);
    });

    this._xrefServer.listen(port, '0.0.0.0', () => {
      this.log(`Cross-reference viewer running at http://[homey-ip]:${port}/`);
    });

    this._xrefServer.on('error', (err) => {
      this.error('Cross-reference HTTP server error:', err);
    });
  }

  async regenerateXrefPage() {
    try {
      const xref = await this.getCrossReferences();
      this._xrefCache = xref;
      const flowTypes = {};
      for (const [id, f] of Object.entries(this.snapshot.flows)) {
        flowTypes[id] = f.isAdvanced ? 'advanced' : 'basic';
      }
      const pageMeta = {
        homeyId: this._homeyId || null,
        baseUrl: this._getXrefBaseUrl(),
        flowTypes,
        mcpPort: this._mcpPort || 8735
      };
      const generatedAt = new Date().toLocaleString('en-GB', {
        day: 'numeric', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
      const html = this._buildXrefHtml(xref, pageMeta, generatedAt);
      this.homey.settings.set('xref_html', html);
      this.log('Cross-reference page regenerated at', generatedAt);
      return { regenerated: true, generatedAt };
    } catch (e) {
      this.error('Failed to regenerate cross-reference page:', e);
      throw e;
    }
  }

  _buildXrefHtml(xref, meta, generatedAt) {
    const template = require('./xref-template.js');
    return template
      .replace('%%DATA%%', JSON.stringify(xref))
      .replace('%%META%%', JSON.stringify(meta))
      .replace('%%GENERATED%%', JSON.stringify(generatedAt));
  }

  // ─── Cross-reference index ───────────────────────────────────────────────────

  // Cheap accessor for callers (public API, MCP tool) that don't need to force
  // a rebuild — reuses whatever regenerateXrefPage() last computed, falling
  // back to a one-off build if the cache hasn't been populated yet (e.g. right
  // after a restart that skipped regeneration because xref_html already existed).
  async getCachedCrossReferences() {
    if (!this._xrefCache) {
      this._xrefCache = await this.getCrossReferences();
    }
    return this._xrefCache;
  }

  async getCrossReferences() {
    const result = {
      devices: {},
      variables: {},
      bll_variables: {},
      timers: {},          // Chronograph; FlowBits timers live in flowbits_timers
      flow_triggers: {},
      trigger_tokens: {}   // otherwise created lazily by _processDroptoken
    };
    // One bucket per FlowBits family, built from the same table the extractor
    // dispatches on, so the two cannot drift apart
    for (const family of FLOWBITS_FAMILIES) result[family.bucket] = {};

    const { getBllVariables } = require('./bll-client.js');
    const bllVariables = await getBllVariables(this);
    const bllVarNames = new Set(bllVariables.map(v => v.name));

    for (const [flowId, flowMeta] of Object.entries(this.snapshot.flows)) {
      const cards = flowMeta.cards_snapshot;
      if (!cards) continue;
      for (const val of Object.values(cards)) {
        // Advanced flows: flat dict of card objects
        // Basic flows: { trigger: {...}, conditions: [...], actions: [...] }
        if (Array.isArray(val)) {
          for (const card of val) {
            this._extractCardReferences(result, flowId, flowMeta.name, card, bllVarNames);
          }
        } else {
          this._extractCardReferences(result, flowId, flowMeta.name, val, bllVarNames);
        }
      }
    }

    // Enrich native variables with type from snapshot
    for (const [varId, varMeta] of Object.entries(this.snapshot.variables || {})) {
      if (result.variables[varId]) {
        result.variables[varId].type = varMeta.type;
      }
    }

    // Add all BLL variables (including unreferenced ones) to their own section
    for (const bllVar of bllVariables) {
      if (!result.bll_variables[bllVar.name]) {
        result.bll_variables[bllVar.name] = { name: bllVar.name, type: bllVar.type, flows: {} };
      } else {
        result.bll_variables[bllVar.name].type = bllVar.type;
      }
    }

    return result;
  }

  _extractCardReferences(result, flowId, flowName, card, bllVarNames) {
    if (!card || typeof card !== 'object' || Array.isArray(card)) return;
    const owner = card.ownerUri || '';
    if (owner === 'homey:manager:logic') {
      this._extractVariableRef(result, flowId, flowName, card);
    } else if (owner === 'homey:app:com.basmilius.flowbits') {
      this._extractFlowBitsRef(result, flowId, flowName, card);
    } else if (owner === 'homey:app:nl.fellownet.chronograph') {
      this._extractTimerRef(result, flowId, flowName, card);
    } else if (owner === 'homey:manager:flow') {
      this._extractFlowTriggerRef(result, flowId, flowName, card);
    }
    // Device references are owner-based, arg-based or token-based rather than
    // namespaced like the above, so this runs for every card
    this._extractDeviceRef(result, flowId, flowName, card);
    // Generic token scan — catches [[...]] patterns in any card, any namespace
    this._extractTokenRefs(result, flowId, flowName, card);
    // BLL variable detection — always run; coding expression scan is skipped internally if bllVarNames is empty
    this._extractBllRefs(result, flowId, flowName, card, bllVarNames);
  }

  // Devices appear three ways: as a capability card, as a `device` argument on
  // an app card, and as a capability token read into another card's arguments.
  //
  // For capability cards the card id is authoritative — homey:device:<id>:<cap>.
  // ownerUri carries a device uuid too and usually agrees, but it can be stale:
  // on this codebase's reference Homey it disagreed on 21 cards and pointed at
  // two devices that no longer exist, while every card id resolved. A further
  // 15 cards carry a device card id with no device ownerUri at all.
  _extractDeviceRef(result, flowId, flowName, card) {
    const args = card.args || {};
    let deviceId = null;
    let capability = null;

    const idMatch = String(card.id || '').match(/^homey:device:([a-f0-9-]{36}):(.+)$/);
    if (idMatch) {
      deviceId = idMatch[1];
      capability = idMatch[2];
    } else if (args.device && args.device.id && (this.snapshot.devices || {})[args.device.id]) {
      // Some apps use this argument for their own targets rather than Homey
      // devices — Pushover's is a notification destination literally named
      // "iPhone" — so only accept ids that resolve to a real device
      deviceId = args.device.id;
    }
    if (!deviceId) return;

    const role = card.type === 'action' ? 'controls'
      : card.type === 'condition' ? 'checks'
      : card.type === 'trigger' ? 'triggers_on'
      : null;
    if (!role) return;

    this._addDeviceRef(result, deviceId, capability, flowId, flowName, role);
  }

  _addDeviceRef(result, deviceId, capability, flowId, flowName, role) {
    if (!result.devices[deviceId]) {
      const meta = (this.snapshot.devices || {})[deviceId];
      const zone = meta && (this.snapshot.zones || {})[meta.zone];
      result.devices[deviceId] = {
        name: meta ? meta.name : deviceId,
        zone: zone ? zone.name : null,
        // Referenced by a flow but absent from Homey — a deleted device whose
        // cards were left behind. Worth surfacing rather than hiding.
        missing: !meta,
        capabilities: [],
        flows: {}
      };
    }
    const entry = result.devices[deviceId];
    if (capability && !entry.capabilities.includes(capability)) entry.capabilities.push(capability);

    if (!entry.flows[flowId]) entry.flows[flowId] = { flowName, roles: [], capabilities: [] };
    const flow = entry.flows[flowId];
    if (!flow.roles.includes(role)) flow.roles.push(role);
    if (capability && !flow.capabilities.includes(capability)) flow.capabilities.push(capability);
  }

  _addFlowRole(entry, flowId, flowName, role) {
    if (!entry.flows[flowId]) {
      entry.flows[flowId] = { flowName, roles: [] };
    }
    if (!entry.flows[flowId].roles.includes(role)) {
      entry.flows[flowId].roles.push(role);
    }
  }

  _addVariableRef(result, varId, flowId, flowName, role) {
    const varMeta = (this.snapshot.variables || {})[varId];
    const name = varMeta ? varMeta.name : varId;
    if (!result.variables[varId]) {
      result.variables[varId] = { name, flows: {} };
    }
    if (!result.variables[varId].flows[flowId]) {
      result.variables[varId].flows[flowId] = { flowName, roles: [] };
    }
    if (!result.variables[varId].flows[flowId].roles.includes(role)) {
      result.variables[varId].flows[flowId].roles.push(role);
    }
  }

  _extractTokenRefs(result, flowId, flowName, card) {
    // Pattern 1 & 2: droptoken field on the card itself
    if (card.droptoken && typeof card.droptoken === 'string') {
      this._processDroptoken(result, flowId, flowName, card.droptoken, 'checks');
    }
    // Pattern 3 & 4: [[...]] interpolations inside any string arg value
    this._scanArgsForTokens(result, flowId, flowName, card.args || {});
  }

  _processDroptoken(result, flowId, flowName, droptoken, role) {
    // Pattern 1: homey:manager:logic|UUID
    const logicMatch = droptoken.match(/^homey:manager:logic\|([a-f0-9-]{36})$/);
    if (logicMatch) {
      this._addVariableRef(result, logicMatch[1], flowId, flowName, role);
      return;
    }
    // Device capability token, e.g. homey:device:<uuid>|measure_luminance
    const deviceMatch = droptoken.match(/^homey:device:([a-f0-9-]{36})\|(.+)$/);
    if (deviceMatch) {
      this._addDeviceRef(result, deviceMatch[1], deviceMatch[2], flowId, flowName, role);
      return;
    }
    // Pattern 2: trigger::CARD_UUID::TOKEN_NAME
    const triggerMatch = droptoken.match(/^trigger::([a-f0-9-]{36})::(\w+)$/);
    if (triggerMatch) {
      const tokenKey = `${triggerMatch[1]}::${triggerMatch[2]}`;
      if (!result.trigger_tokens) result.trigger_tokens = {};
      if (!result.trigger_tokens[tokenKey]) {
        result.trigger_tokens[tokenKey] = { cardId: triggerMatch[1], tokenName: triggerMatch[2], flows: {} };
      }
      this._addFlowRole(result.trigger_tokens[tokenKey], flowId, flowName, role);
    }
  }

  _scanArgsForTokens(result, flowId, flowName, obj) {
    if (typeof obj === 'string') {
      for (const match of obj.matchAll(/\[\[homey:manager:logic\|([a-f0-9-]{36})\]\]/g)) {
        this._addVariableRef(result, match[1], flowId, flowName, 'reads');
      }
      for (const match of obj.matchAll(/\[\[homey:device:([a-f0-9-]{36})\|([^\]]+)\]\]/g)) {
        this._addDeviceRef(result, match[1], match[2], flowId, flowName, 'reads');
      }
      for (const match of obj.matchAll(/\[\[trigger::([a-f0-9-]{36})::(\w+)\]\]/g)) {
        this._processDroptoken(result, flowId, flowName, `trigger::${match[1]}::${match[2]}`, 'reads');
      }
      return;
    }
    if (Array.isArray(obj)) {
      for (const item of obj) this._scanArgsForTokens(result, flowId, flowName, item);
      return;
    }
    if (obj !== null && typeof obj === 'object') {
      for (const val of Object.values(obj)) this._scanArgsForTokens(result, flowId, flowName, val);
    }
  }

  _extractVariableRef(result, flowId, flowName, card) {
    const cardId = card.id || '';
    const args = card.args || {};
    const cardType = card.type;

    let varId = null;
    let varName = null;

    if (args.variable && args.variable.id) {
      varId = args.variable.id;
      varName = args.variable.name || varId;
    }

    if (!varId) return;

    if (!result.variables[varId]) {
      result.variables[varId] = { name: varName, flows: {} };
    }

    let role;
    if (cardId.includes('variable_set_')) {
      role = 'writes';
    } else if (cardId.includes('variable_changed')) {
      role = 'triggers_on';
    } else if (cardType === 'condition') {
      role = 'checks';
    } else if (cardType === 'action') {
      role = 'writes';
    } else if (cardType === 'trigger') {
      role = 'triggers_on';
    }

    if (role) this._addFlowRole(result.variables[varId], flowId, flowName, role);
  }

  _extractFlowBitsRef(result, flowId, flowName, card) {
    const suffix = (card.id || '').split(':').pop();
    const family = FLOWBITS_FAMILIES.find(f => suffix.startsWith(f.prefix));
    if (!family) return;

    const args = card.args || {};
    const keyArg = args[family.keyArg];
    const keyName = keyArg && keyArg.name;
    if (!keyName) return;   // card references no specific entity

    const spec = family[card.type];
    const role = typeof spec === 'function' ? spec(suffix) : spec;
    if (!role) return;

    if (family.memberField) {
      const memberArg = args[family.memberArg];
      this._addGroupedRef(
        result[family.bucket], keyName, memberArg && memberArg.name,
        family.memberField, flowId, flowName, role
      );
      return;
    }

    if (!result[family.bucket][keyName]) result[family.bucket][keyName] = { flows: {} };
    this._addFlowRole(result[family.bucket][keyName], flowId, flowName, role);
  }

  // Two-level entities: a set and its states, a mode group and its modes. The
  // member is recorded both on the entry and per-flow, so the viewer can show
  // which states a given flow actually touches.
  _addGroupedRef(bucket, keyName, member, memberField, flowId, flowName, role) {
    if (!bucket[keyName]) bucket[keyName] = { [memberField]: [], flows: {} };
    const entry = bucket[keyName];
    if (member && !entry[memberField].includes(member)) entry[memberField].push(member);

    if (!entry.flows[flowId]) entry.flows[flowId] = { flowName, roles: [], [memberField]: [] };
    const flow = entry.flows[flowId];
    if (!flow.roles.includes(role)) flow.roles.push(role);
    if (member && !flow[memberField].includes(member)) flow[memberField].push(member);
  }

  _extractTimerRef(result, flowId, flowName, card) {
    const cardId = card.id || '';
    const args = card.args || {};
    const cardType = card.type;
    const timerName = args.namedd && args.namedd.name ? args.namedd.name : null;
    if (!timerName) return;

    if (!result.timers[timerName]) result.timers[timerName] = { flows: {} };

    const suffix = cardId.split(':').pop();
    let role;
    if (suffix === 'timer_start_v2' || suffix === 'timer_start') role = 'starts';
    else if (suffix === 'timer_stop') role = 'stops';
    else if (suffix === 'timer_running') role = 'checks';
    else if (suffix === 'timer_finished') role = 'triggered_by';
    else if (cardType === 'trigger') role = 'triggered_by';
    else if (cardType === 'condition') role = 'checks';
    else if (cardType === 'action') role = suffix.includes('stop') ? 'stops' : 'starts';

    if (role) this._addFlowRole(result.timers[timerName], flowId, flowName, role);
  }

  _extractFlowTriggerRef(result, flowId, flowName, card) {
    const cardId = card.id || '';
    const args = card.args || {};

    if (cardId.includes('programmatic_trigger') || cardId.includes('run_flow') || cardId.includes('trigger_flow')) {
      if (args.flow) {
        // Action card: this flow triggers another flow
        const targetFlow = args.flow;
        const targetId = typeof targetFlow === 'string' ? targetFlow : targetFlow.id;
        if (!targetId) return;
        const targetName = typeof targetFlow === 'object' && targetFlow.name ? targetFlow.name : targetId;
        if (!result.flow_triggers[targetId]) {
          result.flow_triggers[targetId] = { flowName: targetName, calledBy: {}, starts: {} };
        }
        result.flow_triggers[targetId].calledBy[flowId] = { flowName, roles: ['started_by'] };
        if (!result.flow_triggers[flowId]) {
          result.flow_triggers[flowId] = { flowName, calledBy: {}, starts: {} };
        }
        result.flow_triggers[flowId].starts[targetId] = { flowName: targetName, roles: ['starts'] };
      } else {
        // Trigger card: this flow can be triggered by another flow
        if (!result.flow_triggers[flowId]) {
          result.flow_triggers[flowId] = { flowName, calledBy: {}, starts: {} };
        }
      }
    }
  }

  _addBllVariableRef(result, varName, flowId, flowName, role, detail) {
    if (!result.bll_variables[varName]) {
      result.bll_variables[varName] = { name: varName, flows: {} };
    }
    if (!result.bll_variables[varName].flows[flowId]) {
      result.bll_variables[varName].flows[flowId] = { flowName, roles: [] };
    }
    if (!result.bll_variables[varName].flows[flowId].roles.includes(role)) {
      result.bll_variables[varName].flows[flowId].roles.push(role);
    }
    if (detail && !result.bll_variables[varName].flows[flowId].detail) {
      result.bll_variables[varName].flows[flowId].detail = detail;
    }
  }

  _extractBllRefs(result, flowId, flowName, card, bllVarNames) {
    const cardUri = card.uri || card.ownerUri || card.id || '';

    // Direct BLL card references (trigger/condition/action cards from the BLL app)
    if (cardUri.includes('net.i-dev.betterlogic')) {
      const args = card.args || {};
      // Collect variable name(s) from args — BLL may use objects, strings, or comma-separated lists
      const rawNames = [];
      for (const key of ['variable', 'variable2', 'target', 'targetVariable', 'source', 'sourceVariable']) {
        const val = args[key];
        if (val && typeof val === 'object' && val.name) rawNames.push(val.name);
        else if (typeof val === 'string' && val) rawNames.push(val);
      }
      if (args.variableName) rawNames.push(args.variableName);

      // Derive role from card type — same semantics as native variable roles
      const role = card.type === 'trigger' ? 'triggers_on'
                 : card.type === 'condition' ? 'checks'
                 : 'writes';
      // Some BLL cards store multiple variable names as a comma-separated string — split and emit each
      for (const raw of rawNames) {
        const names = raw.includes(',') ? raw.split(',').map(s => s.trim()).filter(Boolean) : [raw];
        for (const name of names) {
          this._addBllVariableRef(result, name, flowId, flowName, role);
        }
      }
    }

    // BLL coding expressions `{[ ... ]}` — only scan when we have variable names to match against
    if (bllVarNames && bllVarNames.size > 0) {
      this._scanArgsForBllExpressions(result, flowId, flowName, cardUri, card.args || {}, bllVarNames, null);
    }
  }

  _scanArgsForBllExpressions(result, flowId, flowName, cardUri, obj, bllVarNames, argKey) {
    if (typeof obj === 'string') {
      const BLL_EXPR_RE = /\{\[\s*([\s\S]+?)\s*\]\}/g;
      for (const match of obj.matchAll(BLL_EXPR_RE)) {
        const expression = match[1];
        for (const varName of bllVarNames) {
          const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const re = new RegExp('(?<![\\w])' + escaped + '(?![\\w])');
          if (re.test(expression)) {
            this._addBllVariableRef(result, varName, flowId, flowName, 'bll_coding', {
              cardUri,
              argKey,
              expression,
            });
          }
        }
      }
      return;
    }
    if (Array.isArray(obj)) {
      for (const item of obj) {
        this._scanArgsForBllExpressions(result, flowId, flowName, cardUri, item, bllVarNames, argKey);
      }
      return;
    }
    if (obj !== null && typeof obj === 'object') {
      for (const [key, val] of Object.entries(obj)) {
        this._scanArgsForBllExpressions(result, flowId, flowName, cardUri, val, bllVarNames, key);
      }
    }
  }

  getVariables() { return this.snapshot.variables; }
  getDevices() { return this.snapshot.devices; }
  getZones() { return this.snapshot.zones; }

  async resetSnapshot() {
    this.snapshot = { flows: {}, variables: {}, devices: {}, zones: {}, initialised_at: null };
    this.homey.settings.set('snapshot', this.snapshot);
    await this._refreshSnapshot();
    return { reset: true, flows: Object.keys(this.snapshot.flows).length, devices: Object.keys(this.snapshot.devices).length };
  }

  async getDiagnostics() {
    const result = { errors: [] };
    // First, because this is what identifies the build answering the call. A
    // client that connected before a restart keeps serving whatever tool list
    // it cached then — in the 27 Sep session Claude Desktop presented
    // get_changelog and list_folders while search_flows and get_flow_summary
    // were missing, and only a restart fixed it. Comparing the tools listed
    // here against the ones the client is offering identifies that at once.
    result.appVersion = this.appVersion();
    result.startedAt = this._startedAt || null;
    result.mcpPort = this._mcpPort || null;
    result.tools = this._mcpServer ? this._mcpServer.toolNames() : 'MCP server not running';
    result.toolCount = Array.isArray(result.tools) ? result.tools.length : 0;
    result.mcp = this._mcpServer ? this._mcpServer.recentCalls() : null;
    result.writesQueued = this._flowWrites ? this._flowWrites.size : 0;
    result.replayableRequestIds = this._requests ? this._requests.size : 0;
    result.localUrl = this._baseUrl || 'not set';
    result.tokenOk = typeof this._token === 'string' && this._token.length > 0;
    result.snapshot = {
      flows: Object.keys(this.snapshot.flows).length,
      devices: Object.keys(this.snapshot.devices).length,
      variables: Object.keys(this.snapshot.variables).length,
      zones: Object.keys(this.snapshot.zones).length,
      initialised_at: this.snapshot.initialised_at
    };
    result.advancedFlowPath = this._advancedFlowPath;
    result.allowedHosts = this._allowedHosts();
    result.tokenScopes = this._tokenScopes();
    result.writeTokenConfigured = !!this._writeToken();
    for (const [label, path] of [['session', '/manager/sessions/session/me']]) {
      try {
        const data = await this._apiGet(path);
        // Never echo anything token-shaped back out
        result[label] = JSON.parse(JSON.stringify(data, (key, value) =>
          /token|secret|password|key/i.test(key) ? '[redacted]' : value));
      } catch (e) {
        result[label + 'Error'] = e.message;
      }
    }
    result.recentlyRejected = this._rejections || [];
    await this._fetchFlowCardTitles();
    result.cardTitles = {
      count: Object.keys((this._cardTitles || {}).any || {}).length,
      probe: this._cardTitleProbe || null
    };
    result.folderNames = {
      count: Object.keys(await this._fetchFolderNames()).length,
      probe: this._folderProbe || null
    };
    result.appDir = __dirname;

    try {
      const apps = await this._apiGet('/manager/apps/app');
      result.appsApiCount = Object.keys(apps || {}).length;
    } catch (e) {
      result.appsApiError = e.message;
    }

    // Probe advanced flow paths
    result.advancedFlowProbe = {};
    for (const path of ADVANCED_FLOW_PATHS) {
      try {
        const data = await this._apiGet(path);
        result.advancedFlowProbe[path] = { ok: true, count: Object.keys(data || {}).length };
      } catch (e) {
        result.advancedFlowProbe[path] = { ok: false, error: e.message };
      }
    }

    return result;
  }
}

module.exports = HomeyDocsCompanion;
