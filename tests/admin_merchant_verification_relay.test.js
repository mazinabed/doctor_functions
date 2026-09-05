'use strict';

/**
 * Admin relay for Merchant Verification (2026-09) — the Healthcare half of
 * mydoctor_admin -> Healthcare -> Commerce.
 *
 * Two things make this relay worth testing behaviorally rather than by source
 * scan (this repo's usual convention for bridge files):
 *
 *   1. requireAdmin() here is the ONLY real authorization gate. Commerce's own
 *      endpoints are IAM-invoker-restricted to this project's runtime service
 *      account, and `actorUid` in the body is an audit label, never a boundary
 *      — so if this gate is ever bypassed, nothing downstream catches it.
 *
 *   2. These endpoints reach a named individual's government-ID documents and
 *      decide whether a business may trade at all. A relay that leaked either
 *      to a non-admin is not a minor defect.
 *
 * Pure unit tests, no emulator: Firestore, google-auth-library and node-fetch
 * are all mocked (same approach as commerce_auth_helper.test.js), so no real
 * credentials, network calls or documents are ever involved. firebase-functions
 * v2 exposes `.run(request)` on an onCall function, which is what lets the real
 * handler run against a synthetic request.
 */

const mockGet = jest.fn();
const mockFetch = jest.fn();

// firebase-admin, google-auth-library and node-fetch live under
// functions/node_modules, and firebase-admin exposes its subpaths through an
// exports map — so each mock must resolve from the functions/ directory, to
// the SAME module instance adminB2BRegulatory.js's own require() reaches.
// A function DECLARATION, not a const: jest.mock() calls are hoisted above
// every const in the file, so an arrow assigned to one is still in its
// temporal dead zone when the first mock runs.
function fromFunctions(id) {
  return require.resolve(id, {
    paths: [require('path').resolve(__dirname, '../functions')],
  });
}

jest.mock(fromFunctions('firebase-admin/firestore'), () => ({
  getFirestore: () => ({
    collection: () => ({ doc: () => ({ get: mockGet }) }),
  }),
}));

jest.mock(fromFunctions('google-auth-library'), () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getIdTokenClient: jest.fn().mockResolvedValue({
      getRequestHeaders: jest.fn().mockResolvedValue({
        Authorization: 'Bearer fake-oidc-token',
      }),
    }),
  })),
}));

jest.mock(fromFunctions('node-fetch'), () => (...args) =>
  mockFetch(...args),
);

/** The Commerce response for a call that succeeded. */
function commerceOk(body = { ok: true }) {
  mockFetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

/** The Commerce response for a call Commerce itself refused. */
function commerceRefuses(status, body) {
  mockFetch.mockResolvedValue({
    ok: false,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

const ADMIN = { auth: { uid: 'admin_uid' } };

function asAdmin(data = {}) {
  mockGet.mockResolvedValue({ data: () => ({ role: 'admin' }) });
  return { ...ADMIN, data };
}

/** The body actually POSTed to Commerce on the last call. */
function sentBody() {
  return JSON.parse(mockFetch.mock.calls.at(-1)[1].body);
}

/** The Commerce endpoint the last call targeted. */
function sentEndpoint() {
  return String(mockFetch.mock.calls.at(-1)[0]).split('/').pop();
}

async function expectRejection(promise, code) {
  await expect(promise).rejects.toMatchObject({ code });
}

let relay;

beforeEach(() => {
  jest.resetModules();
  mockGet.mockReset();
  mockFetch.mockReset();
  relay = require('../functions/commerce/adminB2BRegulatory');
  commerceOk();
});

const MERCHANT_ENDPOINTS = [
  ['adminListMerchantVerifications', {}],
  ['adminGetMerchantVerificationDocument', { orgId: 'org_1', docType: 'business_registration' }],
  ['adminApproveMerchantVerification', { orgId: 'org_1' }],
  ['adminReviewMerchantVerification', { orgId: 'org_1', decision: 'rejected', reason: 'Not genuine.' }],
];

describe('A — only an admin reaches any of it', () => {
  test.each(MERCHANT_ENDPOINTS)('%s rejects an unauthenticated caller', async (name, data) => {
    await expectRejection(relay[name].run({ auth: null, data }), 'unauthenticated');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test.each(MERCHANT_ENDPOINTS)(
    '%s rejects a signed-in non-admin — a merchant cannot review itself',
    async (name, data) => {
      mockGet.mockResolvedValue({ data: () => ({ role: 'patient' }) });
      await expectRejection(
        relay[name].run({ auth: { uid: 'merchant_uid' }, data }),
        'permission-denied',
      );
      // The point: nothing reached Commerce. No document URL was minted, no
      // approval was attempted.
      expect(mockFetch).not.toHaveBeenCalled();
    },
  );

  test.each(MERCHANT_ENDPOINTS)('%s rejects a user with no role at all', async (name, data) => {
    mockGet.mockResolvedValue({ data: () => undefined });
    await expectRejection(
      relay[name].run({ auth: { uid: 'ghost_uid' }, data }),
      'permission-denied',
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test.each(MERCHANT_ENDPOINTS)('%s admits a real admin', async (name, data) => {
    await expect(relay[name].run(asAdmin(data))).resolves.toBeDefined();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});

describe('B — each endpoint relays to its own Commerce counterpart', () => {
  test('the pending queue is fetched, tagged with the reviewing admin', async () => {
    await relay.adminListMerchantVerifications.run(asAdmin());
    expect(sentEndpoint()).toBe('listPendingMerchantVerificationsForHealthcare');
    // actorUid is an audit label on the Commerce side, never a security
    // boundary — requireAdmin above is the gate. It must still be the real
    // reviewer, so an approval is attributable.
    expect(sentBody().actorUid).toBe('admin_uid');
  });

  test('a document request carries exactly the document asked for', async () => {
    await relay.adminGetMerchantVerificationDocument.run(
      asAdmin({ orgId: 'org_7', docType: 'responsible_person_id_front' }),
    );
    expect(sentEndpoint()).toBe('getMerchantVerificationDocumentForHealthcare');
    expect(sentBody()).toMatchObject({
      orgId: 'org_7',
      docType: 'responsible_person_id_front',
      actorUid: 'admin_uid',
    });
  });

  test('a document request without both identifiers is refused before Commerce', async () => {
    for (const data of [{}, { orgId: 'org_7' }, { docType: 'x' }, { orgId: 7, docType: 'x' }]) {
      await expectRejection(
        relay.adminGetMerchantVerificationDocument.run(asAdmin(data)),
        'invalid-argument',
      );
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('approval names the organization and nothing else', async () => {
    await relay.adminApproveMerchantVerification.run(asAdmin({ orgId: 'org_7' }));
    expect(sentEndpoint()).toBe('approveMerchantVerificationForHealthcare');
    expect(sentBody()).toEqual({ orgId: 'org_7', actorUid: 'admin_uid' });
  });

  test('approval without an orgId is refused before Commerce', async () => {
    await expectRejection(
      relay.adminApproveMerchantVerification.run(asAdmin({})),
      'invalid-argument',
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('C — a decision a merchant cannot act on is not a decision', () => {
  test('reject and request-changes both require a reason', async () => {
    for (const decision of ['rejected', 'changes_requested']) {
      for (const reason of [undefined, '', '   ', 42]) {
        await expectRejection(
          relay.adminReviewMerchantVerification.run(asAdmin({ orgId: 'org_1', decision, reason })),
          'invalid-argument',
        );
      }
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });

  test('the reason is trimmed but never rewritten — the merchant reads it verbatim', async () => {
    await relay.adminReviewMerchantVerification.run(
      asAdmin({
        orgId: 'org_1',
        decision: 'changes_requested',
        reason: '  The ID photo is unreadable.  ',
      }),
    );
    expect(sentEndpoint()).toBe('reviewMerchantVerificationForHealthcare');
    expect(sentBody()).toEqual({
      orgId: 'org_1',
      decision: 'changes_requested',
      reason: 'The ID photo is unreadable.',
      actorUid: 'admin_uid',
    });
  });

  test('the review verbs are closed — approval is not reachable through review', async () => {
    // Approval is a different endpoint with a document-completeness check and
    // a trial start behind it. Passing "verified" here must not be a shortcut
    // past either.
    for (const decision of ['verified', 'approved', 'grandfathered', 'pending', '', undefined]) {
      await expectRejection(
        relay.adminReviewMerchantVerification.run(
          asAdmin({ orgId: 'org_1', decision, reason: 'a reason' }),
        ),
        'invalid-argument',
      );
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('D — Commerce stays the real authority', () => {
  test("a second approval is refused because Commerce refuses it, not because Admin remembered", async () => {
    // Review-once lives in Commerce's own transaction (integration test MV-9).
    // What matters here is that the relay surfaces that refusal as a real
    // error instead of reporting success to the admin.
    commerceRefuses(400, { error: 'Application is not pending.' });
    await expectRejection(
      relay.adminApproveMerchantVerification.run(asAdmin({ orgId: 'org_1' })),
      'invalid-argument',
    );
  });

  test('an incomplete application is surfaced as a precondition failure', async () => {
    commerceRefuses(422, { error: 'documents_incomplete' });
    await expectRejection(
      relay.adminApproveMerchantVerification.run(asAdmin({ orgId: 'org_1' })),
      'failed-precondition',
    );
  });

  test('the admin UI display is never the completeness gate', async () => {
    // The Admin screen disables Approve when documents are missing, but that
    // is advisory. Even with a well-formed request from a real admin, the
    // grant only happens if Commerce agrees.
    commerceRefuses(422, { error: 'documents_incomplete' });
    await expectRejection(
      relay.adminApproveMerchantVerification.run(asAdmin({ orgId: 'org_1' })),
      'failed-precondition',
    );
    expect(sentEndpoint()).toBe('approveMerchantVerificationForHealthcare');
  });
});

describe('E — the two approvals stay separate', () => {
  const REGULATED_ENDPOINTS = [
    'adminListSellerRegulatoryApplications',
    'adminGetSellerRegulatoryDocument',
    'adminApproveSellerRegulatoryApplication',
    'adminRejectSellerRegulatoryApplication',
  ];

  test('the regulated relay endpoints still exist, unchanged', () => {
    for (const name of REGULATED_ENDPOINTS) {
      expect(typeof relay[name]?.run).toBe('function');
    }
  });

  test('no merchant-verification endpoint can grant a regulatory scope', async () => {
    // Structural, and the reason these live in one file without merging: the
    // base approval's entire payload is {orgId, actorUid}. There is no field
    // through which a scope could travel, by mistake or otherwise.
    await relay.adminApproveMerchantVerification.run(asAdmin({ orgId: 'org_1' }));
    expect(Object.keys(sentBody()).sort()).toEqual(['actorUid', 'orgId']);

    const source = require('fs').readFileSync(
      require('path').resolve(__dirname, '../functions/commerce/adminB2BRegulatory.js'),
      'utf8',
    );
    const merchantSection = source.slice(source.indexOf('adminListMerchantVerifications'));
    const code = merchantSection
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n');
    expect(code).not.toContain('sellerRegulatoryScopes');
    expect(code).not.toContain('SellerRegulatoryApplicationForHealthcare');
  });

  test('every merchant relay is exported from index.js', () => {
    // A handler nobody can call is the failure mode that is easiest to miss:
    // the Admin UI would fail with a CORS error that is really a 404.
    const index = require('fs').readFileSync(
      require('path').resolve(__dirname, '../functions/index.js'),
      'utf8',
    );
    for (const [name] of MERCHANT_ENDPOINTS) {
      expect(index).toContain(name);
    }
  });
});
