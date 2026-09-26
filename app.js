'use strict';

const Homey = require('homey');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

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

    // Cache base URL so it's always current without a settings round-trip
    this._xrefBaseUrl = (this.homey.settings.get('xref_base_url') || 'https://my.homey.app').replace(/\/$/, '');

    // Resolved before the snapshot refresh, which regenerates the xref page and
    // needs the port to render the MCP setup instructions
    this._mcpPort = parseInt(this.homey.settings.get('mcp_port'), 10) || 8735;

    // Discover advanced flow path once and cache it
    this._advancedFlowPath = this.homey.settings.get('advancedFlowPath') || null;

    // The snapshot is a cache, not a record — rebuild it on every start.
    // Non-fatal: a bad refresh must not stop the servers from coming up, or a
    // single malformed card would take the MCP server down with it. The
    // interval below retries.
    try {
      await this._refreshSnapshot();
    } catch (e) {
      this.error('Initial snapshot refresh failed (continuing):', e.message);
    }

    // Keep the cache warm
    this.homey.setInterval(
      () => this._refreshSnapshot().catch(e => this.error('Refresh error:', e.message)),
      REFRESH_INTERVAL_MS
    );

    // Start the cross-reference HTTP server
    await this._startXrefServer();

    // Start the MCP server
    await this._startMcpServer();

    // Register the flow action card
    this.homey.flow
      .getActionCard('regenerate_xref')
      .registerRunListener(async () => {
        await this.regenerateXrefPage();
        return true;
      });

    this.log(`Ready. Tracking ${Object.keys(this.snapshot.flows).length} flows, ${Object.keys(this.snapshot.devices).length} devices.`);
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

  _apiGet(path) {
    const url = `${this._baseUrl}/api${path}`;
    // getLocalUrl() returns http:// or https:// depending on how the app is
    // running — picking the wrong client throws "Protocol not supported"
    const client = url.startsWith('https:') ? https : http;
    return new Promise((resolve, reject) => {
      const req = client.get(url, { headers: { Authorization: `Bearer ${this._token}` } }, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} for ${path}`));
            return;
          }
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error(`JSON parse failed for ${path}`)); }
        });
      });
      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error(`Timeout: ${path}`)); });
    });
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

      if (req.method === 'GET' && req.url === '/settings') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ baseUrl: this._xrefBaseUrl }));
        return;
      }

      if (req.method === 'POST' && req.url === '/settings') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          try {
            const { baseUrl } = JSON.parse(body);
            if (baseUrl && typeof baseUrl === 'string') {
              this._xrefBaseUrl = baseUrl.trim().replace(/\/$/, '');
              this.homey.settings.set('xref_base_url', this._xrefBaseUrl);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, baseUrl: this._xrefBaseUrl }));
          } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
        });
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
        baseUrl: this._xrefBaseUrl || 'https://my.homey.app',
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
    // Generic token scan — catches [[...]] patterns in any card, any namespace
    this._extractTokenRefs(result, flowId, flowName, card);
    // BLL variable detection — always run; coding expression scan is skipped internally if bllVarNames is empty
    this._extractBllRefs(result, flowId, flowName, card, bllVarNames);
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
