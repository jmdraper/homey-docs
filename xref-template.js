'use strict';

module.exports = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Homey cross-reference index</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --bg: #ffffff;
    --bg2: #f7f6f3;
    --bg3: #eeecea;
    --text: #1a1a1a;
    --text2: #555;
    --text3: #888;
    --border: rgba(0,0,0,0.1);
    --border2: rgba(0,0,0,0.18);
    --purple-bg: #EEEDFE; --purple-text: #3C3489;
    --teal-bg: #E1F5EE; --teal-text: #0F6E56;
    --amber-bg: #FAEEDA; --amber-text: #854F0B;
    --blue-bg: #E6F1FB; --blue-text: #185FA5;
    --gray-bg: #F1EFE8; --gray-text: #5F5E5A;
    --coral-bg: #FAECE7; --coral-text: #993C1D;
    --radius: 8px; --radius-lg: 12px;
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #1c1c1c; --bg2: #242424; --bg3: #2e2e2e;
      --text: #e8e8e8; --text2: #aaa; --text3: #666;
      --border: rgba(255,255,255,0.1); --border2: rgba(255,255,255,0.18);
      --purple-bg: #26215C; --purple-text: #CECBF6;
      --teal-bg: #04342C; --teal-text: #9FE1CB;
      --amber-bg: #412402; --amber-text: #FAC775;
      --blue-bg: #042C53; --blue-text: #B5D4F4;
      --gray-bg: #2C2C2A; --gray-text: #D3D1C7;
      --coral-bg: #4A1B0C; --coral-text: #F5C4B3;
    }
  }

  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 15px; line-height: 1.6;
    background: var(--bg); color: var(--text);
    padding: 0;
  }

  header {
    padding: 20px 24px 16px;
    border-bottom: 0.5px solid var(--border2);
    display: flex; align-items: center; gap: 16px;
    flex-wrap: wrap;
    position: sticky; top: 0; z-index: 10;
    background: var(--bg);
  }

  header h1 { font-size: 17px; font-weight: 500; white-space: nowrap; }
  header .updated { font-size: 12px; color: var(--text3); white-space: nowrap; }

  #search {
    flex: 1; min-width: 200px; max-width: 360px;
    padding: 7px 12px; font-size: 14px;
    border: 0.5px solid var(--border2);
    border-radius: var(--radius);
    background: var(--bg2); color: var(--text);
    outline: none;
  }
  #search:focus { border-color: var(--purple-text); }

  .tabs {
    display: flex; gap: 4px; flex-wrap: wrap;
    padding: 12px 24px;
    border-bottom: 0.5px solid var(--border);
    background: var(--bg);
  }

  .tab {
    padding: 5px 14px; font-size: 13px; font-weight: 500;
    border: 0.5px solid var(--border2); border-radius: 999px;
    cursor: pointer; background: var(--bg2); color: var(--text2);
    transition: all 0.12s;
  }
  .tab:hover { background: var(--bg3); color: var(--text); }
  .tab.active { background: var(--purple-bg); color: var(--purple-text); border-color: var(--purple-text); }
  .tab .count { opacity: 0.6; font-weight: 400; margin-left: 4px; }

  main { padding: 20px 24px; }

  .section { display: none; }
  .section.active { display: block; }

  .entry {
    border: 0.5px solid var(--border);
    border-radius: var(--radius-lg);
    margin-bottom: 10px;
    overflow: hidden;
    background: var(--bg);
  }
  .entry.hidden { display: none; }

  .entry-header {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 16px;
    cursor: pointer;
    user-select: none;
  }
  .entry-header:hover { background: var(--bg2); }

  .entry-name { font-weight: 500; font-size: 14px; flex: 1; }
  .type-badge {
    font-size: 11px; font-weight: 500; padding: 2px 8px;
    border-radius: 999px; white-space: nowrap;
  }
  .type-boolean { background: var(--teal-bg); color: var(--teal-text); }
  .type-string  { background: var(--blue-bg);  color: var(--blue-text); }
  .type-number  { background: var(--amber-bg); color: var(--amber-text); }
  .type-trigger { background: var(--gray-bg);  color: var(--gray-text); }

  .source-badge { font-size: 11px; font-weight: 500; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
  .source-bll   { background: var(--coral-bg); color: var(--coral-text); }

  .flow-count {
    font-size: 12px; color: var(--text3);
    white-space: nowrap;
  }

  .chevron {
    font-size: 11px; color: var(--text3);
    transition: transform 0.15s;
    flex-shrink: 0;
  }
  .entry.open .chevron { transform: rotate(90deg); }

  .entry-body {
    display: none;
    border-top: 0.5px solid var(--border);
  }
  .entry.open .entry-body { display: block; }

  .flow-row {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 16px 8px 32px;
    border-bottom: 0.5px solid var(--border);
    font-size: 13px;
  }
  .flow-row:last-child { border-bottom: none; }
  .flow-row:hover { background: var(--bg2); }
  a.flow-row { text-decoration: none; color: inherit; cursor: pointer; }
  a.flow-row:hover .flow-name { color: var(--purple-text); }
  .flow-name { flex: 1; color: var(--text); }

  .roles { display: flex; gap: 5px; flex-wrap: wrap; }
  .role {
    font-size: 11px; padding: 2px 7px; border-radius: 999px;
    font-weight: 500;
  }
  .role-writes      { background: var(--coral-bg); color: var(--coral-text); }
  .role-reads       { background: var(--blue-bg);  color: var(--blue-text); }
  .role-triggers_on { background: var(--purple-bg); color: var(--purple-text); }
  .role-fires       { background: var(--coral-bg); color: var(--coral-text); }
  .role-triggered_by { background: var(--purple-bg); color: var(--purple-text); }
  .role-checks      { background: var(--gray-bg);  color: var(--gray-text); }
  .role-clears      { background: var(--amber-bg); color: var(--amber-text); }
  .role-starts      { background: var(--teal-bg);  color: var(--teal-text); }
  .role-stops       { background: var(--coral-bg); color: var(--coral-text); }
  .role-activates   { background: var(--teal-bg);  color: var(--teal-text); }
  .role-deactivates { background: var(--coral-bg); color: var(--coral-text); }
  .role-started_by  { background: var(--purple-bg); color: var(--purple-text); }
  .role-bll_direct  { background: var(--amber-bg); color: var(--amber-text); }
  .role-bll_coding  { background: var(--teal-bg);  color: var(--teal-text); }

  .group-header {
    font-size: 12px; font-weight: 500; letter-spacing: 0.04em;
    text-transform: uppercase; color: var(--text3);
    padding: 20px 0 8px;
    display: flex; align-items: center; gap: 6px;
    cursor: pointer; user-select: none;
  }
  .group-header:first-child { padding-top: 0; }
  .group-header:hover { color: var(--text2); }
  .group-chevron { font-size: 10px; transition: transform 0.15s; }
  .group-header.collapsed .group-chevron { transform: rotate(-90deg); }
  .group-body.collapsed { display: none; }

  .no-results { color: var(--text3); font-size: 14px; padding: 24px 0; }

  .legend {
    display: flex; gap: 10px; flex-wrap: wrap;
    padding: 10px 24px;
    border-bottom: 0.5px solid var(--border);
    background: var(--bg2);
  }
  .legend-item { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--text2); }

  .hdr-btn {
    padding: 6px 14px; font-size: 13px; font-weight: 500;
    border: 0.5px solid var(--border2); border-radius: var(--radius);
    background: var(--bg2); color: var(--text2);
    cursor: pointer; transition: all 0.12s; white-space: nowrap;
  }
  .hdr-btn:hover:not(:disabled) { background: var(--bg3); color: var(--text); }
  .hdr-btn:disabled { opacity: 0.5; cursor: default; }
  #setup-btn.active { background: var(--blue-bg); color: var(--blue-text); border-color: var(--blue-text); }

  /* Setup accordion panel */
  .setup-panel { display: none; border-bottom: 0.5px solid var(--border); background: var(--bg2); }
  .setup-panel.open { display: block; }

  .accordion-item { border-bottom: 0.5px solid var(--border); }
  .accordion-item:last-child { border-bottom: none; }

  .accordion-header {
    display: flex; align-items: center; gap: 10px;
    padding: 11px 24px; cursor: pointer; user-select: none; color: var(--text2);
  }
  .accordion-header:hover { background: var(--bg3); color: var(--text); }
  .accordion-header.open { color: var(--text); }

  .accordion-num {
    display: inline-flex; align-items: center; justify-content: center;
    width: 20px; height: 20px; border-radius: 50%; flex-shrink: 0;
    background: var(--border); color: var(--text3); font-size: 11px; font-weight: 600;
  }
  .accordion-header.open .accordion-num { background: var(--blue-bg); color: var(--blue-text); }
  .accordion-title { flex: 1; font-size: 13px; font-weight: 500; }
  .accordion-chevron { font-size: 10px; color: var(--text3); transition: transform 0.15s; }
  .accordion-header.open .accordion-chevron { transform: rotate(90deg); color: var(--text2); }

  .accordion-body { display: none; padding: 4px 24px 16px; }
  .accordion-body.open { display: block; }

  .acc-step { font-size: 13px; color: var(--text2); line-height: 1.6; margin-bottom: 12px; }
  .acc-step:last-child { margin-bottom: 0; }
  .acc-step b { color: var(--text); }
  .acc-note { font-size: 11px; color: var(--text3); display: block; margin-top: 3px; }

  .setup-url {
    font-family: 'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace;
    font-size: 12px; background: var(--bg3);
    border: 0.5px solid var(--border2); border-radius: var(--radius);
    padding: 3px 7px; color: var(--text); display: inline-block;
  }
  .code-block {
    font-family: 'SF Mono', 'Menlo', 'Monaco', 'Consolas', monospace;
    font-size: 12px; background: var(--bg3);
    border: 0.5px solid var(--border2); border-radius: var(--radius);
    padding: 10px 12px; margin-top: 6px;
    white-space: pre; overflow-x: auto; color: var(--text);
  }
  .copy-btn {
    margin-top: 6px; padding: 4px 12px; font-size: 12px; font-weight: 500;
    border: 0.5px solid var(--border2); border-radius: var(--radius);
    background: var(--bg); color: var(--text2); cursor: pointer; transition: all 0.12s;
  }
  .copy-btn:hover:not(:disabled) { background: var(--blue-bg); color: var(--blue-text); border-color: var(--blue-text); }
  .copy-btn:disabled { opacity: 0.5; cursor: default; }

  .url-row { display: flex; gap: 10px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
  .url-row input[type="text"] {
    flex: 1; min-width: 220px; max-width: 420px; padding: 6px 10px; font-size: 13px;
    border: 0.5px solid var(--border2); border-radius: var(--radius);
    background: var(--bg); color: var(--text); outline: none;
  }
  .url-row input[type="text"]:focus { border-color: var(--blue-text); }
  .url-row button {
    padding: 6px 14px; font-size: 13px; font-weight: 500;
    border: 0.5px solid var(--border2); border-radius: var(--radius);
    background: var(--bg); color: var(--text2); cursor: pointer; transition: all 0.12s; white-space: nowrap;
  }
  .url-row button:hover:not(:disabled) { background: var(--blue-bg); color: var(--blue-text); border-color: var(--blue-text); }
  .url-row button:disabled { opacity: 0.5; cursor: default; }
</style>
</head>
<body>

<header>
  <h1>Homey cross-reference index</h1>
  <input type="search" id="search" placeholder="Filter by name or flow…" autocomplete="off">
  <span class="updated" id="updated-label"></span>
  <button class="hdr-btn" id="setup-btn">Setup</button>
  <button class="hdr-btn" id="refresh-btn">Refresh</button>
</header>

<div class="setup-panel" id="setup-panel">

  <div class="accordion-item">
    <div class="accordion-header" id="acc1-header">
      <span class="accordion-num">1</span>
      <span class="accordion-title">Connect Claude</span>
      <span class="accordion-chevron">&#x25B6;</span>
    </div>
    <div class="accordion-body" id="acc1-body">
      <div class="acc-step">
        <b>Install mcp-remote</b> on each machine that runs Claude Desktop (one-time):
        <div class="code-block">npm install -g mcp-remote</div>
        <span class="acc-note">On macOS you may need <code>sudo npm install -g mcp-remote</code> if you get a permissions error. On Windows and Linux, try without <code>sudo</code> first.</span>
      </div>
      <div class="acc-step">
        <b>Add to Claude Desktop config</b> and restart Claude Desktop:
        <span class="acc-note">macOS: <code>~/Library/Application Support/Claude/claude_desktop_config.json</code><br>Windows: <code>%APPDATA%\\Claude\\claude_desktop_config.json</code></span>
        <div class="code-block" id="claude-config-block"></div>
        <button class="copy-btn" id="copy-config-btn">Copy</button>
      </div>
      <div class="acc-step">
        <b>Restart Claude Desktop.</b> The Homey tools will appear automatically.
        <span class="acc-note">MCP endpoint: <span class="setup-url" id="mcp-url-display"></span></span>
        <span class="acc-note" style="margin-top:5px">For Claude.ai web: if your Homey is externally accessible, paste the endpoint URL into Settings &rarr; Integrations &rarr; Add custom connector (Pro or Team plan required).</span>
      </div>
    </div>
  </div>

  <div class="accordion-item">
    <div class="accordion-header" id="acc2-header">
      <span class="accordion-num">2</span>
      <span class="accordion-title">Build your Homey docs</span>
      <span class="accordion-chevron">&#x25B6;</span>
    </div>
    <div class="accordion-body" id="acc2-body">
      <div class="acc-step">
        Once Claude is connected, paste the prompt below into your AI assistant. It will guide you through building a living documentation system for your Homey — flows, variables, devices, and automations — that stays up to date as your home evolves.
      </div>
      <div class="acc-step">
        <button class="copy-btn" id="copy-prompt-btn">Copy AI prompt</button>
        &ensp;<a href="/onboarding" target="_blank" style="font-size:13px;color:var(--blue-text);text-decoration:none">View full instructions &#x2197;</a>
      </div>
    </div>
  </div>

  <div class="accordion-item">
    <div class="accordion-header" id="acc3-header">
      <span class="accordion-num">3</span>
      <span class="accordion-title">Custom Homey URL &ensp;<span style="font-size:11px;font-weight:400;color:var(--text3)">(optional)</span></span>
      <span class="accordion-chevron">&#x25B6;</span>
    </div>
    <div class="accordion-body" id="acc3-body">
      <div class="acc-step">
        By default, flow links open in <b>my.homey.app</b>. This step is only needed if you access Homey via a custom domain or the <a href="https://homey.app/en-us/news/introducing-local-users-for-homey-pro/" target="_blank" style="color:var(--blue-text);text-decoration:none">local web interface</a>. Enter your root URL below (without <code>/web</code>) and click Save &amp; Refresh.
      </div>
      <div class="url-row">
        <input type="text" id="base-url-input" placeholder="https://my.homey.app">
        <button id="save-settings-btn">Save &amp; Refresh</button>
      </div>
    </div>
  </div>

</div>

<div class="tabs" id="tabs"></div>

<div class="legend" id="legend"></div>

<main id="main"></main>

<script>
const GENERATED = %%GENERATED%%;
const META = %%META%%;
const DATA = %%DATA%%;

const SECTIONS = [
  { key: 'all',             label: 'All',             icon: '\\uD83D\\uDD0D' },
  { key: 'variables',       label: 'Variables',       icon: '\\uD83D\\uDCCA' },
  { key: 'bll_variables',   label: 'BLL variables',   icon: '\\uD83D\\uDCDA' },
  { key: 'flowbits_events', label: 'FlowBits events', icon: '\\u26A1' },
  { key: 'flowbits_labels', label: 'FlowBits labels', icon: '\\uD83D\\uDCE2' },
  { key: 'timers',          label: 'Timers',          icon: '\\u23F1' },
  { key: 'flow_triggers',   label: 'Flow triggers',   icon: '\\u25B6' },
];

const ROLE_LABELS = {
  writes: 'writes', reads: 'reads', triggers_on: 'triggers on',
  fires: 'fires', triggered_by: 'triggered by', checks: 'checks', clears: 'clears',
  starts: 'starts', stops: 'stops', activates: 'activates', deactivates: 'deactivates', calls: 'calls',
  started_by: 'started by',
  bll_coding: 'BLL coding'
};

const ROLE_TOOLTIPS = {
  reads:        'Variable value is interpolated into a text string',
  writes:       'Sets this variable\\'s value',
  checks:       'Tests this value as a true/false condition',
  triggers_on:  'A change to this value fires the flow',
  fires:        'Emits this event',
  triggered_by: 'Flow runs when this event or timer fires',
  clears:       'Resets this event\\'s occurred state',
  starts:       'Starts this timer',
  stops:        'Stops this timer',
  activates:    'Activates a state in this set',
  deactivates:  'Deactivates a state in this set',
  calls:        'Programmatically triggers another flow',
  starts:       'Starts a timer or programmatically triggers another flow',
  started_by:   'This flow is programmatically triggered by another flow',
};

document.getElementById('updated-label').textContent = 'Generated ' + GENERATED;

let activeTab = 'all';

const SECTION_LABELS = {
  variables: 'variable', bll_variables: 'BLL variable', flowbits_events: 'event',
  flowbits_labels: 'label', timers: 'timer', flow_triggers: 'trigger'
};

function countEntries(key) {
  if (key === 'all') return SECTIONS.filter(s => s.key !== 'all').reduce((n, s) => n + Object.keys(DATA[s.key] || {}).length, 0);
  return Object.keys(DATA[key] || {}).length;
}

function buildTabs() {
  const el = document.getElementById('tabs');
  SECTIONS.forEach(s => {
    const btn = document.createElement('button');
    btn.className = 'tab' + (s.key === activeTab ? ' active' : '');
    btn.dataset.key = s.key;
    const n = countEntries(s.key);
    btn.innerHTML = s.icon + ' ' + s.label + ' <span class="count">' + n + '</span>';
    btn.addEventListener('click', () => { activeTab = s.key; rebuildUI(); });
    el.appendChild(btn);
  });
}

function buildLegend() {
  const el = document.getElementById('legend');
  const roles = [
    {r:'writes',label:'writes'}, {r:'reads',label:'reads'}, {r:'triggers_on',label:'triggers on'},
    {r:'fires',label:'fires'}, {r:'triggered_by',label:'triggered by'},
    {r:'checks',label:'checks'}, {r:'clears',label:'clears'},
    {r:'starts',label:'starts'}, {r:'stops',label:'stops'}, {r:'started_by',label:'started by'}
  ];
  roles.forEach(({r, label}) => {
    const item = document.createElement('span');
    item.className = 'legend-item';
    const tip = ROLE_TOOLTIPS[r] ? ' data-tooltip="' + ROLE_TOOLTIPS[r] + '"' : '';
    item.innerHTML = '<span class="role role-' + r + '"' + tip + '>' + label + '</span>';
    el.appendChild(item);
  });
}

function makeEntry(name, flows, extraBadge) {
  const flowCount = Object.keys(flows).length;
  const div = document.createElement('div');
  div.className = 'entry';

  const header = document.createElement('div');
  header.className = 'entry-header';
  header.innerHTML =
    '<span class="entry-name">' + esc(name) + '</span>' +
    (extraBadge || '') +
    '<span class="flow-count">' + flowCount + ' flow' + (flowCount !== 1 ? 's' : '') + '</span>' +
    '<span class="chevron">&#x25B6;</span>';

  const body = document.createElement('div');
  body.className = 'entry-body';

  Object.entries(flows).sort((a,b) => a[1].flowName.localeCompare(b[1].flowName)).forEach(([fid, f]) => {
    const url = flowUrl(fid);
    const row = document.createElement(url ? 'a' : 'div');
    row.className = 'flow-row';
    if (url) { row.href = url; row.target = 'homey-flow'; }
    const rolesHtml = (f.roles || []).map(r =>
      '<span class="role role-' + r + '">' + (ROLE_LABELS[r] || r) + '</span>'
    ).join('');
    row.innerHTML = '<span class="flow-name">' + esc(f.flowName) + '</span><span class="roles">' + rolesHtml + '</span>';
    body.appendChild(row);
  });

  header.addEventListener('click', () => div.classList.toggle('open'));
  div.appendChild(header);
  div.appendChild(body);
  return div;
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function flowUrl(flowId) {
  if (!META || !META.homeyId || !META.flowTypes) return null;
  const type = META.flowTypes[flowId];
  if (!type) return null;
  const segment = type === 'advanced' ? 'flows/advanced/' : 'flows/';
  const webPath = META.baseUrl === 'https://my.homey.app' ? '' : '/web';
  return META.baseUrl + webPath + '/homeys/' + META.homeyId + '/' + segment + flowId;
}

function buildSection(key) {
  if (key === 'all') {
    const frag = document.createDocumentFragment();
    SECTIONS.filter(s => s.key !== 'all').forEach(s => {
      const items = buildSectionItems(s.key);
      if (!items.hasChildNodes()) return;
      const h = document.createElement('div');
      h.className = 'group-header';
      h.dataset.groupFor = s.key;
      h.innerHTML = '<span class="group-chevron">&#x25BC;</span>' + s.icon + ' ' + s.label;
      const body = document.createElement('div');
      body.className = 'group-body';
      body.dataset.groupBodyFor = s.key;
      body.appendChild(items);
      h.addEventListener('click', () => {
        const collapsed = h.classList.toggle('collapsed');
        body.classList.toggle('collapsed', collapsed);
      });
      frag.appendChild(h);
      frag.appendChild(body);
    });
    return frag;
  }
  return buildSectionItems(key);
}

function buildSectionItems(key) {
  const frag = document.createDocumentFragment();
  const data = DATA[key] || {};
  const items = Object.entries(data).sort((a,b) => {
    const na = a[1].name || a[1].flowName || a[0];
    const nb = b[1].name || b[1].flowName || b[0];
    return na.localeCompare(nb);
  });

  if (items.length === 0) return frag;

  items.forEach(([id, item]) => {
    let name, flows, badge = '';
    if (key === 'variables' || key === 'bll_variables') {
      name = item.name;
      flows = item.flows;
      badge = item.type ? '<span class="type-badge type-' + item.type + '">' + item.type + '</span>' : '';
    } else if (key === 'flow_triggers') {
      name = item.flowName;
      const calledBy = item.calledBy || {};
      const starts = item.starts || {};
      const combined = {};
      Object.entries(calledBy).forEach(([fid, f]) => { combined[fid] = { ...f, roles: f.roles || [] }; });
      Object.entries(starts).forEach(([fid, f]) => {
        if (combined[fid]) combined[fid] = { ...combined[fid], roles: [...combined[fid].roles, ...(f.roles || [])] };
        else combined[fid] = { ...f, roles: f.roles || [] };
      });
      flows = Object.keys(combined).length > 0 ? combined : { _self: { flowName: '(triggerable, no callers detected)', roles: [] } };
    } else {
      name = id;
      flows = item.flows;
    }
    const entry = makeEntry(name, flows, badge);
    entry.dataset.name = name.toLowerCase();
    entry.dataset.flows = Object.values(flows).map(f => f.flowName).join(' ').toLowerCase();
    entry.dataset.section = key;
    frag.appendChild(entry);
  });
  return frag;
}

function rebuildUI() {
  const tabsEl = document.getElementById('tabs');
  tabsEl.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.key === activeTab);
  });

  const main = document.getElementById('main');
  main.innerHTML = '';
  const sec = document.createElement('div');
  sec.className = 'section active';
  sec.appendChild(buildSection(activeTab));
  main.appendChild(sec);

  applyFilter(document.getElementById('search').value);
}

function applyFilter(q) {
  const term = q.trim().toLowerCase();
  document.querySelectorAll('.entry').forEach(entry => {
    if (!term) { entry.classList.remove('hidden'); return; }
    const match = entry.dataset.name.includes(term) || entry.dataset.flows.includes(term);
    entry.classList.toggle('hidden', !match);
  });

  document.querySelectorAll('.group-header').forEach(h => {
    const key = h.dataset.groupFor;
    const anyVisible = document.querySelector('.entry[data-section="' + key + '"]:not(.hidden)');
    const body = document.querySelector('.group-body[data-group-body-for="' + key + '"]');
    if (!anyVisible) {
      h.style.display = 'none';
    } else {
      h.style.display = '';
      if (term) {
        h.classList.remove('collapsed');
        if (body) body.classList.remove('collapsed');
      }
    }
  });

  const visible = document.querySelectorAll('.entry:not(.hidden)').length;
  let noRes = document.querySelector('.no-results-filter');
  if (visible === 0 && term) {
    if (!noRes) {
      noRes = document.createElement('p');
      noRes.className = 'no-results no-results-filter';
      document.getElementById('main').appendChild(noRes);
    }
    noRes.textContent = 'No matches for "' + q + '"';
  } else if (noRes) {
    noRes.remove();
  }
}

buildTabs();
buildLegend();
rebuildUI();

document.getElementById('search').addEventListener('input', e => applyFilter(e.target.value));

const roleTooltip = document.createElement('div');
roleTooltip.style.cssText = 'position:fixed;display:none;background:var(--text);color:var(--bg);font-size:11px;line-height:1.4;padding:4px 8px;border-radius:4px;pointer-events:none;z-index:1000;white-space:nowrap;';
document.body.appendChild(roleTooltip);

document.addEventListener('mouseover', e => {
  const el = e.target.closest('.role[data-tooltip]');
  if (!el) return;
  roleTooltip.textContent = el.dataset.tooltip;
  roleTooltip.style.display = 'block';
  const r = el.getBoundingClientRect();
  const tw = roleTooltip.offsetWidth;
  roleTooltip.style.left = Math.max(4, r.left + r.width / 2 - tw / 2) + 'px';
  roleTooltip.style.top = (r.top - roleTooltip.offsetHeight - 6) + 'px';
});

document.addEventListener('mouseout', e => {
  if (e.target.closest('.role[data-tooltip]')) roleTooltip.style.display = 'none';
});

// ── Setup panel & accordion ──────────────────────────────────────────────────
const setupBtn = document.getElementById('setup-btn');
const setupPanel = document.getElementById('setup-panel');

setupBtn.addEventListener('click', () => {
  const open = setupPanel.classList.toggle('open');
  setupBtn.classList.toggle('active', open);
});

['acc1', 'acc2', 'acc3'].forEach(id => {
  const header = document.getElementById(id + '-header');
  const body   = document.getElementById(id + '-body');
  header.addEventListener('click', () => {
    const opening = !header.classList.contains('open');
    header.classList.toggle('open', opening);
    body.classList.toggle('open', opening);
  });
});

// Step 1: MCP config
const mcpUrl = 'http://' + window.location.hostname + ':' + (META.mcpPort || 8735) + '/mcp';
document.getElementById('mcp-url-display').textContent = mcpUrl;
const isMac = /mac/i.test(navigator.platform || navigator.userAgent);
const configJson = JSON.stringify({
  mcpServers: {
    homey: Object.assign(
      { command: 'npx', args: ['-y', 'mcp-remote', mcpUrl, '--allow-http'] },
      isMac ? { env: { PATH: '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin' } } : {}
    )
  }
}, null, 2);
document.getElementById('claude-config-block').textContent = configJson;

document.getElementById('copy-config-btn').addEventListener('click', function() {
  navigator.clipboard.writeText(configJson).then(() => {
    this.textContent = 'Copied!';
    setTimeout(() => { this.textContent = 'Copy'; }, 2000);
  }).catch(() => { this.textContent = 'Copy failed'; });
});

// Clipboard helper — falls back to execCommand for plain-HTTP (non-secure) contexts
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    if (!ok) throw new Error('copy failed');
  }
}

// Step 2: Copy AI prompt (extraction happens server-side at /onboarding-prompt-text)
document.getElementById('copy-prompt-btn').addEventListener('click', async function() {
  this.disabled = true;
  this.textContent = 'Loading…';
  try {
    const resp = await fetch('/onboarding-prompt-text');
    const prompt = await resp.text();
    await copyText(prompt);
    this.textContent = 'Copied!';
    setTimeout(() => { this.textContent = 'Copy AI prompt'; this.disabled = false; }, 2000);
  } catch (e) {
    this.textContent = 'Failed';
    this.disabled = false;
  }
});

// Step 3: Custom Homey URL
const baseUrlInput = document.getElementById('base-url-input');

document.getElementById('acc3-header').addEventListener('click', async () => {
  // Refresh stored value each time step 3 is toggled
  try {
    const r = await fetch('/settings');
    if (r.ok) { const d = await r.json(); baseUrlInput.value = d.baseUrl || ''; }
  } catch (e) {}
});

document.getElementById('save-settings-btn').addEventListener('click', async function() {
  const newUrl = baseUrlInput.value.trim() || 'https://my.homey.app';
  this.disabled = true;
  this.textContent = 'Saving…';
  try {
    const r1 = await fetch('/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: newUrl })
    });
    if (!r1.ok) throw new Error();
    const r2 = await fetch('/refresh', { method: 'POST' });
    if (r2.ok) { location.reload(); } else { throw new Error(); }
  } catch (e) {
    this.textContent = 'Error';
    this.disabled = false;
  }
});

document.getElementById('refresh-btn').addEventListener('click', async function() {
  this.disabled = true;
  this.textContent = 'Updating…';
  try {
    const res = await fetch('/refresh', { method: 'POST' });
    if (res.ok) {
      location.reload();
    } else {
      this.textContent = 'Failed';
      this.disabled = false;
    }
  } catch (e) {
    this.textContent = 'Error';
    this.disabled = false;
  }
});
</script>
</body>
</html>
`;
