// TrustyDr Commerce Bridge — Phase 1C (Patient Marketplace, browse-only).
//
// Store Discovery aggregate. Patient-App-facing counterpart to
// getMarketplaceCatalog.js, same direction (Healthcare -> Commerce).
//
// PUBLIC BROWSE (2026-07-15): deliberately NOT auth-gated — see the matching
// note in getMarketplaceCatalog.js for the full rationale (guests must be
// able to browse the full public Marketplace, matching TrustyDr's existing
// healthcare discovery model; this function never used request.auth.uid for
// scoping, only as a pure access gate, so removing it changes nothing about
// what data is returned). Billing/eligibility filtering below (province/
// city/status/verification/commerce-operational) is unrelated to caller
// identity — it already runs the same way for every request regardless of
// who's asking.
//
// Reuses the EXACT existing pharmacy discovery query shape (province_key +
// city_en on public_pharmacy_providers — see
// core/providers/pharmacy_providers_stream_provider.dart and
// core/providers/app_location_provider.dart in TrustyDr-pwa, whose
// AppLocation only ever carries provinceKey + cityEn, never a normalized
// city key) so Store Discovery never becomes a second location system.
//
// Billing-operational status (medical_centers.commerceSubscriptionStatus) is
// resolved HERE, in Healthcare, using the same owner-uid -> users/{uid}.
// centerId -> medical_centers/{centerId} chain resolveAccessContext.js
// already uses for a single caller — just batched over candidate pharmacies
// instead of one. Commerce has no reliably fresh, orgId-keyed copy of this
// value safe to reuse for arbitrary lookups (commerceOwnerOdooDesiredActive
// on the Commerce org doc is an on-demand sync marker, explicitly documented
// there as not a cache of the billing decision) — so billing stays a
// Healthcare-side check, and only the already-filtered orgId list crosses
// the project boundary. Commerce's getActiveMarketplaceStoresForHealthcare
// independently verifies the facts IT owns (org type/status/verification/
// Odoo-provisioning, marketplace product count) — see that function's own
// header.
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

const COMMERCE_STORE_DISCOVERY_BRIDGE_URL =
  "https://us-central1-trustydr-commerce.cloudfunctions.net/getActiveMarketplaceStoresForHealthcare";

// Standalone Patient Marketplace Discovery, Stage 1 (2026-08-04) — a
// SEPARATE, additive bridge endpoint for standalone (non-Healthcare-origin)
// Commerce organizations that have explicitly opted into the "b2c"
// marketplace channel (organizations/{orgId}.marketplaceChannels — see
// trustydr-commerce/functions/src/lib/marketplaceEligibility.ts). This
// endpoint does its OWN province/city filtering on the Commerce side
// (Commerce owns provinceKey/cityKey/cityEn; Healthcare has no
// public_pharmacy_providers-equivalent projection for these orgs and none
// is created by this change — see this file's own merge logic below).
const STANDALONE_STORE_DISCOVERY_BRIDGE_URL =
  "https://us-central1-trustydr-commerce.cloudfunctions.net/getEligibleStandaloneStoresForHealthcare";

const PHARMACY_ORG_ID_PREFIX = "hc_pharmacy_";
const MAX_CANDIDATES = 50;

// Same three-value definition Commerce's isCommerceBillingOperational uses
// (trustydr-commerce/functions/src/commercePharmacyStatus.ts) — duplicated
// here deliberately rather than imported, since it's a 3-value enum check on
// data Healthcare itself owns and writes (startCommerceTrial.js,
// expireCenters.js), not logic borrowed from Commerce.
function isCommerceBillingOperational(status) {
  return status === "trial" || status === "active" || status === "grace";
}

exports.getActiveMarketplaceStores = onCall({ region: "us-central1" }, async (request) => {
  const { provinceKey, cityEn, search, limit, productsLimit } = request.data || {};
  if (!provinceKey || typeof provinceKey !== "string") {
    throw new HttpsError("invalid-argument", "provinceKey is required.");
  }
  if (!cityEn || typeof cityEn !== "string") {
    throw new HttpsError("invalid-argument", "cityEn is required.");
  }
  const resultLimit =
    typeof limit === "number" && limit > 0 ? Math.min(limit, MAX_CANDIDATES) : MAX_CANDIDATES;

  const db = admin.firestore();

  let candidatesSnap;
  try {
    candidatesSnap = await db
      .collection("public_pharmacy_providers")
      .where("status", "==", "active")
      .where("province_key", "==", provinceKey)
      .where("city_en", "==", cityEn.trim())
      .limit(MAX_CANDIDATES)
      .get();
  } catch (err) {
    console.error("[getActiveMarketplaceStores] public_pharmacy_providers query failed:", err);
    throw new HttpsError("internal", "Could not load pharmacies for this location.");
  }

  let candidates = candidatesSnap.docs.map((doc) => ({ id: doc.id, data: doc.data() }));

  if (search && typeof search === "string" && search.trim()) {
    const needle = search.trim().toLowerCase();
    candidates = candidates.filter((c) => {
      const tokens = Array.isArray(c.data.searchTokens) ? c.data.searchTokens : [];
      return tokens.some((t) => typeof t === "string" && t.includes(needle));
    });
  }

  // Early-return bug fix (2026-08-04) — both of this pharmacy path's own
  // early returns (empty `candidates`, empty `billingEligible`) used to
  // `return` the ENTIRE function, which meant the standalone merge block
  // below was NEVER reached whenever a province/city had no (billing-
  // eligible) Healthcare pharmacy — exactly Wasit/Kut's case, where Demo
  // Store is the only candidate at all. Confirmed live: calling Commerce's
  // getEligibleStandaloneStoresForHealthcare directly returned Demo Store
  // correctly, but this function's own merged response was still empty,
  // and functions:log showed no "Standalone Commerce Bridge" log line at
  // all for that request — proof execution never reached that fetch.
  // Fixed by scoping the pharmacy-specific work (candidate resolution,
  // billing-eligibility filtering, the Commerce pharmacy-bridge call, and
  // building `stores`/`products`/`categories`/`hasMoreProducts`) inside a
  // labeled block that `break`s out early on either empty case WITHOUT
  // returning from the function, so the always-additive standalone merge
  // below still runs regardless. The pharmacy path's own logic/output is
  // byte-for-byte unchanged; only the control flow around it changed.
  let stores = [];
  let products = [];
  let categories = [];
  let hasMoreProducts = false;

  pharmacyPath: if (candidates.length > 0) {
    // Resolve each candidate owner's centerId, then batch-get medical_centers
    // for billing status. Bounded by MAX_CANDIDATES — never an unbounded fan-out.
    const centerIdByPharmacyId = new Map();
    await Promise.all(
      candidates.map(async (c) => {
        const userSnap = await db.collection("users").doc(c.id).get();
        centerIdByPharmacyId.set(c.id, userSnap.exists ? userSnap.data().centerId || null : null);
      }),
    );

    const uniqueCenterIds = [...new Set([...centerIdByPharmacyId.values()].filter(Boolean))];
    const billingStatusByCenterId = new Map();
    await Promise.all(
      uniqueCenterIds.map(async (centerId) => {
        const centerSnap = await db.collection("medical_centers").doc(centerId).get();
        billingStatusByCenterId.set(
          centerId,
          centerSnap.exists ? centerSnap.data().commerceSubscriptionStatus || null : null,
        );
      }),
    );

    const billingEligible = candidates.filter((c) => {
      const centerId = centerIdByPharmacyId.get(c.id);
      if (!centerId) return false;
      return isCommerceBillingOperational(billingStatusByCenterId.get(centerId));
    });

    if (billingEligible.length === 0) break pharmacyPath;

    const orgIds = billingEligible.map((c) => `${PHARMACY_ORG_ID_PREFIX}${c.id}`);

    let commerceResponse;
    try {
      const response = await fetch(COMMERCE_STORE_DISCOVERY_BRIDGE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgIds,
          ...(typeof productsLimit === "number" ? { productsLimit } : {}),
        }),
      });
      if (!response.ok) {
        console.error(
          "[getActiveMarketplaceStores] Commerce Bridge returned status:",
          response.status,
        );
        throw new HttpsError("internal", "Store data is temporarily unavailable.");
      }
      commerceResponse = await response.json();
    } catch (err) {
      if (err instanceof HttpsError) throw err;
      console.error("[getActiveMarketplaceStores] network error reaching Commerce Bridge:", err);
      throw new HttpsError("internal", "Could not reach the Commerce Bridge.");
    }

    const commerceStoresByOrgId = new Map(
      (Array.isArray(commerceResponse.stores) ? commerceResponse.stores : []).map((s) => [
        s.orgId,
        s,
      ]),
    );

    // Kept for the products merge below — same source data as the stores
    // array, just keyed by orgId instead of filtered/sliced to resultLimit,
    // since a product's store name must resolve even if that store didn't
    // make the (separately limited) Stores tab cut.
    const storeDisplayByOrgId = new Map(
      billingEligible.map((c) => [
        `${PHARMACY_ORG_ID_PREFIX}${c.id}`,
        {
          facilityName_en: c.data.facilityName_en || null,
          facilityName_ar: c.data.facilityName_ar || null,
          facilityName_ku: c.data.facilityName_ku || null,
        },
      ]),
    );

    stores = billingEligible
      .map((c) => {
        const orgId = `${PHARMACY_ORG_ID_PREFIX}${c.id}`;
        const commerceStore = commerceStoresByOrgId.get(orgId);
        if (!commerceStore) return null;
        return {
          providerId: c.id,
          orgId,
          facilityName_en: c.data.facilityName_en || null,
          facilityName_ar: c.data.facilityName_ar || null,
          facilityName_ku: c.data.facilityName_ku || null,
          imageUrl: c.data.imageUrl || null,
          province_en: c.data.province_en || null,
          province_ar: c.data.province_ar || null,
          province_ku: c.data.province_ku || null,
          city_en: c.data.city_en || null,
          city_ar: c.data.city_ar || null,
          city_ku: c.data.city_ku || null,
          facilityAddress: c.data.facilityAddress || null,
          productCount: commerceStore.productCount,
          // Store Branding V1 (2026-07-22) — Commerce.storeBranding.ts is now
          // the authoritative source for real storefront identity. Commerce
          // no longer returns featuredImageUrl at all (that field used to be
          // a sampled PRODUCT image standing in for a store banner — removed
          // outright, never replaced, per the approved architecture decision
          // that a product must never represent the merchant itself). Kept
          // here as an always-null field, not deleted from this Healthcare
          // response shape, purely so no existing Flutter field silently
          // disappears from the wire contract.
          featuredImageUrl: null,
          logoUrl: commerceStore.logoUrl || null,
          bannerUrl: commerceStore.bannerUrl || null,
          tagline_en: commerceStore.tagline_en || null,
          tagline_ar: commerceStore.tagline_ar || null,
          tagline_ku: commerceStore.tagline_ku || null,
          description_en: commerceStore.description_en || null,
          description_ar: commerceStore.description_ar || null,
          description_ku: commerceStore.description_ku || null,
        };
      })
      .filter((s) => s !== null)
      .slice(0, resultLimit);

    // Cross-store Products/Categories tabs (Marketplace landing page) — same
    // response, no second call. Products carry their store's display name
    // (Healthcare-owned data Commerce never has) merged in here; Commerce
    // only ever returns orgId for a product, never a store name.
    products = (Array.isArray(commerceResponse.products) ? commerceResponse.products : [])
      .map((p) => {
        const store = storeDisplayByOrgId.get(p.orgId);
        return {
          orgId: p.orgId,
          engineId: p.engineId,
          sku: p.sku,
          name_en: p.name_en,
          name_ar: p.name_ar,
          description_en: p.description_en ?? null,
          description_ar: p.description_ar ?? null,
          brandName: p.brandName ?? null,
          categoryEngineIds: Array.isArray(p.categoryEngineIds) ? p.categoryEngineIds : [],
          categoryKeys: Array.isArray(p.categoryKeys) ? p.categoryKeys : [],
          categories: Array.isArray(p.categories) ? p.categories : [],
          categoryEngineId: p.categoryEngineId ?? null,
          categoryName_en: p.categoryName_en ?? null,
          categoryName_ar: p.categoryName_ar ?? null,
          displayPrice: p.displayPrice,
          currencyName: p.currencyName ?? null,
          isFeatured: Boolean(p.isFeatured),
          availabilityBadge: p.availabilityBadge,
          // Patient Marketplace gallery (2026-07-18) — imageUrl unchanged
          // (existing consumers keep working); galleryImageUrls is new,
          // already Primary-first/deduplicated/capped-at-3 by Commerce's own
          // buildOutwardImageContract before it ever reaches this function —
          // passed through as-is, not re-derived here.
          imageUrl: p.imageUrl ?? null,
          galleryImageUrls: Array.isArray(p.galleryImageUrls) ? p.galleryImageUrls : [],
          storeName_en: store?.facilityName_en ?? null,
          storeName_ar: store?.facilityName_ar ?? null,
          storeName_ku: store?.facilityName_ku ?? null,
        };
      });

    // Shared Marketplace Category Engine (2026-07-14) — categoryKey/
    // parentCategoryKey is the stable identity the Patient App now
    // filters/navigates on; engineId/odooCategoryId survive only for
    // reference. This used to re-map to the legacy engineId-shaped fields
    // only, silently dropping the new ones — fixed here.
    categories = (Array.isArray(commerceResponse.categories) ? commerceResponse.categories : [])
      .map((c) => ({
        categoryKey: c.categoryKey,
        parentCategoryKey: c.parentCategoryKey ?? null,
        level: c.level ?? 0,
        name_en: c.name_en,
        name_ar: c.name_ar,
        name_ku: c.name_ku ?? "",
        iconKey: c.iconKey ?? null,
        sortOrder: c.sortOrder ?? 0,
        featured: Boolean(c.featured),
        odooCategoryId: c.odooCategoryId ?? null,
      }));

    hasMoreProducts = commerceResponse.hasMoreProducts === true;
  }

  // Standalone Patient Marketplace Discovery, Stage 1 (2026-08-04) — a
  // SEPARATE, additive fetch merged in below. Everything above this point
  // (the existing Healthcare pharmacy public_pharmacy_providers query,
  // billing-eligibility check, and Commerce enrichment call) is otherwise
  // UNCHANGED — this is purely additive, and best-effort: if the standalone
  // fetch fails for any reason, pharmacy results are still returned exactly
  // as before, never blocked by this addition. (The pharmacy path above is
  // now reached-or-skipped via `pharmacyPath: if/break`, not `return`,
  // specifically so it can never block this block from running — see this
  // function's own "Early-return bug fix" comment above.)
  let standaloneStores = [];
  let standaloneProducts = [];
  let standaloneCategories = [];
  let standaloneHasMoreProducts = false;
  try {
    const standaloneResponse = await fetch(STANDALONE_STORE_DISCOVERY_BRIDGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provinceKey,
        cityEn,
        ...(typeof productsLimit === "number" ? { productsLimit } : {}),
      }),
    });
    if (standaloneResponse.ok) {
      const standaloneData = await standaloneResponse.json();
      const rawStandaloneStores = Array.isArray(standaloneData.stores) ? standaloneData.stores : [];

      // Localized province/city display names, resolved from Healthcare's
      // OWN `cities` collection — the exact same canonical location data
      // standalone Commerce organizations already store provinceKey/cityEn
      // against (C3). Every standalone store in this response shares the
      // SAME provinceKey/cityEn as the request itself, so this is one
      // lookup for the whole batch, never one per store, and it is never
      // written anywhere — a read-only display-name resolution, not a new
      // denormalized field on any document.
      let provinceNameEn = null;
      let provinceNameAr = null;
      let provinceNameKu = null;
      let cityNameEn = null;
      let cityNameAr = null;
      let cityNameKu = null;
      if (rawStandaloneStores.length > 0) {
        try {
          const provinceSnap = await db.collection("cities").doc(provinceKey).get();
          if (provinceSnap.exists) {
            const provinceData = provinceSnap.data();
            provinceNameEn = provinceData.name_en || null;
            provinceNameAr = provinceData.lang?.ar || null;
            provinceNameKu = provinceData.lang?.ku || null;
            const subCities = Array.isArray(provinceData.subCities) ? provinceData.subCities : [];
            const matchedCity = subCities.find(
              (sc) => typeof sc.en === "string" && sc.en.trim().toLowerCase() === cityEn.trim().toLowerCase(),
            );
            if (matchedCity) {
              cityNameEn = matchedCity.en || null;
              cityNameAr = matchedCity.ar || null;
              cityNameKu = matchedCity.ku || null;
            }
          }
        } catch (err) {
          console.error(
            "[getActiveMarketplaceStores] cities lookup for standalone stores failed:",
            err,
          );
        }
      }

      // Patient store model / name fallback (Stage 1, 2026-08-04) —
      // Commerce's Organization schema has a single `name` field, never
      // the localized facilityName_en/ar/ku triplet Healthcare pharmacy
      // documents provide (see TrustyDr-pwa's MarketplaceStore model
      // adaptation for the Flutter-side half of this same fallback).
      // Setting the SAME name for all three here is the smallest
      // backward-compatible choice — no new Commerce schema field, no
      // localization redesign.
      const standaloneNameByOrgId = new Map(
        rawStandaloneStores.map((s) => [s.orgId, s.name || null]),
      );

      standaloneStores = rawStandaloneStores.map((s) => ({
        providerId: s.orgId,
        orgId: s.orgId,
        facilityName_en: s.name || null,
        facilityName_ar: s.name || null,
        facilityName_ku: s.name || null,
        imageUrl: null,
        province_en: provinceNameEn,
        province_ar: provinceNameAr,
        province_ku: provinceNameKu,
        city_en: cityNameEn,
        city_ar: cityNameAr,
        city_ku: cityNameKu,
        facilityAddress: null,
        productCount: s.productCount,
        featuredImageUrl: null,
        logoUrl: s.logoUrl || null,
        bannerUrl: s.bannerUrl || null,
        tagline_en: s.tagline_en || null,
        tagline_ar: s.tagline_ar || null,
        tagline_ku: s.tagline_ku || null,
        description_en: s.description_en || null,
        description_ar: s.description_ar || null,
        description_ku: s.description_ku || null,
      }));

      standaloneProducts = (Array.isArray(standaloneData.products) ? standaloneData.products : []).map(
        (p) => {
          const name = standaloneNameByOrgId.get(p.orgId) || null;
          return {
            orgId: p.orgId,
            engineId: p.engineId,
            sku: p.sku,
            name_en: p.name_en,
            name_ar: p.name_ar,
            description_en: p.description_en ?? null,
            description_ar: p.description_ar ?? null,
            brandName: p.brandName ?? null,
            categoryEngineIds: Array.isArray(p.categoryEngineIds) ? p.categoryEngineIds : [],
            categoryKeys: Array.isArray(p.categoryKeys) ? p.categoryKeys : [],
            categories: Array.isArray(p.categories) ? p.categories : [],
            categoryEngineId: p.categoryEngineId ?? null,
            categoryName_en: p.categoryName_en ?? null,
            categoryName_ar: p.categoryName_ar ?? null,
            displayPrice: p.displayPrice,
            currencyName: p.currencyName ?? null,
            isFeatured: Boolean(p.isFeatured),
            availabilityBadge: p.availabilityBadge,
            imageUrl: p.imageUrl ?? null,
            galleryImageUrls: Array.isArray(p.galleryImageUrls) ? p.galleryImageUrls : [],
            storeName_en: name,
            storeName_ar: name,
            storeName_ku: name,
          };
        },
      );

      // Categories are a global, non-per-org taxonomy (marketplace_category_definitions,
      // synced once by marketplaceSync.ts) — identical data regardless of
      // which discovery endpoint returned it, so it is used only if the
      // pharmacy path above returned none (never concatenated/duplicated).
      standaloneCategories = Array.isArray(standaloneData.categories) ? standaloneData.categories : [];
      standaloneHasMoreProducts = standaloneData.hasMoreProducts === true;
    } else {
      console.error(
        "[getActiveMarketplaceStores] Standalone Commerce Bridge returned status:",
        standaloneResponse.status,
      );
    }
  } catch (err) {
    console.error(
      "[getActiveMarketplaceStores] network error reaching Standalone Commerce Bridge:",
      err,
    );
  }

  const mergedStores = [...stores, ...standaloneStores].slice(0, resultLimit);
  const mergedProducts = [...products, ...standaloneProducts];
  const mergedCategories = categories.length > 0 ? categories : standaloneCategories;
  const mergedHasMoreProducts = hasMoreProducts || standaloneHasMoreProducts;

  return {
    stores: mergedStores,
    products: mergedProducts,
    categories: mergedCategories,
    hasMoreProducts: mergedHasMoreProducts,
  };
});
