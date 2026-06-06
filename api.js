'use strict';

// HTTP endpoint handlers for the companion app's REST API.
// Each export corresponds to an entry in app.json's "api" section.
// Accessible at: http://[homey-ip]/api/app/com.draper.homey-docs/[path]

module.exports = {

  async changelog({ homey, query }) {
    const since = query.since || null;
    const types = query.types ? query.types.split(',').map(t => t.trim()) : null;
    return homey.app.getChangelog(since, types);
  },

  async snapshot({ homey }) {
    return homey.app.getSnapshot();
  },

  async flows_metadata({ homey }) {
    return homey.app.getFlowsMetadata();
  },

  async variables({ homey }) {
    return homey.app.getVariables();
  },

  async devices({ homey }) {
    return homey.app.getDevices();
  },

  async apps({ homey }) {
    return homey.app.getApps();
  },

  async zones({ homey }) {
    return homey.app.getZones();
  },

  async clear_changelog({ homey }) {
    return homey.app.clearChangelog();
  },

  async reset_snapshot({ homey }) {
    return homey.app.resetSnapshot();
  },

  async diagnostics({ homey }) {
    return homey.app.getDiagnostics();
  },

  async poll({ homey }) {
    await homey.app._poll();
    return { polled: true, changelog: homey.app.changelog.length };
  },

  async flow_snapshot({ homey, query }) {
    return homey.app.getFlowSnapshot(query.id);
  },

  async app_actions({ homey }) {
    return homey.app.getAppActions();
  },

  async sync_complete({ homey }) {
    return homey.app.triggerSyncCompleted();
  },

  async cross_references({ homey }) {
    const data = await homey.app.getCrossReferences();
    const flowTypes = {};
    for (const [id, f] of Object.entries(homey.app.snapshot.flows)) {
      flowTypes[id] = f.isAdvanced ? 'advanced' : 'basic';
    }
    return {
      data,
      meta: {
        homeyId: homey.app._homeyId || null,
        flowTypes,
        mcpPort: homey.app._mcpPort || 8735,
      },
    };
  },

};
