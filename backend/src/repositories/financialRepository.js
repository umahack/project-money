import db from '../db/index.js';
import {
  assertMonth,
  assertPositiveId,
  confirmedCollection,
  confirmedRecord,
  normalizeStoredAmounts,
  requireDatabase,
  toSafeInteger,
} from './repositorySupport.js';

function mapSalary(row) {
  if (!row) return null;
  return normalizeStoredAmounts({
    id: toSafeInteger(row.id, 'salary id'),
    userId: toSafeInteger(row.user_id, 'salary user id'),
    month: row.month,
    amount: row.amount,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
  }, [{ sourceField: 'amount', targetField: 'amountMinor' }], {
    sourceType: 'salary',
  });
}

function mapBill(row) {
  return normalizeStoredAmounts({
    id: toSafeInteger(row.id, 'bill id'),
    userId: toSafeInteger(row.user_id, 'bill user id'),
    label: row.label,
    category: row.category,
    active: Number(row.active) === 1,
    effectiveFromMonth: row.effective_from_month ?? null,
    effectiveToMonth: row.effective_to_month ?? null,
    amount: row.amount,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
  }, [{ sourceField: 'amount', targetField: 'amountMinor' }], {
    sourceType: 'bill',
  });
}

function mapExpense(row) {
  return normalizeStoredAmounts({
    id: toSafeInteger(row.id, 'expense id'),
    userId: toSafeInteger(row.user_id, 'expense user id'),
    month: row.month,
    category: row.category,
    note: row.note ?? null,
    spentOn: row.spent_on ?? null,
    amount: row.amount,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
  }, [{ sourceField: 'amount', targetField: 'amountMinor' }], {
    sourceType: 'expense',
  });
}

function mapGoal(row) {
  return normalizeStoredAmounts({
    id: toSafeInteger(row.id, 'goal id'),
    userId: toSafeInteger(row.user_id, 'goal user id'),
    name: row.name,
    targetAmount: row.target_amount,
    savedAmount: row.saved_amount,
    targetDate: row.target_date ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
  }, [
    { sourceField: 'targetAmount', targetField: 'targetAmountMinor' },
    { sourceField: 'savedAmount', targetField: 'savedAmountMinor' },
  ], {
    sourceType: 'goal',
  });
}

function mapTreatment(row) {
  return {
    id: toSafeInteger(row.id, 'category treatment id'),
    userId: toSafeInteger(row.user_id, 'category treatment user id'),
    category: row.category,
    treatment: row.treatment,
    updatedAt: row.updated_at,
  };
}

function mapTrip(row) {
  return normalizeStoredAmounts({
    id: toSafeInteger(row.id, 'trip id'),
    ownerUserId: toSafeInteger(row.user_id, 'trip owner user id'),
    name: row.name,
    destination: row.destination ?? null,
    budget: row.budget,
    startDate: row.start_date ?? null,
    endDate: row.end_date ?? null,
    publicEnabled: Number(row.public_enabled) === 1,
    tripVersion: toSafeInteger(row.trip_version ?? 0, 'trip version'),
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
    role: row.role,
  }, [{ sourceField: 'budget', targetField: 'budgetMinor' }], {
    sourceType: 'trip',
  });
}

function mapTripMember(row) {
  return {
    id: toSafeInteger(row.id, 'trip member id'),
    tripId: toSafeInteger(row.trip_id, 'trip member trip id'),
    userId: row.user_id == null ? null : toSafeInteger(row.user_id, 'trip member user id'),
    name: row.name,
    email: row.email ?? null,
  };
}

function parseStoredSplit(row) {
  try {
    const split = JSON.parse(row.split_json);
    if (!Array.isArray(split)) throw new TypeError('Stored split must be an array.');
    return { splitStatus: 'confirmed', split, splitIssue: null };
  } catch {
    return {
      splitStatus: 'invalid',
      split: null,
      splitIssue: {
        code: 'INVALID_STORED_SPLIT',
        field: 'split_json',
        message: 'Stored split is not a valid array.',
      },
    };
  }
}

function mapTripExpense(row) {
  const normalized = normalizeStoredAmounts({
    id: toSafeInteger(row.id, 'trip expense id'),
    tripId: toSafeInteger(row.trip_id, 'trip expense trip id'),
    payer: row.payer,
    description: row.description,
    amount: row.amount,
    createdAt: row.created_at,
    updatedAt: row.updated_at ?? row.created_at,
  }, [{ sourceField: 'amount', targetField: 'amountMinor' }], {
    sourceType: 'trip_expense',
  });
  return { ...normalized, ...parseStoredSplit(row) };
}

export class FinancialRepository {
  #database;

  constructor(database) {
    this.#database = requireDatabase(database);
  }

  /**
   * Load only confirmed records for the requested month. Empty record sets are
   * explicit confirmed collections; database failures reject instead.
   */
  async loadPeriod({ userId, month }) {
    assertPositiveId(userId, 'userId');
    assertMonth(month);

    const [salaryRow, billRows, expenseRows, treatmentRows] = await Promise.all([
      this.#database.prepare(
        `SELECT id, user_id, month, amount, created_at, updated_at
           FROM salary_entries
          WHERE user_id = ? AND month = ?
          LIMIT 1`
      ).get(userId, month),
      this.#database.prepare(
        `SELECT id, user_id, label, amount, category, active,
                effective_from_month, effective_to_month, created_at, updated_at
           FROM emis
          WHERE user_id = ?
            AND active = 1
            AND (effective_from_month IS NULL OR effective_from_month <= ?)
            AND (effective_to_month IS NULL OR effective_to_month >= ?)
          ORDER BY id`
      ).all(userId, month, month),
      this.#database.prepare(
        `SELECT id, user_id, month, category, amount, note, spent_on,
                created_at, updated_at
           FROM expense_log
          WHERE user_id = ? AND month = ?
          ORDER BY id`
      ).all(userId, month),
      this.#database.prepare(
        `SELECT id, user_id, category, treatment, updated_at
           FROM expense_category_treatments
          WHERE user_id = ?
          ORDER BY category COLLATE NOCASE, id`
      ).all(userId),
    ]);

    return {
      status: 'confirmed',
      month,
      salary: confirmedRecord(mapSalary(salaryRow)),
      bills: confirmedCollection(billRows.map(mapBill)),
      expenses: confirmedCollection(expenseRows.map(mapExpense)),
      categoryTreatments: confirmedCollection(treatmentRows.map(mapTreatment)),
    };
  }

  async loadGoals(userId) {
    assertPositiveId(userId, 'userId');
    const rows = await this.#database.prepare(
      `SELECT id, user_id, name, target_amount, saved_amount, target_date,
              created_at, updated_at
         FROM savings_goals
        WHERE user_id = ?
        ORDER BY id`
    ).all(userId);
    return confirmedCollection(rows.map(mapGoal));
  }

  async listAccessibleTrips(userId) {
    assertPositiveId(userId, 'userId');
    const rows = await this.#database.prepare(
      `SELECT t.id, t.user_id, t.name, t.destination, t.budget,
              t.start_date, t.end_date, t.public_enabled, t.trip_version,
              t.created_at, t.updated_at,
              CASE WHEN t.user_id = ? THEN 'owner' ELSE 'member' END AS role
         FROM trips t
        WHERE t.user_id = ?
           OR EXISTS (
             SELECT 1
               FROM trip_members access_member
              WHERE access_member.trip_id = t.id
                AND access_member.user_id = ?
           )
        ORDER BY t.id DESC`
    ).all(userId, userId, userId);
    return confirmedCollection(rows.map(mapTrip));
  }

  /**
   * Preserve the existing owner-or-accepted-member rule. Every query that
   * follows the access check repeats the user-scoped predicate so no private
   * trip row can be loaded through a trip ID alone.
   */
  async loadAccessibleTripLedger({ userId, tripId }) {
    assertPositiveId(userId, 'userId');
    assertPositiveId(tripId, 'tripId');

    const accessArgs = [tripId, userId, userId];
    const tripRow = await this.#database.prepare(
      `SELECT t.id, t.user_id, t.name, t.destination, t.budget,
              t.start_date, t.end_date, t.public_enabled, t.trip_version,
              t.created_at, t.updated_at,
              CASE WHEN t.user_id = ? THEN 'owner' ELSE 'member' END AS role
         FROM trips t
        WHERE t.id = ?
          AND (
            t.user_id = ?
            OR EXISTS (
              SELECT 1
                FROM trip_members access_member
               WHERE access_member.trip_id = t.id
                 AND access_member.user_id = ?
            )
          )`
    ).get(userId, ...accessArgs);
    if (!tripRow) return null;

    const [memberRows, expenseRows] = await Promise.all([
      this.#database.prepare(
        `SELECT member.id, member.trip_id, member.user_id, member.name, member.email
           FROM trip_members member
          WHERE member.trip_id = ?
            AND EXISTS (
              SELECT 1
                FROM trips trip
               WHERE trip.id = member.trip_id
                 AND (
                   trip.user_id = ?
                   OR EXISTS (
                     SELECT 1
                       FROM trip_members access_member
                      WHERE access_member.trip_id = trip.id
                        AND access_member.user_id = ?
                   )
                 )
            )
          ORDER BY member.id`
      ).all(tripId, userId, userId),
      this.#database.prepare(
        `SELECT expense.id, expense.trip_id, expense.payer, expense.description,
                expense.amount, expense.split_json, expense.created_at, expense.updated_at
           FROM trip_expenses expense
          WHERE expense.trip_id = ?
            AND EXISTS (
              SELECT 1
                FROM trips trip
               WHERE trip.id = expense.trip_id
                 AND (
                   trip.user_id = ?
                   OR EXISTS (
                     SELECT 1
                       FROM trip_members access_member
                      WHERE access_member.trip_id = trip.id
                        AND access_member.user_id = ?
                   )
                 )
            )
          ORDER BY expense.id`
      ).all(tripId, userId, userId),
    ]);

    return {
      status: 'confirmed',
      role: tripRow.role,
      trip: mapTrip(tripRow),
      members: confirmedCollection(memberRows.map(mapTripMember)),
      expenses: confirmedCollection(expenseRows.map(mapTripExpense)),
    };
  }

  async getDataVersion(userId) {
    assertPositiveId(userId, 'userId');
    const row = await this.#database.prepare(
      `SELECT user.id AS user_id, COALESCE(state.data_version, 0) AS data_version
         FROM users user
         LEFT JOIN user_financial_state state ON state.user_id = user.id
        WHERE user.id = ?`
    ).get(userId);
    if (!row) return null;
    return toSafeInteger(row.data_version, 'data version');
  }

  async incrementDataVersion(userId) {
    assertPositiveId(userId, 'userId');
    const row = await this.#database.prepare(
      `INSERT INTO user_financial_state (user_id, data_version)
       VALUES (?, 1)
       ON CONFLICT(user_id) DO UPDATE SET
         data_version = user_financial_state.data_version + 1,
         updated_at = CURRENT_TIMESTAMP
       RETURNING data_version`
    ).get(userId);
    return toSafeInteger(row.data_version, 'data version');
  }

  async getTripVersion({ userId, tripId }) {
    assertPositiveId(userId, 'userId');
    assertPositiveId(tripId, 'tripId');
    const row = await this.#database.prepare(
      `SELECT trip.trip_version
         FROM trips trip
        WHERE trip.id = ?
          AND (
            trip.user_id = ?
            OR EXISTS (
              SELECT 1 FROM trip_members access_member
               WHERE access_member.trip_id = trip.id
                 AND access_member.user_id = ?
            )
          )`
    ).get(tripId, userId, userId);
    return row ? toSafeInteger(row.trip_version, 'trip version') : null;
  }

  async incrementTripVersion({ userId, tripId }) {
    assertPositiveId(userId, 'userId');
    assertPositiveId(tripId, 'tripId');
    const row = await this.#database.prepare(
      `UPDATE trips AS trip
          SET trip_version = trip_version + 1,
              updated_at = CURRENT_TIMESTAMP
        WHERE trip.id = ?
          AND (
            trip.user_id = ?
            OR EXISTS (
              SELECT 1 FROM trip_members access_member
               WHERE access_member.trip_id = trip.id
                 AND access_member.user_id = ?
            )
          )
       RETURNING trip_version`
    ).get(tripId, userId, userId);
    return row ? toSafeInteger(row.trip_version, 'trip version') : null;
  }
}

const financialRepository = new FinancialRepository(db);
export default financialRepository;
