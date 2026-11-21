import { Router } from 'express';
import { authRequired } from '../middleware/auth.js';
import claritySettingsService, {
  ClaritySettingsError,
} from '../services/claritySettings.js';

function settingsErrorBody(error) {
  const responseError = {
    code: error.code,
    message: error.message,
  };
  for (const field of [
    'field',
    'allowedFields',
    'requiredNoticeVersion',
    'currentNoticeVersion',
    'acknowledgedNoticeVersion',
    'settingsPath',
  ]) {
    if (Object.hasOwn(error, field)) responseError[field] = error[field];
  }
  return { error: responseError };
}

function sendSettingsError(res, error) {
  if (!(error instanceof ClaritySettingsError)) return false;
  res.status(error.httpStatus).json(settingsErrorBody(error));
  return true;
}

export function createSettingsRouter({ service = claritySettingsService } = {}) {
  if (!service
    || typeof service.getSettings !== 'function'
    || typeof service.updateSettings !== 'function') {
    throw new TypeError('A clarity settings service with read and update methods is required.');
  }

  const router = Router();
  router.use(authRequired);

  router.get('/', async (req, res) => {
    try {
      return res.json(await service.getSettings({ userId: req.user.id }));
    } catch (error) {
      if (sendSettingsError(res, error)) return;
      throw error;
    }
  });

  router.patch('/', async (req, res) => {
    try {
      return res.json(await service.updateSettings({
        userId: req.user.id,
        patch: req.body,
      }));
    } catch (error) {
      if (sendSettingsError(res, error)) return;
      throw error;
    }
  });

  return router;
}

export default createSettingsRouter();
