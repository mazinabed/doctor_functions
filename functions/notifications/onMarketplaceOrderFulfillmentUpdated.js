'use strict';

/**
 * onMarketplaceOrderFulfillmentUpdated
 *
 * TrustyDr Workflow & Notification Platform, Phase 1 pilot (see
 * NOTIFICATION_PLATFORM_PROGRESS.md at the ecosystem root). Triggered
 * whenever a marketplace_orders document's `fulfillmentStatus` changes.
 * This file no longer builds notification content or writes Firestore/FCM
 * directly -- it only detects the transition and hands it to the shared
 * Notification Engine, which resolves the registered "marketplace_order"
 * WorkflowDefinition (lib/notificationPlatform/workflows/marketplaceOrderWorkflow.js)
 * and updates ONE stable notification document per order
 * (`wf_marketplace_order_{orderId}`) in place -- never a new document per
 * stage, fixing the notification-spam issue the prior implementation had.
 *
 * `fulfillmentStatus` is written ONLY after Odoo has confirmed the
 * underlying action succeeded (see marketplaceCheckout.js /
 * pharmacyOrderActions.js) -- this trigger fires strictly downstream of
 * that. This file still owns NO business logic -- it is a thin adapter from
 * "the order's stage field changed" to "tell the Notification Engine about
 * it," per the platform's Workflow/Notification separation principle.
 *
 * No notification on `null -> 'new'` (order creation) -- the checkout
 * success screen already surfaces that inline; a push here would be
 * redundant.
 */

const { onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { getFirestore } = require('firebase-admin/firestore');
const { emitWorkflowEvent } = require('../lib/notificationPlatform/notificationEngine');
// Required for its side effect: registers the 'marketplace_order'
// WorkflowDefinition with the Workflow Registry.
require('../lib/notificationPlatform/workflows/marketplaceOrderWorkflow');

exports.onMarketplaceOrderFulfillmentUpdated = onDocumentUpdated(
  'marketplace_orders/{orderId}',
  async (event) => {
    const db = getFirestore();
    const orderId = event.params.orderId;
    const before = event.data.before.data();
    const after = event.data.after.data();

    const prevStatus = before.fulfillmentStatus || null;
    const newStatus = after.fulfillmentStatus || null;

    // No relevant transition, or the (excluded) initial 'new' state.
    if (prevStatus === newStatus || !newStatus || newStatus === 'new') return;

    const patientId = after.patientId || before.patientId;
    if (!patientId) return;

    const storeNameEn = after.storeNameEn || before.storeNameEn || '';
    const storeNameAr = after.storeNameAr || before.storeNameAr || '';

    await emitWorkflowEvent(db, {
      workflowType: 'marketplace_order',
      entityId: orderId,
      recipientUid: patientId,
      toStage: newStatus,
      contentContext: { storeNameEn, storeNameAr, toStage: newStatus },
    });

    console.log(
      `onMarketplaceOrderFulfillmentUpdated: emitted marketplace_order/${orderId} ${prevStatus}->${newStatus}`,
    );
  },
);
