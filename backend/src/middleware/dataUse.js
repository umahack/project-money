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
 * A gate with no fixed version resolves the current version from the settings
 * service for every request, so a flag change needs no process restart.
 * Read, correction, export, and deletion routes do not install this gate.
 */
export function createDataUseNoticeGate({
  requiredNoticeVersion,
  appliesTo = () => true,
  service = claritySettingsService,
} = {}) {
  if (requiredNoticeVersion !== undefined
    && (!Number.isSafeInteger(requiredNoticeVersion)
      || requiredNoticeVersion < 0
      || requiredNoticeVersion > CURRENT_DATA_USE_NOTICE_VERSION)) {
    throw new RangeError(
      `requiredNoticeVersion must be between 0 and ${CURRENT_DATA_USE_NOTICE_VERSION}.`
    );
  }
  if (typeof appliesTo !== 'function') throw new TypeError('appliesTo must be a function.');
  if (!service || typeof service.assertDataUseNotice !== 'function') {
    throw new TypeError('A clarity settings service with assertDataUseNotice() is required.');
  }
  if (requiredNoticeVersion === undefined
    && typeof service.currentDataUseNoticeVersion !== 'function') {
    throw new TypeError(
      'A dynamic data-use gate requires currentDataUseNoticeVersion() on the settings service.'
    );
  }

  return async function dataUseNoticeGate(req, res, next) {
    try {
      if (!(await appliesTo(req))) return next();
      const resolvedNoticeVersion = requiredNoticeVersion
        ?? service.currentDataUseNoticeVersion();
      await service.assertDataUseNotice({
        userId: req.user.id,
        requiredNoticeVersion: resolvedNoticeVersion,
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
