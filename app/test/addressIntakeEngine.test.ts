import test from 'node:test';
import assert from 'node:assert';
import {
  normalizeSitus,
  planAddressIntake,
  type AddressRow,
} from '../src/lib/addressIntakeEngine';

const master: AddressRow[] = [
  {
    address_id: 'A-100',
    APN: 'P-100',
    House: '10',
    Direction: 'North',
    Street: 'Oak Street',
    Unit: '',
    City: 'Springfield',
    State: 'CA',
    ZIP: '90001',
    Latitude: 34,
    Longitude: -118,
  },
  {
    address_id: 'A-200',
    APN: 'P-200',
    House: '20',
    Direction: '',
    Street: 'Pine Road',
    Unit: 'Unit 2',
    City: 'Springfield',
    State: 'CA',
    ZIP: '90002',
    Latitude: 34.01,
    Longitude: -118.01,
  },
];

function incoming(overrides: AddressRow = {}): AddressRow {
  return {
    address_id: '',
    APN: '',
    House: '30',
    Direction: '',
    Street: 'Cedar Avenue',
    Unit: '',
    City: 'Springfield',
    State: 'CA',
    ZIP: '90003',
    Latitude: '',
    Longitude: '',
    ...overrides,
  };
}

test('matches by exact address_id first and adopts its canonical spelling', () => {
  const plan = planAddressIntake(
    [incoming({ address_id: ' a-100 ', APN: '', House: '10', Direction: 'N', Street: 'Oak St', ZIP: '90001' })],
    master
  );

  assert.deepStrictEqual(plan.errors, []);
  assert.strictEqual(plan.matches.length, 1);
  assert.strictEqual(plan.matches[0].tier, 'address_id');
  assert.strictEqual(plan.matches[0].addressId, 'A-100');
  assert.strictEqual(plan.matches[0].riskGroup, 'exact_identity');
  assert.deepStrictEqual(plan.matches[0].canonical.provenance, [{ dataset: 'master', row: 1 }]);
  assert.strictEqual(plan.placeholders.length, 0);
});

test('matches by APN before normalized situs and adopts the existing ID', () => {
  const plan = planAddressIntake(
    [incoming({ APN: 'p-200', House: '20', Street: 'Pine Rd', Unit: '2', ZIP: '90002' })],
    master
  );

  assert.strictEqual(plan.matches[0].tier, 'apn');
  assert.strictEqual(plan.matches[0].addressId, 'A-200');
  assert.strictEqual(plan.matches[0].riskGroup, 'exact_parcel');
});

test('matches normalized situs across direction, suffix, unit, punctuation, and ZIP+4 variants', () => {
  const plan = planAddressIntake(
    [
      incoming({
        House: '20',
        Direction: '',
        Street: 'Pine Rd.',
        Unit: 'Apt 2',
        ZIP: '90002-1234',
      }),
    ],
    master
  );

  assert.strictEqual(plan.matches[0].tier, 'normalized_situs');
  assert.strictEqual(plan.matches[0].addressId, 'A-200');
  assert.strictEqual(plan.matches[0].riskGroup, 'exact_situs');
});

test('normalization retains all situs components in identity order', () => {
  assert.strictEqual(
    normalizeSitus({
      house: ' 10 ',
      direction: 'North',
      street: 'Oak Street.',
      unit: 'Suite 4',
      city: 'St. Louis',
      state: 'mo',
      zip: '63101-1234',
    }),
    '10|N|OAK ST|4|ST LOUIS|MO|63101'
  );
});

test('uses independently configurable headers for all three datasets', () => {
  const customMaster = [
    {
      MasterKey: 'M1',
      Parcel: '55-X',
      Number: '55',
      Road: 'Lake Boulevard',
      Town: 'Reno',
      Province: 'NV',
      Postal: '89501',
    },
  ];
  const customCaptain = [
    {
      CaptainKey: 'C1',
      CaptainParcel: '66-X',
      Number: '66',
      Road: 'Hill Street',
      Town: 'Reno',
      Province: 'NV',
      Postal: '89502',
    },
  ];
  const plan = planAddressIntake(
    [
      {
        IncomingKey: '',
        ParcelNo: '66-X',
        Civic: '66',
        RoadName: 'Hill St',
        Municipality: 'Reno',
        Region: 'NV',
        PostalCode: '89502',
      },
    ],
    customMaster,
    customCaptain,
    {
      externalHeaders: {
        addressId: 'IncomingKey',
        apn: 'ParcelNo',
        house: 'Civic',
        street: 'RoadName',
        city: 'Municipality',
        state: 'Region',
        zip: 'PostalCode',
      },
      masterHeaders: {
        addressId: 'MasterKey',
        apn: 'Parcel',
        house: 'Number',
        street: 'Road',
        city: 'Town',
        state: 'Province',
        zip: 'Postal',
      },
      captainHeaders: {
        addressId: 'CaptainKey',
        apn: 'CaptainParcel',
        house: 'Number',
        street: 'Road',
        city: 'Town',
        state: 'Province',
        zip: 'Postal',
      },
    }
  );

  assert.strictEqual(plan.matches[0].addressId, 'C1');
  assert.strictEqual(plan.matches[0].tier, 'apn');
  assert.deepStrictEqual(plan.matches[0].canonical.provenance, [{ dataset: 'captain', row: 1 }]);
});

test('blocks contradictory exact identity evidence instead of trusting tier order', () => {
  const plan = planAddressIntake(
    [incoming({ address_id: 'A-100', APN: 'P-200', House: '20', Street: 'Pine Rd', Unit: '2', ZIP: '90002' })],
    master
  );

  assert.strictEqual(plan.matches.length, 0);
  assert.strictEqual(plan.blocked[0].code, 'conflicting_identity');
  assert.deepStrictEqual(plan.blocked[0].conflictingAddressIds, ['A-100', 'A-200']);
});

test('blocks canonical adoption when master and captain disagree on one existing identity', () => {
  const captain = [
    {
      ...master[0],
      APN: 'DIFFERENT-PARCEL',
      House: '11',
    },
  ];
  const plan = planAddressIntake(
    [incoming({ address_id: 'A-100', House: '10', Direction: 'N', Street: 'Oak St', ZIP: '90001' })],
    master,
    captain
  );

  assert.strictEqual(plan.matches.length, 0);
  assert.strictEqual(plan.blocked[0].code, 'conflicting_identity');
  assert.match(plan.blocked[0].reason, /master\/captain records/i);
});

test('blocks every occurrence of a duplicate incoming address_id', () => {
  const plan = planAddressIntake(
    [
      incoming({ address_id: 'NEW-1', House: '30' }),
      incoming({ address_id: ' new-1 ', House: '31', Street: 'Cedar Road' }),
    ],
    master
  );

  assert.strictEqual(plan.blocked.length, 2);
  assert.ok(plan.blocked.every((item) => item.code === 'duplicate_incoming_id'));
  assert.strictEqual(plan.placeholders.length, 0);
});

test('blocks missing required fields and supports an explicit required-field policy', () => {
  const missingDefault = planAddressIntake([incoming({ Street: '' })], master);
  assert.strictEqual(missingDefault.blocked[0].code, 'missing_required_fields');
  assert.match(missingDefault.blocked[0].reason, /street/);

  const relaxed = planAddressIntake(
    [incoming({ Street: '', APN: 'BRAND-NEW' })],
    master,
    [],
    { requiredFields: ['apn', 'city', 'state'] }
  );
  assert.strictEqual(relaxed.blocked.length, 0);
  assert.strictEqual(relaxed.placeholders.length, 1);
});

test('blocks ambiguous exact APN and exact situs matches', () => {
  const duplicateParcel = [
    ...master,
    { ...master[1], address_id: 'A-201' },
  ];
  const byApn = planAddressIntake(
    [incoming({ APN: 'P-200', House: '99', Street: 'Other St', ZIP: '90009' })],
    duplicateParcel
  );
  assert.strictEqual(byApn.blocked[0].code, 'ambiguous_match');
  assert.deepStrictEqual(byApn.blocked[0].conflictingAddressIds, ['A-200', 'A-201']);

  const duplicateSitus = [
    master[0],
    { ...master[0], address_id: 'A-101', APN: 'P-101' },
  ];
  const bySitus = planAddressIntake(
    [incoming({ House: '10', Direction: 'N', Street: 'Oak St', ZIP: '90001' })],
    duplicateSitus
  );
  assert.strictEqual(bySitus.blocked[0].code, 'ambiguous_match');
});

test('near coordinates are review-only and never automatically adopt an ID', () => {
  const plan = planAddressIntake(
    [
      incoming({
        House: '999',
        Street: 'Remote Way',
        ZIP: '90009',
        Latitude: 34.0001,
        Longitude: -118.0001,
      }),
    ],
    master,
    [],
    { nearCoordinateMeters: 25 }
  );

  assert.strictEqual(plan.matches.length, 0);
  assert.strictEqual(plan.placeholders.length, 0);
  assert.strictEqual(plan.review.length, 1);
  assert.strictEqual(plan.review[0].candidates[0].addressId, 'A-100');
  assert.ok(plan.review[0].candidates[0].reasons.includes('near_coordinate'));
  assert.ok((plan.review[0].candidates[0].distanceMeters || Infinity) < 25);
});

test('fuzzy situs candidates are review-only and expose similarity risk', () => {
  const plan = planAddressIntake(
    [
      incoming({
        House: '10',
        Direction: 'N',
        Street: 'Oaks St',
        City: 'Springfield',
        ZIP: '90001',
      }),
    ],
    master,
    [],
    { fuzzyThreshold: 0.9 }
  );

  assert.strictEqual(plan.matches.length, 0);
  assert.strictEqual(plan.placeholders.length, 0);
  assert.strictEqual(plan.review[0].riskGroups.includes('fuzzy_situs'), true);
  assert.strictEqual(plan.review[0].candidates[0].addressId, 'A-100');
  assert.ok((plan.review[0].candidates[0].similarity || 0) >= 0.9);
});

test('produces explicit deterministic placeholders with provenance and bounded batches', () => {
  const rows = [
    incoming({ address_id: 'EXT-1', House: '30' }),
    incoming({ address_id: 'EXT-2', House: '31' }),
    incoming({ address_id: 'EXT-3', House: '32' }),
  ];
  const first = planAddressIntake(rows, master, [], { maxBatchSize: 2 });
  const again = planAddressIntake(rows.map((row) => ({ ...row })), master, [], { maxBatchSize: 2 });

  assert.strictEqual(first.placeholders.length, 3);
  assert.deepStrictEqual(first.batches.map((batch) => batch.length), [2, 1]);
  const placeholder = first.placeholders[0];
  assert.match(placeholder.address_id, /^ADDRESS-PLACEHOLDER-[A-F0-9]{20}$/);
  assert.strictEqual(placeholder.record_type, 'address_placeholder');
  assert.strictEqual(placeholder.provenance_dataset, 'external');
  assert.strictEqual(placeholder.provenance_row, 2);
  assert.strictEqual(placeholder.provenance_input_address_id, 'EXT-1');
  assert.strictEqual(placeholder.risk_group, 'new_address');
  assert.match(placeholder.fingerprint, /^[a-f0-9]{64}$/);
  assert.strictEqual(first.fingerprint, again.fingerprint);
  assert.deepStrictEqual(
    first.placeholders.map((item) => item.address_id),
    again.placeholders.map((item) => item.address_id)
  );
});

test('fingerprints change with identity-affecting input and ignore blank external rows', () => {
  const base = planAddressIntake([incoming({ House: '30' }), {}], master);
  const changed = planAddressIntake([incoming({ House: '31' }), {}], master);

  assert.notStrictEqual(base.fingerprint, changed.fingerprint);
  assert.strictEqual(base.placeholders.length, 1);
  assert.strictEqual(base.blocked.length, 0);
});

test('blocks every repeated incoming APN before generating placeholders', () => {
  const plan = planAddressIntake(
    [
      incoming({ APN: 'NEW-1', House: '31' }),
      incoming({ APN: 'NEW-1', House: '33' }),
    ],
    master
  );
  assert.strictEqual(plan.blocked.length, 2);
  assert.strictEqual(plan.placeholders.length, 0);
  assert.ok(plan.blocked.every((item) => item.reason.includes('APN NEW-1')));
});

test('blocks every repeated normalized incoming situs before generating placeholders', () => {
  const plan = planAddressIntake(
    [
      incoming({ address_id: 'NEW-A', APN: '', Street: 'Cedar Avenue' }),
      incoming({ address_id: 'NEW-B', APN: '', Street: 'CEDAR AVE.' }),
    ],
    master
  );
  assert.strictEqual(plan.blocked.length, 2);
  assert.strictEqual(plan.placeholders.length, 0);
  assert.ok(plan.blocked.every((item) => item.reason.includes('normalized street address')));
});

test('ranks a relevant fuzzy candidate before the review cap', () => {
  const distractors: AddressRow[] = Array.from({ length: 201 }, (_, index) => ({
    address_id: `A-${String(index).padStart(3, '0')}`,
    House: '44',
    Street: `Oak ${index}`,
    City: 'Springfield',
    State: 'CA',
    ZIP: '90003',
  }));
  const relevant: AddressRow = {
    address_id: 'Z-RELEVANT',
    House: '44',
    Street: 'Cedar Avenue',
    City: 'Springfield',
    State: 'CA',
    ZIP: '90003',
  };
  const plan = planAddressIntake(
    [incoming({ House: '44', Street: 'Cedar Aveneu', ZIP: '90003' })],
    [...distractors, relevant]
  );
  assert.strictEqual(plan.placeholders.length, 0);
  assert.ok(plan.review[0].candidates.some((candidate) => candidate.addressId === 'Z-RELEVANT'));
});

test('invalid batching and review thresholds return errors without planning output', () => {
  const badBatch = planAddressIntake([incoming()], master, [], { maxBatchSize: 0 });
  assert.match(badBatch.errors[0], /positive integer/);
  assert.strictEqual(badBatch.placeholders.length, 0);

  const badFuzzy = planAddressIntake([incoming()], master, [], { fuzzyThreshold: 2 });
  assert.match(badFuzzy.errors[0], /threshold/i);
  assert.strictEqual(badFuzzy.placeholders.length, 0);
});
