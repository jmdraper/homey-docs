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
const CARD_GAP_X = 440;
const CARD_GAP_Y = 100;
const CARD_GAP_Y_MAX = 360;
const CARD_ROW_GAP_Y = 260;

const CARD_TYPES = new Set(['trigger', 'condition', 'action', 'all', 'any', 'delay', 'note', 'start']);
const CARD_OUTPUTS = ['outputTrue', 'outputFalse', 'outputSuccess', 'outputError'];

// Pre-edit copies live on disk; app settings hold only the index. Ten revisions
// of a 213-card flow is far too much to keep in settings alongside the snapshot.
const REVISION_DIR = '/userdata/revisions';
const DEFAULT_REVISION_DEPTH = 10;

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
    this.log('Homey Docs Companion initialising...');

    this.snapshot = this.homey.settings.get('snapshot') || {
      flows: {}, variables: {}, devices: {}, apps: {}, zones: {},
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

  _appMeta(app) {
    return { name: app.name, version: app.version, enabled: app.enabled !== false, crashed: app.crashed || false };
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
      devices: this.snapshot.devices, apps: this.snapshot.apps, zones: this.snapshot.zones
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

    const runnable = Object.values(cards)
      .some(card => card && (card.type === 'trigger' || card.type === 'start'));
    if (!runnable) problems.push('flow has no trigger or start card, so it could never run');

    return problems;
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

  // Every write goes through here: gate, read the live flow, keep a copy,
  // mutate a draft, validate, PUT, then bring our own caches back in line.
  // Reading live rather than from the snapshot matters — the snapshot can be
  // five minutes old, and writing from it would silently revert a change made
  // in the flow editor in the meantime.
  async _mutateAdvancedFlow(flowId, describe, mutate) {
    if (!this._writesEnabled()) {
      return { error: 'Editing is turned off. Enable "Allow AI assistants to edit flows" in the app settings first.' };
    }
    if (!flowId) return { error: 'flowId is required' };

    let flow;
    try {
      flow = await this._apiGet('/manager/flow/advancedflow/' + flowId);
    } catch (e) {
      return { error: 'Could not read flow ' + flowId + ': ' + e.message };
    }
    if (!flow || !flow.cards) {
      return { error: 'Flow ' + flowId + ' is not an advanced flow (only advanced flows can be edited)' };
    }

    const revision = await this._saveRevision(flowId, flow);

    const draft = JSON.parse(JSON.stringify(flow));
    let outcome;
    try {
      outcome = await mutate(draft);
    } catch (e) {
      return { error: 'Edit failed: ' + e.message };
    }
    if (outcome && outcome.error) return outcome;

    const problems = this._validateCards(draft.cards);
    if (problems.length) {
      return { error: 'Refusing to write — the result would be a broken flow', problems };
    }

    const body = {};
    for (const field of ADVANCED_FLOW_WRITABLE) {
      if (draft[field] !== undefined) body[field] = draft[field];
    }

    try {
      await this._apiRequest('PUT', '/manager/flow/advancedflow/' + flowId, body);
    } catch (e) {
      return { error: this._explainWriteFailure(e) };
    }

    await this._resyncFlow(flowId);
    return Object.assign({
      ok: true,
      flowId,
      flow: draft.name,
      changed: describe,
      revisionSaved: revision.ts,
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
      this._xrefCache = null;
      await this.regenerateXrefPage();
    } catch (e) {
      this.error('Post-write resync failed (the write succeeded):', e.message);
    }
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
      const links = Array.isArray(card[output]) ? card[output] : [];
      if (join) {
        if (!links.includes(to.cardId)) links.push(to.cardId);
      } else {
        const index = links.indexOf(to.cardId);
        if (index === -1) return { error: 'those cards are not connected on ' + output };
        links.splice(index, 1);
      }
      card[output] = links;
      return { from: from.cardId, output, to: to.cardId, connected: join };
    });
  }

  // How far below a card the next sibling should sit, given how tall it will
  // render. Argument length is the only signal available before rendering.
  _siblingGapBelow(card) {
    let text = '';
    try { text = JSON.stringify(card.args || {}); } catch (e) { text = ''; }
    if (text.length <= 200) return CARD_GAP_Y;
    const extra = Math.ceil((text.length - 200) / 100) * 60;
    return Math.min(CARD_GAP_Y + extra, CARD_GAP_Y_MAX);
  }

  async addCard(flowId, card, after) {
    if (!card || typeof card !== 'object') return { error: 'card must be an object' };
    if (!CARD_TYPES.has(card.type)) {
      return { error: 'card.type must be one of ' + Array.from(CARD_TYPES).join(', ') };
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

      let anchorId = null;
      if (after) {
        const anchor = this._resolveCardId(draft.cards, after);
        if (anchor.error) return anchor;
        anchorId = anchor.cardId;
      }

      if (typeof newCard.x !== 'number' || typeof newCard.y !== 'number') {
        if (anchorId) {
          const source = draft.cards[anchorId];
          // Sit level with the anchor unless it already has children, in which
          // case stack below the lowest of them
          const siblings = CARD_OUTPUTS
            .reduce((all, output) => all.concat(source[output] || []), [])
            .map(id => draft.cards[id])
            .filter(Boolean);
          newCard.x = (source.x || 0) + CARD_GAP_X;
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

      let linked = null;
      if (anchorId) {
        const source = draft.cards[anchorId];
        const output = source.type === 'condition' ? 'outputTrue' : 'outputSuccess';
        source[output] = (source[output] || []).concat([cardId]);
        linked = { from: anchorId, output };
      }
      return { addedCardId: cardId, position: { x: newCard.x, y: newCard.y }, linkedFrom: linked };
    });
  }

  async createAdvancedFlow(name, folder) {
    if (!this._writesEnabled()) {
      return { error: 'Editing is turned off. Enable "Allow AI assistants to edit flows" in the app settings first.' };
    }
    if (!name || typeof name !== 'string' || !name.trim()) return { error: 'name is required' };

    // Homey rejects a flow with no cards ("Advanced Flow is empty, add at least
    // one Flow card"), so seed a start card: the minimal valid flow, and one
    // that cannot fire on its own. Created disabled as well.
    const startCardId = crypto.randomUUID();
    const body = {
      name: name.trim(),
      enabled: false,
      cards: { [startCardId]: { type: 'start', x: 0, y: 0, outputSuccess: [] } }
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
      note: 'Created disabled, containing only a start card. Add cards with add_card '
        + '(pass after: startCardId to chain from it), then enable it.'
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
    const positioned = Object.entries(cards).filter(([, c]) => c.type !== 'note');
    const notesByCard = new Map();
    const orphanNotes = [];
    for (const note of (notes || [])) {
      const text = String(note.value).replace(/\s+/g, ' ').trim();
      const left = note.x || 0;
      const top = note.y || 0;
      const right = left + (note.width || 0);
      const bottom = top + (note.height || 0);
      let best = null;
      let bestDistance = Infinity;
      for (const [cardId, card] of positioned) {
        const cx = card.x || 0;
        const cy = card.y || 0;
        // Gap between the card's anchor and the note's rectangle, zero on overlap
        const dx = cx < left ? left - cx : cx > right ? cx - right : 0;
        const dy = cy < top ? top - cy : cy > bottom ? cy - bottom : 0;
        const distance = Math.sqrt(dx * dx + dy * dy);
        if (distance < bestDistance) { bestDistance = distance; best = cardId; }
      }
      if (!best) { orphanNotes.push(text); continue; }
      if (!notesByCard.has(best)) notesByCard.set(best, []);
      notesByCard.get(best).push(text);
    }

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
      for (const note of (notesByCard.get(id) || [])) lines.push(gutter + pad + '# ' + note);
      const idPrefix = showIds ? id.slice(0, idLength) + '  ' : '';
      lines.push(idPrefix + head + tag + this._cardLabel(card, titles));
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
    for (const [cardId, texts] of notesByCard) {
      if (!rendered.has(cardId)) stranded.push(...texts);
    }
    for (const note of stranded.concat(orphanNotes)) lines.push('# ' + note);
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
  getApps() { return this.snapshot.apps; }
  getZones() { return this.snapshot.zones; }

  async resetSnapshot() {
    this.snapshot = { flows: {}, variables: {}, devices: {}, apps: {}, zones: {}, initialised_at: null };
    this.homey.settings.set('snapshot', this.snapshot);
    await this._refreshSnapshot();
    return { reset: true, flows: Object.keys(this.snapshot.flows).length, devices: Object.keys(this.snapshot.devices).length };
  }

  async getDiagnostics() {
    const result = { errors: [] };
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
