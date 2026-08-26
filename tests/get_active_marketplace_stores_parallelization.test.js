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
