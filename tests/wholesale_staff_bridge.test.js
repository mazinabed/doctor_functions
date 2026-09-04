'use strict';

/**
 * Healthcare -> Commerce bridge: Wholesale staff permissions.
 *
 * resolveAccessContext.js resolved PHARMACY staff only, which its own header
 * described as deliberate — "owner-only for now ... no lab_members/center
 * members staff-delegation query added here yet, since no live Commerce
 * caller exercises that path". Wholesale is that caller: a medical centre and
 * a laboratory employee must be grantable procurement authority exactly as a
 * pharmacy employee can, from the same three keys.
 *
 * These are pure unit tests of the projection — the same convention
 * resolve_verified_phone_number.test.js uses for this file's other exported
 * decision. WHICH permissions cross the bridge is the security property, so
 * it is asserted directly.
 */

const {
  resolveWholesalePermissions,
} = require('../functions/commerce/resolveAccessContext');

describe('resolveWholesalePermissions — the projection', () => {
  test('B-1 a member with no permissions array gets nothing', () => {
    expect(resolveWholesalePermissions({})).toEqual([]);
    expect(resolveWholesalePermissions({ permissions: null })).toEqual([]);
    expect(resolveWholesalePermissions(undefined)).toEqual([]);
  });

  test('B-2 access alone crosses as access alone', () => {
    expect(resolveWholesalePermissions({ permissions: ['wholesale_access'] }))
      .toEqual(['wholesale_access']);
  });

  test('B-3 all three cross when all three are held', () => {
    expect(
      resolveWholesalePermissions({
        permissions: [
          'wholesale_orders_create',
          'wholesale_access',
          'wholesale_orders_view',
        ],
      }),
    ).toEqual([
      'wholesale_access',
      'wholesale_orders_view',
      'wholesale_orders_create',
    ]);
  });

  test('B-4 a child WITHOUT access crosses as nothing — fail closed', () => {
    // A hand-edited or older member document must not produce a half-granted
    // set Commerce would have to interpret. Commerce re-applies this same
    // rule, so neither side depends on the other having done it.
    expect(
      resolveWholesalePermissions({
        permissions: ['wholesale_orders_view', 'wholesale_orders_create'],
      }),
    ).toEqual([]);
  });

  test('B-5 create without view is preserved exactly', () => {
    // The two are independently grantable; the bridge must not "helpfully"
    // add view.
    expect(
      resolveWholesalePermissions({
        permissions: ['wholesale_access', 'wholesale_orders_create'],
      }),
    ).toEqual(['wholesale_access', 'wholesale_orders_create']);
  });
});

describe('minimum data exchange', () => {
  test('B-6 no non-Wholesale permission ever crosses', () => {
    // The member's full permissions array must never reach Commerce — only
    // the wholesale_* subset, exactly as pharmacyStaffStoreAccess already
    // limits itself to one boolean.
    const result = resolveWholesalePermissions({
      permissions: [
        'wholesale_access',
        'store_access',
        'billing',
        'reception',
        'team_management',
        'clinical_tasks',
        'orders_fulfillment',
        'pharmacy_settings',
      ],
    });
    expect(result).toEqual(['wholesale_access']);
    for (const forbidden of [
      'store_access',
      'billing',
      'reception',
      'team_management',
      'clinical_tasks',
      'orders_fulfillment',
      'pharmacy_settings',
    ]) {
      expect(result).not.toContain(forbidden);
    }
  });

  test('B-7 Store access alone crosses as no Wholesale authority', () => {
    // Store and Wholesale are independent grants; holding one is never
    // holding the other.
    expect(resolveWholesalePermissions({ permissions: ['store_access'] }))
      .toEqual([]);
  });

  test('B-8 an unknown wholesale-looking key is ignored', () => {
    expect(
      resolveWholesalePermissions({
        permissions: ['wholesale_access', 'wholesale_orders_delete'],
      }),
    ).toEqual(['wholesale_access']);
  });
});
