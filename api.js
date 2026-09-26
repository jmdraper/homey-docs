'use strict';

// HTTP endpoint handlers for the companion app's REST API.
// Each export corresponds to an entry in app.json's "api" section.
// Accessible at: http://[homey-ip]/api/app/com.draper.homey-docs/[path]

module.exports = {

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

  async reset_snapshot({ homey }) {
    return homey.app.resetSnapshot();
  },

  async diagnostics({ homey }) {
    return homey.app.getDiagnostics();
  },

  async refresh({ homey }) {
    return homey.app._refreshSnapshot();
  },

  async flow_summary({ homey, query }) {
    return homey.app.getFlowSummary(query.id);
  },

  async search_flows({ homey, query }) {
    return homey.app.searchFlows(query.q || query.query, parseInt(query.limit, 10) || undefined);
  },

  async app_actions({ homey }) {
    return homey.app.getAppActions();
  },

  async cross_references({ homey }) {
    const data = await homey.app.getCachedCrossReferences();
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
