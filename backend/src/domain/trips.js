import {
  adjustRemainder,
  assertSafePaise,
  createRoundingMetadata,
  legacyNumberToPaise,
  parseDecimalToPaise,
  sumPaise,
} from './money.js';

export const LEGACY_SETTLEMENT_PREFIX = '↔ Settlement: ';

const RECORD_KINDS = new Set(['shared_expense', 'settlement_payment']);

class TripInputError extends Error {
  constructor({ code, field, constraint, recordId, memberId, message }) {
    super(message);
    this.name = 'TripInputError';
    this.issue = {
      code,
      field,
      constraint,
      ...(recordId === undefined ? {} : { recordId }),
      ...(memberId === undefined ? {} : { memberId }),
      message,
    };
  }
}

function invalid(details) {
  throw new TripInputError(details);
}

function money(amountMinor) {
  return { currency: 'INR', amountMinor };
}

function sourceMetadata(record) {
  return {
    ...(record.confirmedAt === undefined ? {} : { confirmedAt: record.confirmedAt }),
    ...(record.updatedAt === undefined ? {} : { updatedAt: record.updatedAt }),
    ...(record.createdAt === undefined ? {} : { createdAt: record.createdAt }),
  };
}

function storedSourceMetadata(record) {
  return {
    ...(record.updated_at === undefined ? {} : { updatedAt: record.updated_at }),
    ...(record.created_at === undefined ? {} : { createdAt: record.created_at }),
  };
}

function assertRecordId(id, field, recordId) {
  if (!Number.isSafeInteger(id) || id <= 0) {
    invalid({
      code: 'INVALID_RECORD_ID',
      field,
      constraint: 'a positive safe integer record ID',
      recordId,
      message: `${field} must be a positive safe integer record ID.`,
    });
  }
  return id;
}

function assertMemberId(id, field, recordId) {
  if (!Number.isSafeInteger(id) || id <= 0) {
    invalid({
      code: 'INVALID_MEMBER_ID',
      field,
      constraint: 'a positive safe integer member ID',
      recordId,
      message: `${field} must identify a confirmed trip member.`,
    });
  }
  return id;
}

function normalizeMembers(members) {
  if (!Array.isArray(members)) {
    invalid({
      code: 'MISSING_MEMBERS',
      field: 'members',
      constraint: 'an array of confirmed trip members',
      message: 'members must contain the confirmed trip members.',
    });
  }

  const seenIds = new Set();
  const seenNames = new Set();
  const normalized = members.map((member, index) => {
    if (!member || typeof member !== 'object' || Array.isArray(member)) {
      invalid({
        code: 'INVALID_MEMBER',
        field: `members[${index}]`,
        constraint: 'a trip member record',
        message: `members[${index}] must be a trip member record.`,
      });
    }
    const id = assertMemberId(member.id, `members[${index}].id`);
    if (seenIds.has(id)) {
      invalid({
        code: 'DUPLICATE_MEMBER_ID',
        field: `members[${index}].id`,
        constraint: 'a unique member ID',
        memberId: id,
        message: 'members must not contain duplicate member IDs.',
      });
    }
    seenIds.add(id);

    let name;
    if (member.name !== undefined) {
      if (typeof member.name !== 'string' || member.name.trim().length === 0) {
        invalid({
          code: 'INVALID_MEMBER_NAME',
          field: `members[${index}].name`,
          constraint: 'a nonblank member name when provided',
          memberId: id,
          message: `members[${index}].name must contain a non-whitespace character.`,
        });
      }
      name = member.name;
      if (seenNames.has(name)) {
        invalid({
          code: 'DUPLICATE_MEMBER_NAME',
          field: `members[${index}].name`,
          constraint: 'a unique stored member name',
          memberId: id,
          message: 'Stored member names must be unique for payer-name compatibility.',
        });
      }
      seenNames.add(name);
    }

    return {
      id,
      ...(name === undefined ? {} : { name }),
    };
  });

  normalized.sort((left, right) => left.id - right.id);
  return normalized.map((member, order) => ({ ...member, order }));
}

function buildMemberMaps(members) {
  const byId = new Map(members.map((member) => [member.id, member]));
  const byName = new Map(
    members
      .filter((member) => member.name !== undefined)
      .map((member) => [member.name, member])
  );
  return { byId, byName };
}

function canonicalAmount(value, field, recordId) {
  try {
    assertSafePaise(value, { allowNegative: false, label: field });
  } catch (error) {
    invalid({
      code: 'INVALID_TRIP_AMOUNT',
      field,
      constraint: 'a non-negative safe integer number of paise',
      recordId,
      message: error.message,
    });
  }
  if (value <= 0) {
    invalid({
      code: 'INVALID_TRIP_AMOUNT',
      field,
      constraint: 'an amount greater than zero paise',
      recordId,
      message: `${field} must be greater than zero.`,
    });
  }
  return value;
}

function legacyAmount(value, field, recordId) {
  try {
    const amountMinor = typeof value === 'number'
      ? legacyNumberToPaise(value, { label: field })
      : parseDecimalToPaise(value, { label: field });
    return canonicalAmount(amountMinor, field, recordId);
  } catch (error) {
    if (error instanceof TripInputError) throw error;
    invalid({
      code: 'INVALID_TRIP_AMOUNT',
      field,
      constraint: 'a positive amount with at most two decimal places',
      recordId,
      message: error.message,
    });
  }
}

function canonicalWeight(value, field, recordId, memberId) {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid({
      code: 'INVALID_SPLIT_WEIGHT',
      field,
      constraint: 'a non-negative safe integer weight',
      recordId,
      memberId,
      message: `${field} must be a non-negative safe integer weight.`,
    });
  }
  return value;
}

function legacyWeight(value, field, recordId, memberId) {
  try {
    return typeof value === 'number'
      ? legacyNumberToPaise(value, { label: field })
      : parseDecimalToPaise(value, { label: field });
  } catch (error) {
    invalid({
      code: 'INVALID_SPLIT_WEIGHT',
      field,
      constraint: 'a non-negative weight with at most two decimal places',
      recordId,
      memberId,
      message: error.message,
    });
  }
}

function assertKnownMember(memberId, memberMaps, field, recordId) {
  const id = assertMemberId(memberId, field, recordId);
  if (!memberMaps.byId.has(id)) {
    invalid({
      code: 'UNKNOWN_TRIP_MEMBER',
      field,
      constraint: 'the ID of a confirmed trip member',
      recordId,
      memberId: id,
      message: `${field} does not identify a confirmed trip member.`,
    });
  }
  return id;
}

function memberIdForStoredName(name, memberMaps, field, recordId) {
  if (typeof name !== 'string' || name.trim().length === 0) {
    invalid({
      code: 'MISSING_MEMBER_NAME',
      field,
      constraint: 'the exact stored name of a confirmed trip member',
      recordId,
      message: `${field} must contain a stored trip member name.`,
    });
  }
  const member = memberMaps.byName.get(name);
  if (!member) {
    invalid({
      code: 'UNKNOWN_TRIP_MEMBER_NAME',
      field,
      constraint: 'the exact stored name of a confirmed trip member',
      recordId,
      message: `${field} does not match a confirmed trip member.`,
    });
  }
  return member.id;
}

function normalizeMemberWeights(entries, {
  memberMaps,
  recordId,
  field,
  storedNames = false,
}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    invalid({
      code: 'INCOMPLETE_SPLIT',
      field,
      constraint: 'at least one included member with a positive weight',
      recordId,
      message: `${field} must include at least one trip member.`,
    });
  }

  const seen = new Set();
  const weights = entries.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      invalid({
        code: 'INVALID_SPLIT_ENTRY',
        field: `${field}[${index}]`,
        constraint: 'a member and non-negative weight',
        recordId,
        message: `${field}[${index}] must be a split entry.`,
      });
    }

    const memberId = storedNames
      ? memberIdForStoredName(entry.name, memberMaps, `${field}[${index}].name`, recordId)
      : assertKnownMember(
        entry.memberId,
        memberMaps,
        `${field}[${index}].memberId`,
        recordId
      );
    if (seen.has(memberId)) {
      invalid({
        code: 'DUPLICATE_SPLIT_MEMBER',
        field: `${field}[${index}]`,
        constraint: 'one split entry per member',
        recordId,
        memberId,
        message: 'A trip member may appear only once in an expense split.',
      });
    }
    seen.add(memberId);

    const weight = storedNames
      ? legacyWeight(entry.share, `${field}[${index}].share`, recordId, memberId)
      : canonicalWeight(entry.weight, `${field}[${index}].weight`, recordId, memberId);
    return { memberId, weight };
  });

  if (!weights.some(({ weight }) => weight > 0)) {
    invalid({
      code: 'INCOMPLETE_SPLIT',
      field,
      constraint: 'at least one included member with a positive weight',
      recordId,
      message: 'The split must contain at least one positive member weight.',
    });
  }

  return weights.sort(
    (left, right) => memberMaps.byId.get(left.memberId).order
      - memberMaps.byId.get(right.memberId).order
  );
}

function parseStoredSplit(record, recordId) {
  if (record.split !== undefined) {
    if (!Array.isArray(record.split)) {
      invalid({
        code: 'INVALID_SPLIT_JSON',
        field: 'split',
        constraint: 'an array of stored member-name split entries',
        recordId,
        message: 'split must be an array.',
      });
    }
    return record.split;
  }
  if (typeof record.split_json !== 'string') {
    invalid({
      code: 'MISSING_SPLIT_JSON',
      field: 'split_json',
      constraint: 'a JSON array of stored member-name split entries',
      recordId,
      message: 'split_json is required for a stored trip record.',
    });
  }
  try {
    const split = JSON.parse(record.split_json);
    if (!Array.isArray(split)) throw new TypeError('split_json must decode to an array.');
    return split;
  } catch (error) {
    invalid({
      code: 'INVALID_SPLIT_JSON',
      field: 'split_json',
      constraint: 'a valid JSON array of stored member-name split entries',
      recordId,
      message: error.message,
    });
  }
}

function normalizeExplicitRecord(record, memberMaps) {
  const recordId = assertRecordId(record.id, 'record.id', record.id);
  if (!RECORD_KINDS.has(record.kind)) {
    invalid({
      code: 'INVALID_TRIP_RECORD_KIND',
      field: 'kind',
      constraint: 'shared_expense or settlement_payment',
      recordId,
      message: 'kind must be shared_expense or settlement_payment.',
    });
  }
  const amountMinor = canonicalAmount(record.amountMinor, 'amountMinor', recordId);

  if (record.kind === 'settlement_payment') {
    const fromMemberId = assertKnownMember(
      record.fromMemberId,
      memberMaps,
      'fromMemberId',
      recordId
    );
    const toMemberId = assertKnownMember(
      record.toMemberId,
      memberMaps,
      'toMemberId',
      recordId
    );
    if (fromMemberId === toMemberId) {
      invalid({
        code: 'INVALID_SETTLEMENT_MEMBERS',
        field: 'toMemberId',
        constraint: 'a confirmed member other than the paying member',
        recordId,
        memberId: toMemberId,
        message: 'A settlement payment must be made to a different member.',
      });
    }
    return {
      id: recordId,
      kind: 'settlement_payment',
      fromMemberId,
      toMemberId,
      amountMinor,
      ...(record.description === undefined ? {} : { description: record.description }),
      ...sourceMetadata(record),
      sourceBoundary: record.sourceBoundary ?? 'canonical_member_ids',
    };
  }

  const splitType = typeof record.splitRule === 'object'
    ? record.splitRule?.type
    : record.splitRule;
  if ((splitType ?? 'weighted') !== 'weighted') {
    invalid({
      code: 'INVALID_SPLIT_RULE',
      field: 'splitRule',
      constraint: 'the weighted split rule',
      recordId,
      message: 'Only the weighted split rule is supported.',
    });
  }
  const payerMemberId = assertKnownMember(
    record.payerMemberId,
    memberMaps,
    'payerMemberId',
    recordId
  );
  const memberWeights = normalizeMemberWeights(
    record.memberWeights ?? record.splitRule?.weights,
    { memberMaps, recordId, field: 'memberWeights' }
  );
  return {
    id: recordId,
    kind: 'shared_expense',
    payerMemberId,
    amountMinor,
    splitRule: 'weighted',
    memberWeights,
    ...(record.description === undefined ? {} : { description: record.description }),
    ...sourceMetadata(record),
    sourceBoundary: record.sourceBoundary ?? 'canonical_member_ids',
  };
}

function normalizeStoredRecord(record, memberMaps) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    invalid({
      code: 'INVALID_TRIP_RECORD',
      field: 'records',
      constraint: 'trip expense records',
      message: 'Each trip record must be an object.',
    });
  }
  if (record.kind !== undefined) return normalizeExplicitRecord(record, memberMaps);

  const recordId = assertRecordId(record.id, 'record.id', record.id);
  const amountMinor = legacyAmount(record.amount, 'amount', recordId);
  const split = parseStoredSplit(record, recordId);
  const payerMemberId = memberIdForStoredName(record.payer, memberMaps, 'payer', recordId);
  const isSettlement = typeof record.description === 'string'
    && record.description.startsWith(LEGACY_SETTLEMENT_PREFIX);

  if (isSettlement) {
    const positiveRecipients = split.filter((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return true;
      const weight = legacyWeight(entry.share, 'split.share', recordId);
      return weight > 0;
    });
    if (positiveRecipients.length !== 1) {
      invalid({
        code: 'INCOMPLETE_SETTLEMENT_PAYMENT',
        field: 'split_json',
        constraint: 'exactly one positive recipient for a stored settlement payment',
        recordId,
        message: 'A stored settlement payment must identify exactly one recipient.',
      });
    }
    const toMemberId = memberIdForStoredName(
      positiveRecipients[0].name,
      memberMaps,
      'split_json[0].name',
      recordId
    );
    if (payerMemberId === toMemberId) {
      invalid({
        code: 'INVALID_SETTLEMENT_MEMBERS',
        field: 'split_json[0].name',
        constraint: 'a confirmed member other than the paying member',
        recordId,
        memberId: toMemberId,
        message: 'A settlement payment must be made to a different member.',
      });
    }
    return {
      id: recordId,
      kind: 'settlement_payment',
      fromMemberId: payerMemberId,
      toMemberId,
      amountMinor,
      description: record.description,
      ...storedSourceMetadata(record),
      sourceBoundary: 'stored_payer_name_split_json',
    };
  }

  const memberWeights = normalizeMemberWeights(split, {
    memberMaps,
    recordId,
    field: record.split === undefined ? 'split_json' : 'split',
    storedNames: true,
  });
  return {
    id: recordId,
    kind: 'shared_expense',
    payerMemberId,
    amountMinor,
    splitRule: 'weighted',
    memberWeights,
    ...(record.description === undefined ? {} : { description: record.description }),
    ...storedSourceMetadata(record),
    sourceBoundary: 'stored_payer_name_split_json',
  };
}

function normalizeInput({ members, records, expenses }) {
  let normalizedMembers;
  try {
    normalizedMembers = normalizeMembers(members);
  } catch (error) {
    if (error instanceof TripInputError) {
      return { valid: false, invalid: [error.issue] };
    }
    throw error;
  }

  const sourceRecords = records ?? expenses ?? [];
  if (!Array.isArray(sourceRecords)) {
    return {
      valid: false,
      invalid: [{
        code: 'INVALID_TRIP_RECORDS',
        field: records === undefined ? 'expenses' : 'records',
        constraint: 'an array of trip records',
        message: 'Trip records must be supplied as an array.',
      }],
    };
  }

  const memberMaps = buildMemberMaps(normalizedMembers);
  const normalizedRecords = [];
  const issues = [];
  for (const record of sourceRecords) {
    try {
      normalizedRecords.push(normalizeStoredRecord(record, memberMaps));
    } catch (error) {
      if (!(error instanceof TripInputError)) throw error;
      issues.push(error.issue);
    }
  }

  const seenRecordIds = new Set();
  for (const record of normalizedRecords) {
    if (seenRecordIds.has(record.id)) {
      issues.push({
        code: 'DUPLICATE_TRIP_RECORD_ID',
        field: 'record.id',
        constraint: 'a unique trip record ID',
        recordId: record.id,
        message: 'Trip records must not contain duplicate IDs.',
      });
    }
    seenRecordIds.add(record.id);
  }

  if (issues.length > 0) return { valid: false, invalid: issues };

  normalizedRecords.sort((left, right) => left.id - right.id);
  return {
    valid: true,
    members: normalizedMembers,
    sharedExpenses: normalizedRecords.filter((record) => record.kind === 'shared_expense'),
    settlementPayments: normalizedRecords.filter(
      (record) => record.kind === 'settlement_payment'
    ),
  };
}

/**
 * Convert current payer-name/split-JSON records into explicit member-ID records.
 * This is the compatibility boundary; canonical calculations never key money by name.
 */
export function normalizeStoredTripRecords(input) {
  return normalizeInput(input);
}

function roundWeightedShare(amountMinor, weight, totalWeight) {
  const numerator = BigInt(amountMinor) * BigInt(weight);
  const denominator = BigInt(totalWeight);
  let quotient = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * 2n >= denominator) quotient += 1n;
  return {
    amountMinor: Number(quotient),
    exact: remainder === 0n,
    numerator: numerator.toString(),
    denominator: denominator.toString(),
  };
}

function buildAdjustmentSequence(initialAmounts, finalAmounts, orderedMemberIds) {
  const current = [...initialAmounts];
  const difference = sumPaise([
    sumPaise(finalAmounts, { allowNegative: false, label: 'final allocations' }),
    -sumPaise(initialAmounts, { allowNegative: false, label: 'initial allocations' }),
  ], { label: 'allocation difference' });
  const direction = Math.sign(difference);
  let remaining = Math.abs(difference);
  const sequence = [];

  while (remaining > 0) {
    let changedThisPass = false;
    for (let index = 0; index < current.length && remaining > 0; index += 1) {
      if (direction < 0 && current[index] === 0) continue;
      current[index] += direction;
      remaining -= 1;
      changedThisPass = true;
      sequence.push({
        sequence: sequence.length + 1,
        memberId: orderedMemberIds[index],
        adjustmentMinor: direction,
      });
    }
    if (!changedThisPass) {
      throw new Error('Unable to describe the allocation remainder adjustment.');
    }
  }

  if (current.some((amount, index) => amount !== finalAmounts[index])) {
    throw new Error('Remainder adjustment sequence does not match the canonical allocation.');
  }
  return sequence;
}

/**
 * Allocate one positive integer-paise expense by non-negative integer weights.
 * Included members are ordered by the caller's confirmed member order.
 */
export function allocateTripExpense({
  expenseId,
  amountMinor,
  memberWeights,
  memberOrder,
}) {
  const id = assertRecordId(expenseId, 'expenseId', expenseId);
  const amount = canonicalAmount(amountMinor, 'amountMinor', id);
  if (!Array.isArray(memberWeights) || memberWeights.length === 0) {
    invalid({
      code: 'INCOMPLETE_SPLIT',
      field: 'memberWeights',
      constraint: 'at least one included member with a positive weight',
      recordId: id,
      message: 'memberWeights must include at least one member.',
    });
  }

  const seen = new Set();
  const weights = memberWeights.map((entry, index) => {
    const memberId = assertMemberId(entry?.memberId, `memberWeights[${index}].memberId`, id);
    if (seen.has(memberId)) {
      invalid({
        code: 'DUPLICATE_SPLIT_MEMBER',
        field: `memberWeights[${index}].memberId`,
        constraint: 'one weight per member',
        recordId: id,
        memberId,
        message: 'memberWeights must not repeat a member.',
      });
    }
    seen.add(memberId);
    return {
      memberId,
      weight: canonicalWeight(
        entry.weight,
        `memberWeights[${index}].weight`,
        id,
        memberId
      ),
    };
  });

  const order = memberOrder ?? weights.map(({ memberId }) => memberId).sort((a, b) => a - b);
  if (!Array.isArray(order) || new Set(order).size !== order.length) {
    invalid({
      code: 'INVALID_MEMBER_ORDER',
      field: 'memberOrder',
      constraint: 'each confirmed member ID exactly once',
      recordId: id,
      message: 'memberOrder must contain unique member IDs.',
    });
  }
  const orderIndex = new Map(order.map((memberId, index) => [memberId, index]));
  if (weights.some(({ memberId }) => !orderIndex.has(memberId))) {
    invalid({
      code: 'INCOMPLETE_MEMBER_ORDER',
      field: 'memberOrder',
      constraint: 'every included split member in confirmed member order',
      recordId: id,
      message: 'memberOrder must contain every included split member.',
    });
  }
  weights.sort((left, right) => orderIndex.get(left.memberId) - orderIndex.get(right.memberId));

  let totalWeight;
  try {
    totalWeight = sumPaise(
      weights.map(({ weight }) => weight),
      { allowNegative: false, label: 'split weights' }
    );
  } catch (error) {
    invalid({
      code: 'INVALID_SPLIT_WEIGHT_TOTAL',
      field: 'memberWeights',
      constraint: 'weights whose total is a positive safe integer',
      recordId: id,
      message: error.message,
    });
  }
  if (totalWeight <= 0) {
    invalid({
      code: 'INCOMPLETE_SPLIT',
      field: 'memberWeights',
      constraint: 'at least one positive member weight',
      recordId: id,
      message: 'memberWeights must contain at least one positive weight.',
    });
  }

  const initialShares = weights.map(({ weight }) => roundWeightedShare(
    amount,
    weight,
    totalWeight
  ));
  const remainder = adjustRemainder(
    initialShares.map(({ amountMinor: share }) => share),
    amount,
    { adjustmentTarget: `tripExpense:${id}` }
  );
  const orderedMemberIds = weights.map(({ memberId }) => memberId);
  const adjustmentSequence = buildAdjustmentSequence(
    initialShares.map(({ amountMinor: share }) => share),
    remainder.amounts,
    orderedMemberIds
  );

  const allocations = weights.map(({ memberId, weight }, index) => {
    const initial = initialShares[index];
    const roundingAdjustmentMinor = remainder.adjustments[index];
    return {
      memberId,
      weight,
      rawShare: {
        numerator: initial.numerator,
        denominator: initial.denominator,
      },
      initialAmountMinor: initial.amountMinor,
      amountMinor: remainder.amounts[index],
      roundingAdjustmentMinor,
      rounding: createRoundingMetadata({
        direction: initial.exact && roundingAdjustmentMinor === 0 ? 'exact' : 'half_up',
        adjustmentMinor: roundingAdjustmentMinor,
        adjustmentTarget: `tripExpense:${id}:member:${memberId}`,
      }),
    };
  });

  return {
    expenseId: id,
    amountMinor: amount,
    splitRule: 'weighted',
    totalWeight,
    allocations,
    rounding: remainder.rounding,
    adjustmentSequence,
  };
}

function normalizeExplicitLedger({ members, sharedExpenses, settlementPayments }) {
  const normalizedMembers = normalizeMembers(members);
  const memberMaps = buildMemberMaps(normalizedMembers);
  const records = [
    ...(sharedExpenses ?? []).map((record) => ({ ...record, kind: 'shared_expense' })),
    ...(settlementPayments ?? []).map((record) => ({ ...record, kind: 'settlement_payment' })),
  ];
  const normalized = records.map((record) => normalizeExplicitRecord(record, memberMaps));
  const seen = new Set();
  for (const record of normalized) {
    if (seen.has(record.id)) {
      invalid({
        code: 'DUPLICATE_TRIP_RECORD_ID',
        field: 'record.id',
        constraint: 'a unique trip record ID',
        recordId: record.id,
        message: 'Trip records must not contain duplicate IDs.',
      });
    }
    seen.add(record.id);
  }
  normalized.sort((left, right) => left.id - right.id);
  return {
    members: normalizedMembers,
    sharedExpenses: normalized.filter((record) => record.kind === 'shared_expense'),
    settlementPayments: normalized.filter((record) => record.kind === 'settlement_payment'),
  };
}

function addToAccount(account, field, amountMinor) {
  account[field] = sumPaise([account[field], amountMinor], { label: `member ${account.memberId} ${field}` });
}

function descendingAmountThenOrder(left, right) {
  if (left.remainingMinor > right.remainingMinor) return -1;
  if (left.remainingMinor < right.remainingMinor) return 1;
  return left.order - right.order;
}

function settlementTransfers(balances) {
  const creditors = balances
    .filter(({ amountMinor }) => amountMinor > 0)
    .map(({ memberId, order, amountMinor }) => ({ memberId, order, remainingMinor: amountMinor }))
    .sort(descendingAmountThenOrder);
  const debtors = balances
    .filter(({ amountMinor }) => amountMinor < 0)
    .map(({ memberId, order, amountMinor }) => ({
      memberId,
      order,
      remainingMinor: -amountMinor,
    }))
    .sort(descendingAmountThenOrder);

  const transfers = [];
  let debtorIndex = 0;
  let creditorIndex = 0;
  while (debtorIndex < debtors.length && creditorIndex < creditors.length) {
    const debtor = debtors[debtorIndex];
    const creditor = creditors[creditorIndex];
    const amountMinor = Math.min(debtor.remainingMinor, creditor.remainingMinor);
    transfers.push({
      order: transfers.length + 1,
      fromMemberId: debtor.memberId,
      toMemberId: creditor.memberId,
      amountMinor,
      amount: money(amountMinor),
    });
    debtor.remainingMinor -= amountMinor;
    creditor.remainingMinor -= amountMinor;
    if (debtor.remainingMinor === 0) debtorIndex += 1;
    if (creditor.remainingMinor === 0) creditorIndex += 1;
  }

  if (
    debtors.some(({ remainingMinor }) => remainingMinor !== 0)
    || creditors.some(({ remainingMinor }) => remainingMinor !== 0)
  ) {
    throw new Error('Settlement generation failed to clear the zero-sum balances.');
  }
  return transfers;
}

/**
 * Calculate exact member balances and deterministic transfers from explicit records.
 */
export function calculateTripBalances({ members, sharedExpenses = [], settlementPayments = [] }) {
  const normalized = normalizeExplicitLedger({ members, sharedExpenses, settlementPayments });
  const memberOrder = normalized.members.map(({ id }) => id);
  const accounts = new Map(normalized.members.map((member) => [member.id, {
    memberId: member.id,
    order: member.order,
    sharedExpensePaymentsMadeMinor: 0,
    settlementPaymentsMadeMinor: 0,
    allocatedSharesMinor: 0,
    settlementPaymentsReceivedMinor: 0,
  }]));

  const allocations = normalized.sharedExpenses.map((expense) => {
    const allocation = allocateTripExpense({
      expenseId: expense.id,
      amountMinor: expense.amountMinor,
      memberWeights: expense.memberWeights,
      memberOrder,
    });
    addToAccount(
      accounts.get(expense.payerMemberId),
      'sharedExpensePaymentsMadeMinor',
      expense.amountMinor
    );
    for (const share of allocation.allocations) {
      addToAccount(accounts.get(share.memberId), 'allocatedSharesMinor', share.amountMinor);
    }
    return {
      ...allocation,
      payerMemberId: expense.payerMemberId,
      ...(expense.description === undefined ? {} : { description: expense.description }),
    };
  });

  for (const payment of normalized.settlementPayments) {
    addToAccount(
      accounts.get(payment.fromMemberId),
      'settlementPaymentsMadeMinor',
      payment.amountMinor
    );
    addToAccount(
      accounts.get(payment.toMemberId),
      'settlementPaymentsReceivedMinor',
      payment.amountMinor
    );
  }

  const balances = normalized.members.map((member) => {
    const account = accounts.get(member.id);
    const amountMinor = sumPaise([
      account.sharedExpensePaymentsMadeMinor,
      account.settlementPaymentsMadeMinor,
      -account.allocatedSharesMinor,
      -account.settlementPaymentsReceivedMinor,
    ], { label: `member ${member.id} balance` });
    return {
      ...account,
      amountMinor,
      displayAmountMinor: Math.abs(amountMinor),
      label: amountMinor > 0 ? 'receivable' : amountMinor < 0 ? 'owed' : 'settled',
    };
  });
  const balanceTotalMinor = sumPaise(
    balances.map(({ amountMinor }) => amountMinor),
    { label: 'trip balances' }
  );
  if (balanceTotalMinor !== 0) {
    throw new Error('Canonical trip balances must sum to zero.');
  }

  const settlements = settlementTransfers(balances);
  const postSettlement = new Map(balances.map(({ memberId, amountMinor }) => [
    memberId,
    amountMinor,
  ]));
  for (const transfer of settlements) {
    postSettlement.set(
      transfer.fromMemberId,
      sumPaise([postSettlement.get(transfer.fromMemberId), transfer.amountMinor])
    );
    postSettlement.set(
      transfer.toMemberId,
      sumPaise([postSettlement.get(transfer.toMemberId), -transfer.amountMinor])
    );
  }
  const postSettlementBalances = normalized.members.map(({ id: memberId }) => ({
    memberId,
    amountMinor: postSettlement.get(memberId),
  }));
  if (postSettlementBalances.some(({ amountMinor }) => amountMinor !== 0)) {
    throw new Error('Proposed settlements must reduce every member balance to zero.');
  }

  return {
    members: normalized.members,
    sharedExpenses: normalized.sharedExpenses,
    settlementPayments: normalized.settlementPayments,
    allocations,
    balances,
    balanceTotalMinor,
    settlements,
    postSettlementBalances,
  };
}

function sourceTimestamp(record) {
  return record.confirmedAt ?? record.updatedAt ?? record.createdAt;
}

function sourceRef(order, sourceType, record, field, value, label) {
  const confirmedAt = sourceTimestamp(record);
  return {
    order,
    ref: `${sourceType}:${record.id}:${field}`,
    sourceType,
    recordId: record.id,
    field,
    label,
    value,
    ...(confirmedAt === undefined ? {} : { confirmedAt }),
  };
}

function buildExplanation(result) {
  const sourceRefs = [];
  const operations = [];
  const roundingAdjustments = [];
  const expenseById = new Map(result.sharedExpenses.map((expense) => [expense.id, expense]));

  for (const allocation of result.allocations) {
    const expense = expenseById.get(allocation.expenseId);
    const amountRef = sourceRef(
      sourceRefs.length + 1,
      'trip_expense',
      expense,
      'amountMinor',
      money(expense.amountMinor),
      `Shared expense ${expense.id}`
    );
    sourceRefs.push(amountRef);
    const payerRef = sourceRef(
      sourceRefs.length + 1,
      'trip_expense',
      expense,
      'payerMemberId',
      expense.payerMemberId,
      `Payer for shared expense ${expense.id}`
    );
    sourceRefs.push(payerRef);
    const weightRefs = [];
    for (const memberWeight of expense.memberWeights) {
      const ref = sourceRef(
        sourceRefs.length + 1,
        'trip_expense',
        expense,
        `splitRule.member:${memberWeight.memberId}`,
        memberWeight.weight,
        `Weighted split for member ${memberWeight.memberId}`
      );
      sourceRefs.push(ref);
      weightRefs.push(ref.ref);
    }

    operations.push({
      order: operations.length + 1,
      stage: 'allocate_shared_expense',
      operation: 'multiply_ratio',
      expenseId: expense.id,
      payerMemberId: expense.payerMemberId,
      splitRule: 'weighted',
      operandRefs: [amountRef.ref, payerRef.ref, ...weightRefs],
      allocations: allocation.allocations.map((share) => ({
        memberId: share.memberId,
        weight: share.weight,
        rawShare: share.rawShare,
        initialResult: money(share.initialAmountMinor),
        result: money(share.amountMinor),
        rounding: share.rounding,
      })),
      result: money(expense.amountMinor),
      explanationKey: 'trip.allocate_shared_expense',
    });
    operations.push({
      order: operations.length + 1,
      stage: 'adjust_allocation_remainder',
      operation: 'remainder_adjustment',
      expenseId: expense.id,
      operandRefs: [`result:tripExpense:${expense.id}:initialAllocations`],
      adjustments: allocation.allocations.map((share) => ({
        memberId: share.memberId,
        adjustmentMinor: share.roundingAdjustmentMinor,
      })),
      adjustmentSequence: allocation.adjustmentSequence,
      result: money(expense.amountMinor),
      rounding: allocation.rounding,
      explanationKey: 'trip.adjust_allocation_remainder',
    });
    roundingAdjustments.push({
      expenseId: expense.id,
      adjustmentMinor: allocation.rounding.adjustmentMinor,
      memberAdjustments: allocation.allocations.map((share) => ({
        memberId: share.memberId,
        initialAmountMinor: share.initialAmountMinor,
        adjustmentMinor: share.roundingAdjustmentMinor,
        amountMinor: share.amountMinor,
      })),
      sequence: allocation.adjustmentSequence,
    });
  }

  for (const payment of result.settlementPayments) {
    const amountRef = sourceRef(
      sourceRefs.length + 1,
      'trip_settlement',
      payment,
      'amountMinor',
      money(payment.amountMinor),
      `Settlement payment ${payment.id}`
    );
    sourceRefs.push(amountRef);
    const fromRef = sourceRef(
      sourceRefs.length + 1,
      'trip_settlement',
      payment,
      'fromMemberId',
      payment.fromMemberId,
      `Settlement payer ${payment.fromMemberId}`
    );
    sourceRefs.push(fromRef);
    const toRef = sourceRef(
      sourceRefs.length + 1,
      'trip_settlement',
      payment,
      'toMemberId',
      payment.toMemberId,
      `Settlement recipient ${payment.toMemberId}`
    );
    sourceRefs.push(toRef);
    operations.push({
      order: operations.length + 1,
      stage: 'apply_settlement_payment',
      operation: 'subtract',
      settlementPaymentId: payment.id,
      fromMemberId: payment.fromMemberId,
      toMemberId: payment.toMemberId,
      operandRefs: [amountRef.ref, fromRef.ref, toRef.ref],
      result: money(payment.amountMinor),
      explanationKey: 'trip.apply_settlement_payment',
    });
  }

  for (const balance of result.balances) {
    operations.push({
      order: operations.length + 1,
      stage: 'calculate_member_balance',
      operation: 'sum',
      memberId: balance.memberId,
      operandRefs: sourceRefs.map(({ ref }) => ref),
      intermediateResults: {
        sharedExpensePaymentsMade: money(balance.sharedExpensePaymentsMadeMinor),
        settlementPaymentsMade: money(balance.settlementPaymentsMadeMinor),
        allocatedShares: money(balance.allocatedSharesMinor),
        settlementPaymentsReceived: money(balance.settlementPaymentsReceivedMinor),
      },
      result: money(balance.amountMinor),
      classification: balance.label,
      explanationKey: 'trip.calculate_member_balance',
    });
  }

  for (const transfer of result.settlements) {
    operations.push({
      order: operations.length + 1,
      stage: 'propose_settlement_transfer',
      operation: 'subtract',
      fromMemberId: transfer.fromMemberId,
      toMemberId: transfer.toMemberId,
      operandRefs: [
        `result:memberBalance:${transfer.fromMemberId}`,
        `result:memberBalance:${transfer.toMemberId}`,
      ],
      result: money(transfer.amountMinor),
      explanationKey: 'trip.propose_settlement_transfer',
    });
  }

  return {
    precisionMinor: 1,
    sourceRefs,
    operations,
    roundingAdjustments,
  };
}

function lastConfirmedValue(lastConfirmed) {
  if (lastConfirmed?.status !== 'available' || !lastConfirmed.value) return null;
  return structuredClone(lastConfirmed.value);
}

function invalidOutcome({ tripId, tripVersion, invalid: issues, lastConfirmed }) {
  const retained = lastConfirmedValue(lastConfirmed);
  const outcomeStatus = retained ? 'retained_last_confirmed' : 'unavailable';
  const memberBalances = {
    status: outcomeStatus,
    invalid: issues,
    ...(retained ? { value: retained.balances } : {}),
  };
  const tripSettlement = {
    status: outcomeStatus,
    invalid: issues,
    ...(retained ? { value: retained.settlements } : {}),
  };
  return {
    status: 'invalid_input',
    availability: outcomeStatus,
    ...(tripId === undefined ? {} : { tripId }),
    attemptedTripVersion: tripVersion,
    tripVersion: retained?.tripVersion ?? null,
    invalid: issues,
    ...(retained ? { value: retained } : {}),
    outcomes: { memberBalances, tripSettlement },
  };
}

/**
 * Calculate the complete trip outcome, or contain an invalid/incomplete draft.
 * A failed draft never returns a newly calculated balance version.
 */
export function calculateTripOutcome({
  tripId,
  tripVersion = 0,
  members,
  records,
  expenses,
  lastConfirmed = null,
}) {
  if (!Number.isSafeInteger(tripVersion) || tripVersion < 0) {
    return invalidOutcome({
      tripId,
      tripVersion,
      invalid: [{
        code: 'INVALID_TRIP_VERSION',
        field: 'tripVersion',
        constraint: 'a non-negative safe integer',
        message: 'tripVersion must be a non-negative safe integer.',
      }],
      lastConfirmed,
    });
  }

  const normalized = normalizeInput({ members, records, expenses });
  if (!normalized.valid) {
    return invalidOutcome({
      tripId,
      tripVersion,
      invalid: normalized.invalid,
      lastConfirmed,
    });
  }

  let result;
  try {
    result = calculateTripBalances(normalized);
  } catch (error) {
    if (!(error instanceof TripInputError)) throw error;
    return invalidOutcome({
      tripId,
      tripVersion,
      invalid: [error.issue],
      lastConfirmed,
    });
  }
  const explanation = buildExplanation(result);
  const value = {
    ...(tripId === undefined ? {} : { tripId }),
    tripVersion,
    members: result.members,
    sharedExpenses: result.sharedExpenses,
    settlementPayments: result.settlementPayments,
    allocations: result.allocations,
    balances: result.balances,
    settlements: result.settlements,
    postSettlementBalances: result.postSettlementBalances,
    explanation,
  };

  return {
    status: 'available',
    availability: 'available',
    ...(tripId === undefined ? {} : { tripId }),
    tripVersion,
    value,
    outcomes: {
      memberBalances: { status: 'available', value: value.balances },
      tripSettlement: { status: 'available', value: value.settlements },
    },
  };
}
