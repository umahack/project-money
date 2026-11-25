export const ANDROID_NS: string;
export const RULES: Readonly<{
  DEBUGGABLE: 'debuggable';
  CLEARTEXT: 'usesCleartextTraffic';
  ALLOW_BACKUP: 'allowBackup';
  NETWORK_SECURITY_CONFIG: 'networkSecurityConfig';
  DATA_EXTRACTION_RULES: 'dataExtractionRules';
  FULL_BACKUP_CONTENT: 'fullBackupContent';
  EXPORTED: 'exported';
  EXPORTED_MISSING: 'exportedMissing';
  USES_PERMISSION: 'usesPermission';
  PERMISSION: 'permission';
}>;
export interface Violation {
  rule: string;
  subject: string;
  message: string;
}
export interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  offset: number;
}
export class ManifestParseError extends Error {
  constructor(message: string, offset?: number);
}
export function allowedPermissions(applicationId?: string): string[];
export function parseXml(text: string): XmlElement;
export function auditManifest(xmlText: string, options?: { applicationId?: string }): Violation[];
export function formatViolation(violation: Violation): string;
export function main(argv: string[], io?: { out: (s: string) => void; err: (s: string) => void }): number;
