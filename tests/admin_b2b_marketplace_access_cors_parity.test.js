'use strict';

/**
 * 4B.5 live-test blocker (2026-08-18) — CORS failure reported for
 * adminGrantBuyerScopes ("No 'Access-Control-Allow-Origin' header is
 * present"). Investigation (Cloud Functions API + Cloud Logging against
 * doctorapp-7e8b3 and trustydr-commerce) found NO deployed revision of
 * adminGrantBuyerScopes/grantBuyerScopesForHealthcare at all — zero matches,
 * zero deploy-attempt log entries — while the sibling function in the SAME
 * file, adminUpdateMarketplaceChannels, IS deployed and ACTIVE. A request to
 * a Cloud Function URL that was never deployed returns a 404 with no
 * Access-Control-Allow-Origin header (nothing ran to add one), which the
 * browser reports as a CORS error even though the real cause is "this
 * function does not exist yet" — not a code defect.
 *
 * This is a STATIC source-scan regression test (same convention as
 * commerce_bridge_auth_coverage.test.js — no emulator, no live HTTP
 * server: this repo's test setup has no supertest/express-level harness,
 * so an actual CORS preflight response cannot be exercised here). It
 * proves the code-level property that actually determines CORS behavior —
 * every admin relay's onCall wrapper uses the SAME options object, with no
 * function-specific override that could restrict/break CORS — so a future
 * edit that accidentally diverges one function's onCall options (e.g.
 * adding a custom `cors` restriction to only one of several sibling
 * exports) fails this test immediately, rather than surfacing as a
 * confusing live "CORS error" days later.
 */
const fs = require('fs');
const path = require('path');

const COMMERCE_DIR = path.resolve(__dirname, '../functions/commerce');

function readSource(fileName) {
  return fs.readFileSync(path.join(COMMERCE_DIR, fileName), 'utf8');
}

// Matches `exports.<name> = onCall(<options-object>, async (request) => {`
// — captures the exact options object literal passed to onCall for every
// admin-relay export in a file.
function findOnCallOptions(source) {
  const re = /exports\.(\w+)\s*=\s*onCall\(\s*(\{[^)]*?\})\s*,/g;
  const results = [];
  let m;
  while ((m = re.exec(source)) !== null) {
    results.push({ name: m[1], optionsLiteral: m[2].replace(/\s+/g, ' ').trim() });
  }
  return results;
}

describe('Admin B2B relay files use the SAME onCall options shape as the working precedent (CORS parity)', () => {
  const ADMIN_RELAY_FILES = [
    'adminSponsoredPlacements.js',
    'adminB2BRegulatory.js',
    'adminB2BMarketplaceAccess.js',
  ];

  const allExports = ADMIN_RELAY_FILES.flatMap((fileName) =>
    findOnCallOptions(readSource(fileName)).map((entry) => ({ fileName, ...entry })),
  );

  test('sanity check: every admin relay file actually exports at least one onCall function', () => {
    for (const fileName of ADMIN_RELAY_FILES) {
      const inFile = allExports.filter((e) => e.fileName === fileName);
      expect(inFile.length).toBeGreaterThan(0);
    }
  });

  test('adminGrantBuyerScopes and adminUpdateMarketplaceChannels use the exact same onCall options literal (no function-specific CORS/region override)', () => {
    const grantBuyerScopes = allExports.find((e) => e.name === 'adminGrantBuyerScopes');
    const updateMarketplaceChannels = allExports.find(
      (e) => e.name === 'adminUpdateMarketplaceChannels',
    );
    expect(grantBuyerScopes).toBeDefined();
    expect(updateMarketplaceChannels).toBeDefined();
    expect(grantBuyerScopes.optionsLiteral).toBe(updateMarketplaceChannels.optionsLiteral);
  });

  test.each(allExports.map((e) => [e.fileName, e.name, e.optionsLiteral]))(
    '%s: %s uses the known-working onCall options shape `{ region: "us-central1" }` — never a custom `cors` restriction that could break preflight for admin.trustydr.com',
    (fileName, name, optionsLiteral) => {
      expect(optionsLiteral).toBe('{ region: "us-central1" }');
    },
  );
});
