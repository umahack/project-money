import claritySettingsService, {
  ClaritySettingsError,
  CURRENT_DATA_USE_NOTICE_VERSION,
} from '../services/claritySettings.js';

function dataUseErrorBody(error) {
  return {
    error: {
      code: error.code,
      message: error.message,
      requiredNoticeVersion: error.requiredNoticeVersion,
      currentNoticeVersion: error.currentNoticeVersion,
      acknowledgedNoticeVersion: error.acknowledgedNoticeVersion,
      settingsPath: error.settingsPath,
    },
  };
}

/**
 * Declare the data-use notice version required by one financial command.
 * Read, correction, export, and deletion routes do not install this gate.
 */
export function createDataUseNoticeGate({
  requiredNoticeVersion = CURRENT_DATA_USE_NOTICE_VERSION,
  appliesTo = () => true,
  service = claritySettingsService,
} = {}) {
  if (!Number.isSafeInteger(requiredNoticeVersion)
    || requiredNoticeVersion < 0
    || requiredNoticeVersion > CURRENT_DATA_USE_NOTICE_VERSION) {
    throw new RangeError(
      `requiredNoticeVersion must be between 0 and ${CURRENT_DATA_USE_NOTICE_VERSION}.`
    );
  }
  if (typeof appliesTo !== 'function') throw new TypeError('appliesTo must be a function.');
  if (!service || typeof service.assertDataUseNotice !== 'function') {
    throw new TypeError('A clarity settings service with assertDataUseNotice() is required.');
  }

  return async function dataUseNoticeGate(req, res, next) {
    try {
      if (!(await appliesTo(req))) return next();
      await service.assertDataUseNotice({
        userId: req.user.id,
        requiredNoticeVersion,
      });
      return next();
    } catch (error) {
      if (error instanceof ClaritySettingsError) {
        return res.status(error.httpStatus).json(dataUseErrorBody(error));
      }
      return next(error);
    }
  };
}
