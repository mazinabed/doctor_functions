'use strict';

/**
 * Prescription vs pharmacy fulfillment — notification separation.
 *
 * ── The product rule ────────────────────────────────────────────────────────
 *
 *   Prescription record  = what the doctor prescribed  (clinical truth)
 *   Fulfillment workflow = where it is in the pharmacy  (operational state)
 *   Notifications        = what just changed
 *
 * ── What was wrong ──────────────────────────────────────────────────────────
 *
 * 1. Both the clinical notification (onPrescriptionIssued) and the pharmacy
 *    transmission notification (onClinicalReferralCreated) were titled
 *    "New prescription". A patient whose prescription was sent to a pharmacy
 *    received two notifications reading identically, with no way to tell the
 *    clinical record from the delivery request.
 *
 * 2. Transitions were matched on (before, after) PAIRS. A pharmacy with stock
 *    on hand goes received -> ready without passing through `preparing`, and
 *    the `before === 'preparing'` guard meant the patient was never told the
 *    prescription was ready. `preparing` and `cancelled` had no branch at all,
 *    though the portal writes both.
 */

const {
  STATUS_TO_STAGE,
  stageForTransition,
} = require('../functions/notifications/onClinicalReferralStatusUpdated');

const { getWorkflow } = require('../functions/lib/notificationPlatform/workflowRegistry');
require('../functions/lib/notificationPlatform/workflows/prescriptionWorkflow');

const workflow = getWorkflow('prescription');

describe('the fulfillment workflow covers every pharmacy state', () => {
  test('all six lifecycle stages are defined', () => {
    for (const stage of
      ['sent', 'received', 'preparing', 'ready', 'dispensed', 'cancelled']) {
      expect(workflow.stages[stage]).toBeDefined();
    }
  });

  test('every stage has content in all three languages', () => {
    const ctx = { partnerNameEn: 'Al-Noor', partnerNameAr: 'النور', partnerNameKu: 'نوور' };
    for (const [name, stage] of Object.entries(workflow.stages)) {
      const c = stage.buildContent(ctx);
      for (const field of ['titleEn', 'titleAr', 'titleKu', 'bodyEn', 'bodyAr', 'bodyKu']) {
        expect(typeof c[field]).toBe('string');
        expect(c[field].length).toBeGreaterThan(0);
      }
      // No raw localization keys leaking into patient-facing copy.
      expect(c.titleEn).not.toMatch(/^[a-z_]+\.[a-z_]+$/);
      expect(name).toBeTruthy();
    }
  });

  test('content degrades gracefully when the pharmacy name is missing', () => {
    for (const stage of Object.values(workflow.stages)) {
      const c = stage.buildContent({});
      expect(c.bodyEn).not.toContain('undefined');
      expect(c.bodyAr).not.toContain('undefined');
      expect(c.bodyKu).not.toContain('undefined');
    }
  });

  test('dispensed is the completed terminal, cancelled the cancelled one', () => {
    expect(workflow.stages.dispensed.isCompleted).toBe(true);
    expect(workflow.stages.dispensed.terminal).toBe(true);
    expect(workflow.stages.cancelled.isCancelled).toBe(true);
    expect(workflow.stages.cancelled.terminal).toBe(true);
    // Cancelled must not be reported as a successful completion.
    expect(workflow.stages.cancelled.isCompleted).toBeFalsy();
  });

  test('the cancelled message is neutral — no reason is invented', () => {
    const c = workflow.stages.cancelled.buildContent({ partnerNameEn: 'Al-Noor' });
    expect(c.bodyEn).toMatch(/could not complete/i);
    for (const word of ['refused', 'rejected', 'denied', 'out of stock', 'unpaid']) {
      expect(c.bodyEn.toLowerCase()).not.toContain(word);
    }
  });

  test('the sent stage names fulfillment, not a new prescription', () => {
    // The exact collision that made the two notifications indistinguishable.
    const c = workflow.stages.sent.buildContent({ partnerNameEn: 'Al-Noor' });
    expect(c.titleEn).not.toBe('New prescription');
    expect(c.titleEn).toMatch(/sent to pharmacy/i);
    expect(c.bodyEn).toContain('Al-Noor');
  });

  test('no two stages share a title, so the patient can tell them apart', () => {
    const titles = Object.values(workflow.stages)
      .map((s) => s.buildContent({ partnerNameEn: 'Al-Noor' }).titleEn);
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe('transitions are selected by destination, not by pairs', () => {
  test('the reported skip: received -> ready still notifies Ready', () => {
    expect(stageForTransition('received', 'ready')).toBe('ready');
  });

  test('every ordinary forward step notifies', () => {
    expect(stageForTransition('sent', 'received')).toBe('received');
    expect(stageForTransition('received', 'preparing')).toBe('preparing');
    expect(stageForTransition('preparing', 'ready')).toBe('ready');
    expect(stageForTransition('ready', 'dispensed')).toBe('dispensed');
  });

  test('the two previously-missing states now notify', () => {
    expect(stageForTransition('received', 'preparing')).toBe('preparing');
    expect(stageForTransition('preparing', 'cancelled')).toBe('cancelled');
    expect(stageForTransition('received', 'cancelled')).toBe('cancelled');
  });

  test('cancellation from any stage notifies', () => {
    for (const from of ['sent', 'received', 'preparing', 'ready']) {
      expect(stageForTransition(from, 'cancelled')).toBe('cancelled');
    }
  });

  test('an unchanged status never notifies', () => {
    // The trigger also fires on unrelated field updates.
    for (const s of Object.keys(STATUS_TO_STAGE)) {
      expect(stageForTransition(s, s)).toBeNull();
    }
  });

  test('lab/imaging statuses produce no pharmacy notification', () => {
    for (const s of ['scheduled', 'checkedIn', 'noShow', 'completed']) {
      expect(stageForTransition('sent', s)).toBeNull();
    }
  });

  test('a missing or empty destination never notifies', () => {
    expect(stageForTransition('sent', undefined)).toBeNull();
    expect(stageForTransition('sent', null)).toBeNull();
    expect(stageForTransition('sent', '')).toBeNull();
  });

  test('every mapped status has a matching workflow stage', () => {
    // A status mapped to a stage that does not exist would silently drop the
    // notification inside the engine.
    for (const stage of Object.values(STATUS_TO_STAGE)) {
      expect(workflow.stages[stage]).toBeDefined();
    }
  });

  test('every workflow stage is reachable from some status', () => {
    const reachable = new Set(Object.values(STATUS_TO_STAGE));
    for (const stage of Object.keys(workflow.stages)) {
      expect(reachable.has(stage)).toBe(true);
    }
  });
});

describe('the fulfillment notification routes to the fulfillment screen', () => {
  test('it targets the fulfillment detail, not the clinical record', () => {
    const target = workflow.navigationTarget('req_1');
    expect(target.route).toBe('referral_detail');
    expect(target.params.referralId).toBe('req_1');
  });

  test('legacy routing fields are preserved for the existing app switch', () => {
    const fields = workflow.legacyFields('req_1', { toStage: 'ready' });
    expect(fields.type).toBe('rx_status');
    expect(fields.clinicalRequestId).toBe('req_1');
    expect(fields.subtype).toBe('ready');
  });

  test('it carries no prescriptionId — that belongs to the clinical one', () => {
    // Keeps the two notification types from collapsing into one concept.
    const fields = workflow.legacyFields('req_1', { toStage: 'sent' });
    expect(fields.prescriptionId).toBeUndefined();
  });
});

describe('one evolving document, never one per stage', () => {
  test('the workflow is keyed by the request, so stages update in place', () => {
    // emitWorkflowEvent builds `wf_{workflowType}_{entityId}` and skips when
    // currentStage already matches, so repeated stages cannot duplicate.
    expect(workflow.workflowType).toBe('prescription');
    expect(workflow.entityCollection).toBe('clinical_requests');
  });
});

describe('the patient-safe fulfillment projection keeps durable facts', () => {
  // Read as source: these are trigger writes, and asserting them without the
  // emulator is otherwise guesswork about what the projection contains.
  const fs = require('fs');
  const path = require('path');
  const root = path.resolve(__dirname, '../functions/notifications');
  const created = fs.readFileSync(path.join(root, 'onClinicalReferralCreated.js'), 'utf8');
  const updated = fs.readFileSync(path.join(root, 'onClinicalReferralStatusUpdated.js'), 'utf8');

  test('prescriptionId is projected — the link to the clinical record', () => {
    // The link every future fulfillment episode hangs off. One prescription
    // may later have many requests; nothing here binds it to one pharmacy.
    expect(created).toContain('prescriptionId: data.prescriptionId');
  });

  test('the dispensing pharmacy identity is projected', () => {
    expect(created).toContain('partnerProviderId,');
    for (const f of ['partnerName_en:', 'partnerName_ar:', 'partnerName_ku:']) {
      expect(created).toContain(f);
    }
  });

  test('dispensedAt is now mirrored on status change', () => {
    // Written on clinical_requests at dispense time, but the mirror copied
    // only the three status fields, so the patient copy knew a prescription
    // was dispensed and never when.
    expect(updated).toContain('mirrored.dispensedAt = after.dispensedAt');
  });

  test('dispensedAt is copied only when present', () => {
    // A later status change must not blank an existing timestamp.
    expect(updated).toContain('if (after.dispensedAt)');
  });

  test('dispensedByUid is NOT exposed to the patient', () => {
    // Staff identity, no patient-facing use, and this projection is
    // patient-readable.
    expect(created).not.toContain('dispensedByUid');
    expect(updated).not.toMatch(/mirrored\.dispensedByUid|dispensedByUid:/);
  });

  test('the mirror still writes no clinical or result fields', () => {
    for (const f of ['diagnosisNote', 'resultUrl', 'attachments']) {
      expect(updated).not.toContain(`mirrored.${f}`);
    }
  });
});
