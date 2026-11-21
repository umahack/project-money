export const CLARITY_CONTRACT_HEADER = 'X-Clarity-Contract';
export const CLARITY_CONTRACT_VERSION = '1';

function headerValue(request, name) {
  if (request && typeof request.get === 'function') return request.get(name);

  const headers = request?.headers;
  if (!headers || typeof headers !== 'object') return undefined;
  const match = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase()
  );
  if (!match) return undefined;
  return Array.isArray(match[1]) ? match[1].join(',') : match[1];
}

export function requestsClarityContract(request) {
  return headerValue(request, CLARITY_CONTRACT_HEADER) === CLARITY_CONTRACT_VERSION;
}

function assertResponseObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value;
}

/**
 * Keep the exact legacy body unless contract version 1 was requested. A
 * negotiated response adds canonical envelopes without nesting, renaming, or
 * removing any legacy top-level field.
 */
export function negotiateClarityContract(request, legacyResponse, contractResponse) {
  const legacy = assertResponseObject(legacyResponse, 'legacyResponse');
  if (!requestsClarityContract(request)) return legacy;

  const contract = assertResponseObject(contractResponse, 'contractResponse');
  const hasClarity = Object.hasOwn(contract, 'clarity');
  const hasMutation = Object.hasOwn(contract, 'mutation');
  if (!hasClarity && !hasMutation) {
    throw new TypeError('contractResponse must include clarity or mutation.');
  }

  return {
    ...legacy,
    ...(Object.hasOwn(contract, 'schemaVersion')
      ? { schemaVersion: contract.schemaVersion }
      : {}),
    ...(hasMutation ? { mutation: contract.mutation } : {}),
    ...(hasClarity ? { clarity: contract.clarity } : {}),
  };
}
