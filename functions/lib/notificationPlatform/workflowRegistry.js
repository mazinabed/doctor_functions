'use strict';

// Workflow Registry -- the Notification Engine never hardcodes "Marketplace"
// / "Lab" / "Pharmacy"; it only knows how to ask this registry for a
// WorkflowDefinition by workflowType. A future module (B2B, refills, home
// visits) plugs in by registering its own definition here -- the engine's
// own code never changes. See NOTIFICATION_PLATFORM_PROGRESS.md.

const workflows = new Map();

function registerWorkflow(definition) {
  if (!definition || typeof definition.workflowType !== 'string' || !definition.workflowType) {
    throw new Error('registerWorkflow: definition.workflowType is required');
  }
  if (workflows.has(definition.workflowType)) {
    throw new Error(`registerWorkflow: "${definition.workflowType}" is already registered`);
  }
  workflows.set(definition.workflowType, definition);
}

function getWorkflow(workflowType) {
  return workflows.get(workflowType) || null;
}

module.exports = { registerWorkflow, getWorkflow };
