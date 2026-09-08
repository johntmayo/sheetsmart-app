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

test('matches by normalized situs regardless of APN metadata', () => {
  const plan = planAddressIntake(
    [incoming({ APN: 'p-200', House: '20', Street: 'Pine Rd', Unit: '2', ZIP: '90002' })],
    master
  );

  assert.strictEqual(plan.matches[0].tier, 'normalized_situs');
  assert.strictEqual(plan.matches[0].addressId, 'A-200');
  assert.strictEqual(plan.matches[0].riskGroup, 'exact_situs');
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
  assert.strictEqual(plan.matches[0].tier, 'normalized_situs');
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

test('blocks an incoming address_id attached to different street addresses', () => {
  const plan = planAddressIntake(
    [
      incoming({ address_id: 'NEW-1', House: '30' }),
      incoming({ address_id: ' new-1 ', House: '31', Street: 'Cedar Road' }),
    ],
    master
  );

  assert.strictEqual(plan.blocked.length, 2);
  assert.ok(plan.blocked.every((item) => item.code === 'conflicting_identity'));
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

test('does not use APN alone as identity and blocks ambiguous exact situs matches', () => {
  const duplicateParcel = [
    ...master,
    { ...master[1], address_id: 'A-201' },
  ];
  const byApn = planAddressIntake(
    [incoming({ APN: 'P-200', House: '99', Street: 'Other St', ZIP: '90009' })],
    duplicateParcel
  );
  assert.strictEqual(byApn.blocked.length, 0);
  assert.strictEqual(byApn.placeholders.length, 1);

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

test('identical coordinates alone do not create review candidates', () => {
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
    master
  );

  assert.strictEqual(plan.matches.length, 0);
  assert.strictEqual(plan.review.length, 0);
  assert.strictEqual(plan.placeholders.length, 1);
});

test('distinct addresses with exactly identical coordinates proceed as new addresses', () => {
  const sharedPin = { Latitude: 34.19949, Longitude: -118.1 };
  const existing = [
    {
      address_id: 'UNIT-A',
      House: '100',
      Street: 'Shared Pin Lane',
      Unit: 'A',
      City: 'Altadena',
      State: 'CA',
      ZIP: '91001',
      ...sharedPin,
    },
  ];
  const plan = planAddressIntake(
    [
      incoming({
        House: '100',
        Street: 'Shared Pin Lane',
        Unit: 'B',
        City: 'Altadena',
        State: 'CA',
        ZIP: '91001',
        ...sharedPin,
      }),
    ],
    existing
  );

  assert.strictEqual(plan.review.length, 0);
  assert.strictEqual(plan.placeholders.length, 1);
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
    { fuzzyThreshold: 0.7 }
  );

  assert.strictEqual(plan.matches.length, 0);
  assert.strictEqual(plan.placeholders.length, 0);
  assert.strictEqual(plan.review[0].riskGroups.includes('fuzzy_situs'), true);
  assert.strictEqual(plan.review[0].candidates[0].addressId, 'A-100');
  assert.ok((plan.review[0].candidates[0].similarity || 0) >= 0.7);
});

test('does not treat different house numbers on the same street as fuzzy matches', () => {
  const existing = Array.from({ length: 30 }, (_, index) => ({
    address_id: `CONCHA-${index}`,
    APN: `PARCEL-${index}`,
    House: String(430 + index * 2),
    Street: 'Concha Street',
    City: 'Altadena',
    State: 'CA',
    ZIP: '91001',
    Latitude: 34.2 + index * 0.0005,
    Longitude: -118.1,
  }));
  const plan = planAddressIntake(
    [
      incoming({
        House: '477',
        Street: 'Concha St',
        City: 'Altadena',
        State: 'CA',
        ZIP: '91001',
        Latitude: 34.19949,
        Longitude: -118.1,
      }),
    ],
    existing
  );

  assert.strictEqual(plan.review.length, 0);
  assert.strictEqual(plan.placeholders.length, 1);
});

test('does not hold back neighboring houses based only on map points ten metres apart', () => {
  const plan = planAddressIntake(
    [incoming({ House: '102', Street: 'Maple Street', Latitude: 34, Longitude: -118 })],
    [
      {
        ...master[0],
        House: '100',
        Direction: '',
        Street: 'Maple Street',
        ZIP: '90003',
        Latitude: 34.00009,
        Longitude: -118,
      },
    ]
  );

  assert.strictEqual(plan.review.length, 0);
  assert.strictEqual(plan.placeholders.length, 1);
});

test('limits review output to the five most plausible fuzzy situs candidates', () => {
  const fuzzyCandidates = Array.from({ length: 12 }, (_, index) => ({
    address_id: `FUZZY-${index}`,
    APN: `FUZZY-PARCEL-${index}`,
    House: '30',
    Street: `Cedar Avenu${index}`,
    City: 'Springfield',
    State: 'CA',
    ZIP: '90003',
    Latitude: 34 + index * 0.01,
    Longitude: -118,
  }));
  const plan = planAddressIntake(
    [incoming({ House: '30', Street: 'Cedar Avenue' })],
    fuzzyCandidates
  );

  assert.strictEqual(plan.review.length, 1);
  assert.strictEqual(plan.review[0].candidates.length, 5);
  assert.match(plan.review[0].reason, /similar street name/i);
});

test('reviews punctuation-equivalent house and unit identifiers', () => {
  const plan = planAddressIntake(
    [
      incoming({
        House: '10-A',
        Direction: 'North',
        Street: 'Maplee Street',
        Unit: '2-A',
        ZIP: '90001',
      }),
    ],
    [
      {
        ...master[0],
        House: '10A',
        Street: 'Maple Street',
        Unit: '2A',
      },
    ]
  );

  assert.strictEqual(plan.placeholders.length, 0);
  assert.strictEqual(plan.review[0].candidates[0].addressId, 'A-100');
});

test('reviews punctuation-equivalent identifiers even when street spelling is identical', () => {
  const plan = planAddressIntake(
    [
      incoming({
        House: '10-A',
        Direction: 'North',
        Street: 'Maple Street',
        Unit: '2-A',
        ZIP: '90001',
      }),
    ],
    [{ ...master[0], House: '10A', Street: 'Maple Street', Unit: '2A' }]
  );

  assert.strictEqual(plan.placeholders.length, 0);
  assert.strictEqual(plan.review[0].candidates[0].addressId, 'A-100');
});

test('reviews a matching street base when one source omits the suffix', () => {
  const plan = planAddressIntake(
    [incoming({ House: '10', Direction: 'North', Street: 'Maple', ZIP: '90001' })],
    [{ ...master[0], Street: 'Maple Street' }]
  );

  assert.strictEqual(plan.placeholders.length, 0);
  assert.strictEqual(plan.review[0].candidates[0].addressId, 'A-100');
});

test('does not conflate fractional and unseparated numeric identifiers', () => {
  const plan = planAddressIntake(
    [incoming({ House: '12 1/2', Street: 'Maplee Street', ZIP: '90001' })],
    [{ ...master[0], House: '1212', Direction: '', Street: 'Maple Street' }]
  );

  assert.strictEqual(plan.review.length, 0);
  assert.strictEqual(plan.placeholders.length, 1);
});

test('does not fuzzy-match different recognized street suffixes', () => {
  const plan = planAddressIntake(
    [incoming({ House: '10', Street: 'Maple Street', ZIP: '90001' })],
    [{ ...master[0], Street: 'Maple Drive' }]
  );

  assert.strictEqual(plan.review.length, 0);
  assert.strictEqual(plan.placeholders.length, 1);
});

test('includes coordinate distance as supporting context on fuzzy situs candidates', () => {
  const plan = planAddressIntake(
    [
      incoming({
        House: '10',
        Direction: 'N',
        Street: 'Oaks St',
        City: 'Springfield',
        ZIP: '90001',
        Latitude: 34.0001,
        Longitude: -118.0001,
      }),
    ],
    master,
    [],
    { fuzzyThreshold: 0.7 }
  );

  assert.strictEqual(plan.review.length, 1);
  assert.strictEqual(plan.review[0].candidates[0].addressId, 'A-100');
  assert.deepStrictEqual(plan.review[0].candidates[0].reasons, ['fuzzy_situs']);
  assert.ok(plan.review[0].candidates[0].distanceMeters !== undefined);
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

test('preserves source capitalization in rows prepared for the master', () => {
  const plan = planAddressIntake(
    [
      incoming({
        House: '477',
        Street: 'Fair Oaks Ave',
        City: 'Altadena',
        State: 'CA',
        ZIP: '91001',
      }),
    ],
    []
  );

  assert.strictEqual(plan.placeholders[0].house, '477');
  assert.strictEqual(plan.placeholders[0].street, 'Fair Oaks Ave');
  assert.strictEqual(plan.placeholders[0].city, 'Altadena');
  assert.strictEqual(plan.placeholders[0].state, 'CA');
  assert.strictEqual(plan.placeholders[0].zip, '91001');
});

test('fingerprints change with identity-affecting input and ignore blank external rows', () => {
  const base = planAddressIntake([incoming({ House: '30' }), {}], master);
  const changed = planAddressIntake([incoming({ House: '31' }), {}], master);

  assert.notStrictEqual(base.fingerprint, changed.fingerprint);
  assert.strictEqual(base.placeholders.length, 1);
  assert.strictEqual(base.blocked.length, 0);
});

test('allows distinct incoming addresses to share one APN', () => {
  const plan = planAddressIntake(
    [
      incoming({ APN: 'NEW-1', House: '31' }),
      incoming({ APN: 'NEW-1', House: '33' }),
    ],
    master
  );
  assert.strictEqual(plan.blocked.length, 0);
  assert.strictEqual(plan.placeholders.length, 2);
});

test('combines repeated incoming situs rows into one placeholder', () => {
  const plan = planAddressIntake(
    [
      incoming({ address_id: 'NEW-A', APN: '', Street: 'Cedar Avenue' }),
      incoming({ address_id: 'NEW-B', APN: '', Street: 'CEDAR AVE.' }),
    ],
    master
  );
  assert.strictEqual(plan.blocked.length, 0);
  assert.strictEqual(plan.placeholders.length, 1);
  assert.strictEqual(plan.coalescedSourceRows, 1);
  assert.deepStrictEqual(plan.placeholders[0].provenance_rows, [2, 3]);
});

test('combines the same source ID and situs instead of rejecting both rows', () => {
  const plan = planAddressIntake(
    [
      incoming({ address_id: 'SOURCE-1', APN: 'PARCEL-A' }),
      incoming({ address_id: 'SOURCE-1', APN: 'PARCEL-B', Latitude: 34.5, Longitude: -118.2 }),
    ],
    []
  );

  assert.strictEqual(plan.blocked.length, 0);
  assert.strictEqual(plan.placeholders.length, 1);
  assert.deepStrictEqual(plan.placeholders[0].provenance_rows, [2, 3]);
});

test('does not let a later coalesced row hide an ID belonging to another address', () => {
  const rows = [
    incoming({ address_id: 'NEW-SOURCE', House: '30', Street: 'Cedar Avenue' }),
    incoming({ address_id: 'A-100', House: '30', Street: 'Cedar Avenue' }),
  ];
  for (const ordered of [rows, [...rows].reverse()]) {
    const plan = planAddressIntake(ordered, master);
    assert.strictEqual(plan.placeholders.length, 0);
    assert.ok(plan.blocked.some((item) => item.code === 'conflicting_identity'));
  }
});

test('uses complete coordinates from a later copy of the same source address', () => {
  const plan = planAddressIntake(
    [
      incoming({ address_id: 'SOURCE-A', Latitude: '', Longitude: '' }),
      incoming({ address_id: 'SOURCE-B', Latitude: 34.25, Longitude: -118.15 }),
    ],
    []
  );

  assert.strictEqual(plan.placeholders.length, 1);
  assert.strictEqual(plan.placeholders[0].latitude, 34.25);
  assert.strictEqual(plan.placeholders[0].longitude, -118.15);
});

test('generates the same new ID when APN coordinates or source ID change', () => {
  const first = planAddressIntake(
    [incoming({ address_id: 'SOURCE-A', APN: 'PARCEL-A', Latitude: 34, Longitude: -118 })],
    []
  );
  const second = planAddressIntake(
    [incoming({ address_id: 'SOURCE-B', APN: 'PARCEL-B', Latitude: 34.01, Longitude: -118.01 })],
    []
  );

  assert.strictEqual(first.placeholders[0].address_id, second.placeholders[0].address_id);
});

test('keeps different units on a shared APN as distinct addresses', () => {
  const plan = planAddressIntake(
    [
      incoming({ APN: 'SHARED-PARCEL', House: '40', Unit: '1' }),
      incoming({ APN: 'SHARED-PARCEL', House: '40', Unit: '2' }),
    ],
    []
  );

  assert.strictEqual(plan.blocked.length, 0);
  assert.strictEqual(plan.placeholders.length, 2);
  assert.notStrictEqual(plan.placeholders[0].address_id, plan.placeholders[1].address_id);
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
  assert.match(badFuzzy.errors[0], /fuzzyThreshold/i);
  assert.strictEqual(badFuzzy.placeholders.length, 0);
});
