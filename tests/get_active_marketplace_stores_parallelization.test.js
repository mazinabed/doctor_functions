// Patient Performance Round 1 (2026-08-25) — source-level regression
// coverage for getActiveMarketplaceStores.js's pharmacy-path /
// standalone-store Commerce Bridge parallelization fix.
//
// The pharmacy path's own Firestore lookups + Commerce Bridge fetch used
// to run fully sequentially before the standalone-store Bridge fetch even
// started, even though neither reads the other's output (they write to
// disjoint `let` variables, only merged together after both finish). This
// is a plain source-text check, not a live/emulator test: the function
// makes real fetch() calls to Commerce's deployed Cloud Functions and no
// fetch-mocking harness exists in this repo's test infra (tests/ here is
// Firestore-rules-emulator-only, via @firebase/rules-unit-testing).
const fs = require("fs");
const path = require("path");

const SOURCE_PATH = path.join(__dirname, "..", "functions", "commerce", "getActiveMarketplaceStores.js");

describe("getActiveMarketplaceStores.js pharmacy/standalone parallelization", () => {
  const source = fs.readFileSync(SOURCE_PATH, "utf8");

  test("both paths are started as concurrent IIFEs, not run sequentially", () => {
    expect(source).toContain("const pharmacyWork = (async () => {");
    expect(source).toContain("const standaloneWork = (async () => {");
    expect(source).toContain("await Promise.all([pharmacyWork, standaloneWork]);");
  });

  test("both IIFEs are declared, and Promise.all is awaited, BEFORE the merge point reads their outputs", () => {
    const pharmacyIndex = source.indexOf("const pharmacyWork = (async () => {");
    const standaloneIndex = source.indexOf("const standaloneWork = (async () => {");
    const promiseAllIndex = source.indexOf("await Promise.all([pharmacyWork, standaloneWork]);");
    const mergeIndex = source.indexOf(
      "const mergedStores = [...stores, ...standaloneStores].slice(0, resultLimit);",
    );

    expect(pharmacyIndex).toBeGreaterThan(-1);
    expect(standaloneIndex).toBeGreaterThan(pharmacyIndex);
    expect(promiseAllIndex).toBeGreaterThan(standaloneIndex);
    expect(mergeIndex).toBeGreaterThan(promiseAllIndex);
  });

  test("each path's own internal fetch call and output variables are unchanged by the restructuring", () => {
    expect(source).toContain("await fetch(COMMERCE_STORE_DISCOVERY_BRIDGE_URL, {");
    expect(source).toContain("await fetch(STANDALONE_STORE_DISCOVERY_BRIDGE_URL, {");
    // Pharmacy path still writes stores/products/categories/hasMoreProducts;
    // standalone path still writes its own standalone* variables — never
    // cross-assigned by the restructuring.
    expect(source).toMatch(/stores = billingEligible/);
    expect(source).toMatch(/standaloneStores = rawStandaloneStores\.map/);
  });

  test("syntax is valid (catches a mismatched brace from the IIFE wrapping)", () => {
    expect(() => new Function(source)).not.toThrow();
  });
});

// Patient Performance Round 2 (2026-09-08) — sponsored-placements /
// grouped-links Commerce Bridge parallelization fix. The grouped-links
// fetch only needs mergedProducts' orgIds (applySponsoredPlacementsToProducts
// is a pure 1:1 .map(), never changes the orgId set), so it never actually
// needed to wait for the sponsored-placements fetch to finish first — only
// the final grouping/ranking computation genuinely needs sponsoredPlacements.
describe("getActiveMarketplaceStores.js sponsored/grouped-links parallelization", () => {
  const source = fs.readFileSync(SOURCE_PATH, "utf8");

  test("both fetches are started as concurrent IIFEs, not run sequentially", () => {
    expect(source).toContain("const sponsoredWork = (async () => {");
    expect(source).toContain("const groupedLinksWork = (async () => {");
    expect(source).toContain("await Promise.all([sponsoredWork, groupedLinksWork]);");
  });

  test("both IIFEs are declared, and Promise.all is awaited, BEFORE the grouping computation reads their outputs", () => {
    const sponsoredIndex = source.indexOf("const sponsoredWork = (async () => {");
    const groupedIndex = source.indexOf("const groupedLinksWork = (async () => {");
    const promiseAllIndex = source.indexOf("await Promise.all([sponsoredWork, groupedLinksWork]);");
    const sponsoredProductsIndex = source.indexOf(
      "const sponsoredProducts = applySponsoredPlacementsToProducts(mergedProducts, sponsoredPlacements);",
    );
    const groupedComputeIndex = source.indexOf("if (groupedLinksResult !== null) {");

    expect(sponsoredIndex).toBeGreaterThan(-1);
    expect(groupedIndex).toBeGreaterThan(sponsoredIndex);
    expect(promiseAllIndex).toBeGreaterThan(groupedIndex);
    expect(sponsoredProductsIndex).toBeGreaterThan(promiseAllIndex);
    expect(groupedComputeIndex).toBeGreaterThan(sponsoredProductsIndex);
  });

  test("the grouped-links fetch derives its orgId set from mergedProducts directly, not from sponsoredProducts (no false dependency on the sponsored fetch)", () => {
    expect(source).toContain("const orgIdsWithProducts = [...new Set(mergedProducts.map((p) => p.orgId))];");
  });

  test("groupedLinksResult is null unless the fetch both ran and succeeded, mirroring the original gating", () => {
    expect(source).toContain("let groupedLinksResult = null;");
    expect(source).toMatch(/groupedLinksResult = \{\s*links: Array\.isArray\(links\) \? links : \[\],/);
  });

  test("each fetch keeps its own independent try/catch (a failure in one must never abort the other)", () => {
    const sponsoredBlock = source.slice(
      source.indexOf("const sponsoredWork = (async () => {"),
      source.indexOf("})();", source.indexOf("const sponsoredWork = (async () => {")),
    );
    const groupedBlock = source.slice(
      source.indexOf("const groupedLinksWork = (async () => {"),
      source.indexOf("})();", source.indexOf("const groupedLinksWork = (async () => {")),
    );
    expect(sponsoredBlock).toContain("try {");
    expect(sponsoredBlock).toContain("network error reaching Sponsored Placements Bridge");
    expect(groupedBlock).toContain("try {");
    expect(groupedBlock).toContain("network error reaching Grouped Links Bridge");
  });

  test("syntax is valid (catches a mismatched brace from the IIFE wrapping)", () => {
    expect(() => new Function(source)).not.toThrow();
  });
});
