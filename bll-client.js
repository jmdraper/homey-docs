'use strict';

// BLL HTTP API (from BLL readme):
//   GET  /api/app/net.i-dev.betterlogic/ALL              — all variables
//   GET  /api/app/net.i-dev.betterlogic/:name            — single variable
//   PUT  /api/app/net.i-dev.betterlogic/:name/:value     — set value

const http = require('http');

const BLL_APP_ID = 'net.i-dev.betterlogic';
const BLL_TIMEOUT_MS = 5000;
const BLL_CACHE_TTL_MS = 60 * 1000;

let _cache = null;
let _cacheAt = 0;

function _httpGet(app, path) {
  const url = `${app._baseUrl}/api${path}`;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, val) => { if (!settled) { settled = true; clearTimeout(timer); fn(val); } };
    const timer = setTimeout(() => { req.destroy(); done(reject, new Error(`Timeout: ${path}`)); }, BLL_TIMEOUT_MS);
    const req = http.get(url, { headers: { Authorization: `Bearer ${app._token}` } }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) { done(reject, new Error(`HTTP ${res.statusCode}`)); return; }
        try { done(resolve, JSON.parse(body)); }
        catch (e) { done(reject, new Error('JSON parse failed')); }
      });
    });
    req.on('error', err => done(reject, err));
  });
}

function _toArray(data) {
  if (!data) return null;
  if (Array.isArray(data) && data.length > 0) return data;
  if (typeof data === 'object' && !Array.isArray(data)) {
    const entries = Object.entries(data);
    if (entries.length === 0) return null;
    // If values are objects without a name field, inject the key as name
    return entries.map(([key, val]) =>
      (val && typeof val === 'object' && !val.name) ? { ...val, name: key } : val
    );
  }
  return null;
}

async function getBllVariables(app) {
  const now = Date.now();
  if (_cache && (now - _cacheAt) < BLL_CACHE_TTL_MS) return _cache;

  try {
    const data = await _httpGet(app, '/app/' + BLL_APP_ID + '/ALL');
    const result = _toArray(data);
    if (result) {
      _cache = result;
      _cacheAt = now;
      app.log('[BLL] fetched ' + result.length + ' variables');
      return result;
    }
    app.log('[BLL] /ALL returned no usable data: ' + JSON.stringify(data).substring(0, 120));
  } catch (e) {
    app.log('[BLL] GET /ALL failed: ' + e.message);
  }

  return _cache || [];
}

module.exports = { getBllVariables };
