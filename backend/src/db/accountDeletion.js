import db from './index.js';

export const ACCOUNT_DATA_SUPPORT = Object.freeze({
  email: 'hello@project-money.online',
  path: 'mailto:hello@project-money.online',
});

export const ACCOUNT_DELETION_CATEGORY_DESCRIPTIONS = Object.freeze({
  account_profile: 'Account profile and sign-in identity.',
  sessions: 'Device sessions for the account.',
  salary_entries: 'Confirmed monthly salary records.',
  emis: 'Confirmed bill and fixed-obligation records.',
  expense_log: 'Confirmed personal expenses, including linked trip expenses.',
  category_budgets: 'Personal expense-category budgets.',
  recurring_expenses: 'Recurring personal expense definitions.',
  savings_goals: 'Savings goals and their confirmed progress.',
  user_categories: 'Personal expense categories.',
  category_memory: 'Remembered category choices used to suggest categories in Quick Add.',
  user_aliases: 'Email aliases linked to the account.',
  trip_data: 'Owned trips, memberships, invitations, members, and shared expenses.',
  public_sharing_settings: 'Public links and sharing state for owned trips.',
  user_financial_state: 'Financial data version and Financial Clarity settings.',
  product_analytics_settings: 'The account Product Analytics consent setting and version.',
  guided_journeys: 'Guided Journey progress and completion state.',
  expense_category_treatments: 'Needs or Wants treatment choices for expense categories.',
  trip_expense_personal_links: 'Links between trip shares and personal expense records.',
  financial_record_changes: 'Confirmed financial change receipts.',
  product_measurement_events: 'User-linked Product Analytics events.',
  visits: 'User-linked visit records.',
  pending_account_requests: 'Pending email, registration, and password-reset requests.',
  feedback_link: 'The account link on retained feedback.',
  audit_link: 'The account link on retained security audit records.',
});

const ACCOUNT_DELETION_CATEGORY_PROBES = Object.freeze([
  {
    key: 'account_profile',
    sql: 'SELECT EXISTS(SELECT 1 FROM users WHERE id = ?) AS present',
    args: ({ userId }) => [userId],
  },
  {
    key: 'sessions',
    sql: 'SELECT EXISTS(SELECT 1 FROM sessions WHERE user_id = ?) AS present',
    args: ({ userId }) => [userId],
  },
  {
    key: 'salary_entries',
    sql: 'SELECT EXISTS(SELECT 1 FROM salary_entries WHERE user_id = ?) AS present',
    args: ({ userId }) => [userId],
  },
  {
    key: 'emis',
    sql: 'SELECT EXISTS(SELECT 1 FROM emis WHERE user_id = ?) AS present',
    args: ({ userId }) => [userId],
  },
  {
    key: 'expense_log',
    sql: 'SELECT EXISTS(SELECT 1 FROM expense_log WHERE user_id = ?) AS present',
    args: ({ userId }) => [userId],
  },
  {
    key: 'category_budgets',
    sql: 'SELECT EXISTS(SELECT 1 FROM category_budgets WHERE user_id = ?) AS present',
    args: ({ userId }) => [userId],
  },
  {
    key: 'recurring_expenses',
    sql: 'SELECT EXISTS(SELECT 1 FROM recurring_expenses WHERE user_id = ?) AS present',
    args: ({ userId }) => [userId],
  },
  {
    key: 'savings_goals',
    sql: 'SELECT EXISTS(SELECT 1 FROM savings_goals WHERE user_id = ?) AS present',
    args: ({ userId }) => [userId],
  },
  {
    key: 'user_categories',
    sql: 'SELECT EXISTS(SELECT 1 FROM user_categories WHERE user_id = ?) AS present',
    args: ({ userId }) => [userId],
  },
  {
    key: 'category_memory',
    sql: 'SELECT EXISTS(SELECT 1 FROM category_memory WHERE user_id = ?) AS present',
    args: ({ userId }) => [userId],
  },
  {
    key: 'user_aliases',
    sql: 'SELECT EXISTS(SELECT 1 FROM user_aliases WHERE user_id = ?) AS present',
    args: ({ userId }) => [userId],
  },
  {
    key: 'trip_data',
    sql: `SELECT (
      EXISTS(SELECT 1 FROM trips WHERE user_id = ?) OR
      EXISTS(SELECT 1 FROM trip_members WHERE user_id = ?) OR
      EXISTS(SELECT 1 FROM trip_invites WHERE inviter_id = ? OR invitee_id = ?)
    ) AS present`,
    args: ({ userId }) => [userId, userId, userId, userId],
  },
  {
    key: 'public_sharing_settings',
    sql: `SELECT EXISTS(
      SELECT 1 FROM trips
       WHERE user_id = ? AND (public_enabled = 1 OR public_token IS NOT NULL)
    ) AS present`,
    args: ({ userId }) => [userId],
  },
  {
    key: 'user_financial_state',
    sql: 'SELECT EXISTS(SELECT 1 FROM user_financial_state WHERE user_id = ?) AS present',
    args: ({ userId }) => [userId],
  },
  {
    key: 'product_analytics_settings',
    sql: 'SELECT EXISTS(SELECT 1 FROM user_financial_state WHERE user_id = ?) AS present',
    args: ({ userId }) => [userId],
  },
  {
    key: 'guided_journeys',
    sql: 'SELECT EXISTS(SELECT 1 FROM guided_journeys WHERE user_id = ?) AS present',
    args: ({ userId }) => [userId],
  },
  {
    key: 'expense_category_treatments',
    sql: 'SELECT EXISTS(SELECT 1 FROM expense_category_treatments WHERE user_id = ?) AS present',
    args: ({ userId }) => [userId],
  },
  {
    key: 'trip_expense_personal_links',
    sql: `SELECT (
      EXISTS(SELECT 1 FROM trip_expense_personal_links WHERE user_id = ?) OR
      EXISTS(
        SELECT 1 FROM trip_expense_personal_links
         WHERE trip_id IN (SELECT id FROM trips WHERE user_id = ?)
      )
    ) AS present`,
    args: ({ userId }) => [userId, userId],
  },
  {
    key: 'financial_record_changes',
    sql: 'SELECT EXISTS(SELECT 1 FROM financial_record_changes WHERE user_id = ?) AS present',
    args: ({ userId }) => [userId],
  },
  {
    key: 'product_measurement_events',
    sql: 'SELECT EXISTS(SELECT 1 FROM product_measurement_events WHERE user_id = ?) AS present',
    args: ({ userId }) => [userId],
  },
  {
    key: 'visits',
    sql: 'SELECT EXISTS(SELECT 1 FROM visits WHERE user_id = ?) AS present',
    args: ({ userId }) => [userId],
  },
  {
    key: 'pending_account_requests',
    sql: `SELECT (
      EXISTS(SELECT 1 FROM pending_email_changes WHERE user_id = ?) OR
      EXISTS(SELECT 1 FROM pending_registrations WHERE email = ?) OR
      EXISTS(SELECT 1 FROM pending_password_resets WHERE email = ?)
    ) AS present`,
    args: ({ userId, email }) => [userId, email, email],
  },
  {
    key: 'feedback_link',
    sql: 'SELECT EXISTS(SELECT 1 FROM feedback WHERE user_id = ?) AS present',
    args: ({ userId }) => [userId],
  },
  {
    key: 'audit_link',
    sql: 'SELECT EXISTS(SELECT 1 FROM audit_log WHERE actor_id = ?) AS present',
    args: ({ userId }) => [userId],
  },
]);

function assertUserId(userId) {
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    throw new TypeError('userId must be a positive safe integer.');
  }
}

function assertEmail(email) {
  if (typeof email !== 'string' || email.trim() === '') {
    throw new TypeError('email must be a non-empty string.');
  }
}

function describedCategories(keys) {
  return keys.map((key) => ({
    key,
    description: ACCOUNT_DELETION_CATEGORY_DESCRIPTIONS[key],
  }));
}

function allDeletionCategories() {
  return describedCategories(Object.keys(ACCOUNT_DELETION_CATEGORY_DESCRIPTIONS));
}

export class AccountDeletionIncompleteError extends Error {
  constructor(undeletedRecordCategories, options = {}) {
    super('Account deletion is incomplete. No account records were deleted.', options);
    this.name = 'AccountDeletionIncompleteError';
    this.code = 'ACCOUNT_DELETION_INCOMPLETE';
    this.undeletedRecordCategories = undeletedRecordCategories;
  }
}

/**
 * Return the complete account-deletion write set in dependency order. The
 * personal-expense predicate requires both the link and expense to belong to
 * the deleting user, so a malformed cross-account link cannot delete another
 * account's expense. All statements execute in one write transaction.
 */
export function buildAccountDeletionStatements({ userId, email }) {
  assertUserId(userId);
  assertEmail(email);

  return [
    ['DELETE FROM product_measurement_events WHERE user_id = ?', [userId]],
    [`DELETE FROM expense_log
       WHERE user_id = ?
         AND id IN (
           SELECT expense_log_id
             FROM trip_expense_personal_links
            WHERE user_id = ?
         )`, [userId, userId]],
    ['DELETE FROM trip_expense_personal_links WHERE user_id = ?', [userId]],
    [`DELETE FROM trip_expense_personal_links
       WHERE trip_id IN (SELECT id FROM trips WHERE user_id = ?)`, [userId]],
    ['DELETE FROM financial_record_changes WHERE user_id = ?', [userId]],
    ['DELETE FROM expense_category_treatments WHERE user_id = ?', [userId]],
    ['DELETE FROM guided_journeys WHERE user_id = ?', [userId]],
    ['DELETE FROM user_financial_state WHERE user_id = ?', [userId]],
    [`DELETE FROM trip_expenses
       WHERE trip_id IN (SELECT id FROM trips WHERE user_id = ?)`, [userId]],
    [`DELETE FROM trip_members
       WHERE user_id = ? OR trip_id IN (SELECT id FROM trips WHERE user_id = ?)`,
      [userId, userId]],
    [`DELETE FROM trip_invites
       WHERE inviter_id = ? OR invitee_id = ?
          OR trip_id IN (SELECT id FROM trips WHERE user_id = ?)`,
      [userId, userId, userId]],
    [`UPDATE trips
         SET public_token = NULL, public_enabled = 0
       WHERE user_id = ?`, [userId]],
    ['DELETE FROM trips WHERE user_id = ?', [userId]],
    ['DELETE FROM salary_entries WHERE user_id = ?', [userId]],
    ['DELETE FROM emis WHERE user_id = ?', [userId]],
    ['DELETE FROM expense_log WHERE user_id = ?', [userId]],
    ['DELETE FROM category_budgets WHERE user_id = ?', [userId]],
    ['DELETE FROM recurring_expenses WHERE user_id = ?', [userId]],
    ['DELETE FROM savings_goals WHERE user_id = ?', [userId]],
    ['DELETE FROM category_memory WHERE user_id = ?', [userId]],
    ['DELETE FROM user_categories WHERE user_id = ?', [userId]],
    ['DELETE FROM user_aliases WHERE user_id = ?', [userId]],
    ['DELETE FROM sessions WHERE user_id = ?', [userId]],
    ['DELETE FROM pending_email_changes WHERE user_id = ?', [userId]],
    ['DELETE FROM pending_registrations WHERE email = ?', [email]],
    ['DELETE FROM pending_password_resets WHERE email = ?', [email]],
    ['UPDATE feedback SET user_id = NULL WHERE user_id = ?', [userId]],
    ['UPDATE audit_log SET actor_id = NULL WHERE actor_id = ?', [userId]],
    ['DELETE FROM visits WHERE user_id = ?', [userId]],
    ['DELETE FROM users WHERE id = ?', [userId]],
  ];
}

export async function findUndeletedAccountRecordCategories({
  database = db,
  userId,
  email,
}) {
  assertUserId(userId);
  assertEmail(email);

  const input = { userId, email };
  const presence = await Promise.all(ACCOUNT_DELETION_CATEGORY_PROBES.map(async (probe) => {
    const row = await database.prepare(probe.sql).get(...probe.args(input));
    return Number(row?.present ?? 0) === 1 ? probe.key : null;
  }));

  return describedCategories(presence.filter(Boolean));
}

export function buildIncompleteDeletionResponse(error, retryPath) {
  const categories = Array.isArray(error?.undeletedRecordCategories)
    ? error.undeletedRecordCategories
    : allDeletionCategories();

  return {
    error: 'Account deletion is incomplete. No account records were deleted.',
    code: 'ACCOUNT_DELETION_INCOMPLETE',
    status: 'incomplete',
    undeleted_record_categories: categories,
    retry: {
      method: 'DELETE',
      path: retryPath,
    },
    support: ACCOUNT_DATA_SUPPORT,
  };
}

export async function deleteAccountRecords({
  database = db,
  userId,
  email,
}) {
  const statements = buildAccountDeletionStatements({ userId, email });
  try {
    return await database.batch(statements);
  } catch (cause) {
    let undeletedRecordCategories;
    try {
      undeletedRecordCategories = await findUndeletedAccountRecordCategories({
        database,
        userId,
        email,
      });
    } catch {
      undeletedRecordCategories = allDeletionCategories();
    }
    throw new AccountDeletionIncompleteError(undeletedRecordCategories, { cause });
  }
}
