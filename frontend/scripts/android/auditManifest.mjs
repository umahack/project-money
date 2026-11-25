#!/usr/bin/env node
// Manifest audit for the Android release build (android-app-release spec, Requirement 14.1-14.3,
// Property 9). Audits a merged AndroidManifest.xml against a fixed, strict allowlist.
//
// Allowed uses-permission set: INTERNET, ACCESS_NETWORK_STATE, VIBRATE and the signature-level
// ${applicationId}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION; everything else is a violation.
//
// Library use:  auditManifest(xmlText, { applicationId? }) -> Violation[]
// CLI use:      node auditManifest.mjs <merged AndroidManifest.xml> [--application-id <id>]
//               exit 0: no violations, 1: violations printed, 2: usage / unreadable / malformed input.
//
// No dependencies: the XML handling is a small tokenizer that covers what Android manifests use
// (declaration, comments, CDATA, DOCTYPE, quoted attributes, self-closing tags, character references).

import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const ANDROID_NS = 'http://schemas.android.com/apk/res/android';

/** Rule identifiers carried in `violation.rule`. */
export const RULES = Object.freeze({
  DEBUGGABLE: 'debuggable',
  CLEARTEXT: 'usesCleartextTraffic',
  ALLOW_BACKUP: 'allowBackup',
  NETWORK_SECURITY_CONFIG: 'networkSecurityConfig',
  DATA_EXTRACTION_RULES: 'dataExtractionRules',
  FULL_BACKUP_CONTENT: 'fullBackupContent',
  EXPORTED: 'exported',
  EXPORTED_MISSING: 'exportedMissing',
  USES_PERMISSION: 'usesPermission',
  PERMISSION: 'permission',
});

const DYNAMIC_RECEIVER_PERMISSION = 'DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION';
// INTERNET reaches the API; ACCESS_NETWORK_STATE lets the WebView report navigator.onLine and fire
// online/offline events (Requirement 7); VIBRATE is added by @capacitor/haptics (Requirement 5).
const STATIC_ALLOWED_USES_PERMISSIONS = [
  'android.permission.INTERNET',
  'android.permission.ACCESS_NETWORK_STATE',
  'android.permission.VIBRATE',
];
const COMPONENT_TAGS = new Set(['activity', 'activity-alias', 'service', 'receiver', 'provider']);
const USES_PERMISSION_TAGS = new Set(['uses-permission', 'uses-permission-sdk-23']);
const ALLOWED_EXPORTED_ACTIVITY_SIMPLE_NAME = 'MainActivity';

/** The Allowed_Permission_Set for an application id (uses-permission names). */
export function allowedPermissions(applicationId) {
  return applicationId
    ? [...STATIC_ALLOWED_USES_PERMISSIONS, `${applicationId}.${DYNAMIC_RECEIVER_PERMISSION}`]
    : [...STATIC_ALLOWED_USES_PERMISSIONS];
}

// ---------------------------------------------------------------------------------------------
// XML parsing
// ---------------------------------------------------------------------------------------------

export class ManifestParseError extends Error {
  constructor(message, offset) {
    super(offset === undefined ? message : `${message} (at offset ${offset})`);
    this.name = 'ManifestParseError';
  }
}

const NAME_START = /[A-Za-z_:\u00C0-\uFFFF]/;
const NAME_CHAR = /[A-Za-z0-9_:.\-\u00B7\u00C0-\uFFFF]/;
const WS = /\s/;

function decodeEntities(value, offset) {
  return value.replace(/&(#x[0-9A-Fa-f]+|#[0-9]+|[A-Za-z]+);/g, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) {
        throw new ManifestParseError(`Invalid character reference "${whole}"`, offset);
      }
      return String.fromCodePoint(code);
    }
    switch (body) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      default: throw new ManifestParseError(`Unknown entity "${whole}"`, offset);
    }
  });
}

/**
 * Parse XML text into `{ name, attrs, children, offset }` (elements only; text is ignored).
 * Throws ManifestParseError if the document is not well formed.
 */
export function parseXml(text) {
  if (typeof text !== 'string') throw new ManifestParseError('Manifest text must be a string');
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = text.length;
  let root = null;
  const stack = [];

  const skipUntil = (terminator, what, from) => {
    const end = text.indexOf(terminator, from);
    if (end === -1) throw new ManifestParseError(`Unterminated ${what}`, from);
    return end + terminator.length;
  };

  const readName = (what) => {
    const start = i;
    if (i >= n || !NAME_START.test(text[i])) throw new ManifestParseError(`Expected ${what}`, i);
    i++;
    while (i < n && NAME_CHAR.test(text[i])) i++;
    return text.slice(start, i);
  };

  const skipWs = () => { while (i < n && WS.test(text[i])) i++; };

  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt === -1) {
      if (text.slice(i).trim() !== '' && stack.length === 0) {
        throw new ManifestParseError('Unexpected text outside the root element', i);
      }
      i = n;
      break;
    }
    if (stack.length === 0 && text.slice(i, lt).trim() !== '') {
      throw new ManifestParseError('Unexpected text outside the root element', i);
    }
    i = lt;

    if (text.startsWith('<!--', i)) {
      i = skipUntil('-->', 'comment', i + 4);
    } else if (text.startsWith('<![CDATA[', i)) {
      i = skipUntil(']]>', 'CDATA section', i + 9);
    } else if (text.startsWith('<?', i)) {
      i = skipUntil('?>', 'processing instruction', i + 2);
    } else if (text.startsWith('<!', i)) {
      // DOCTYPE, possibly with an internal subset in [...] that may contain '>' characters.
      let depth = 0;
      let quote = null;
      let j = i + 2;
      for (; j < n; j++) {
        const c = text[j];
        if (quote) { if (c === quote) quote = null; continue; }
        if (c === '"' || c === "'") quote = c;
        else if (c === '[') depth++;
        else if (c === ']') depth--;
        else if (c === '>' && depth <= 0) break;
      }
      if (j >= n) throw new ManifestParseError('Unterminated declaration', i);
      i = j + 1;
    } else if (text.startsWith('</', i)) {
      const at = i;
      i += 2;
      const name = readName('closing tag name');
      skipWs();
      if (text[i] !== '>') throw new ManifestParseError(`Malformed closing tag </${name}`, i);
      i++;
      const open = stack.pop();
      if (!open || open.name !== name) {
        throw new ManifestParseError(`Closing tag </${name}> does not match ${open ? `<${open.name}>` : 'any open element'}`, at);
      }
    } else {
      const at = i;
      i++;
      const name = readName('tag name');
      const attrs = Object.create(null);
      let selfClosing = false;
      for (;;) {
        const before = i;
        skipWs();
        if (i >= n) throw new ManifestParseError(`Unterminated tag <${name}`, at);
        if (text[i] === '>') { i++; break; }
        if (text[i] === '/') {
          if (text[i + 1] !== '>') throw new ManifestParseError(`Malformed tag <${name}`, i);
          selfClosing = true;
          i += 2;
          break;
        }
        if (i === before) throw new ManifestParseError(`Expected whitespace between attributes of <${name}>`, i);
        const attrName = readName('attribute name');
        skipWs();
        if (text[i] !== '=') throw new ManifestParseError(`Attribute "${attrName}" has no value`, i);
        i++;
        skipWs();
        const quote = text[i];
        if (quote !== '"' && quote !== "'") throw new ManifestParseError(`Attribute "${attrName}" value is not quoted`, i);
        const valueStart = i + 1;
        const valueEnd = text.indexOf(quote, valueStart);
        if (valueEnd === -1) throw new ManifestParseError(`Unterminated value for attribute "${attrName}"`, i);
        const raw = text.slice(valueStart, valueEnd);
        if (raw.includes('<')) throw new ManifestParseError(`"<" is not allowed in attribute "${attrName}"`, valueStart);
        if (attrName in attrs) throw new ManifestParseError(`Duplicate attribute "${attrName}" on <${name}>`, i);
        attrs[attrName] = decodeEntities(raw, valueStart);
        i = valueEnd + 1;
        if (i < n && !WS.test(text[i]) && text[i] !== '>' && text[i] !== '/') {
          throw new ManifestParseError(`Expected whitespace after attribute "${attrName}"`, i);
        }
      }
      const element = { name, attrs, children: [], offset: at };
      if (stack.length > 0) stack[stack.length - 1].children.push(element);
      else if (root) throw new ManifestParseError('More than one root element', at);
      else root = element;
      if (!selfClosing) stack.push(element);
    }
  }

  if (stack.length > 0) throw new ManifestParseError(`Unclosed element <${stack[stack.length - 1].name}>`, n);
  if (!root) throw new ManifestParseError('No root element found');
  return root;
}

// ---------------------------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------------------------

function* walk(element) {
  yield element;
  for (const child of element.children) yield* walk(child);
}

/** Prefix bound to the Android namespace on the root element (almost always "android"). */
function androidPrefix(root) {
  for (const [name, value] of Object.entries(root.attrs)) {
    if (name.startsWith('xmlns:') && value === ANDROID_NS) return name.slice('xmlns:'.length);
  }
  return 'android';
}

/** Android boolean attribute: 'true' | 'false' (case-insensitive) | 'unknown' (references, junk). */
function boolValue(value) {
  const v = value.trim().toLowerCase();
  if (v === 'true') return 'true';
  if (v === 'false') return 'false';
  return 'unknown';
}

function simpleName(componentName) {
  const dot = componentName.lastIndexOf('.');
  return dot === -1 ? componentName : componentName.slice(dot + 1);
}

/**
 * Audit a merged AndroidManifest.xml.
 *
 * @param {string} xmlText manifest XML
 * @param {{ applicationId?: string }} [options] applicationId defaults to the manifest's `package`
 * @returns {{ rule: string, subject: string, message: string }[]} every violation found, in document order
 *   within each rule group; empty when the manifest is clean.
 * @throws {ManifestParseError} when the XML is not well formed (nothing can be audited).
 */
export function auditManifest(xmlText, options = {}) {
  const root = parseXml(xmlText);
  const violations = [];
  const add = (rule, subject, message) => violations.push({ rule, subject, message });

  if (root.name !== 'manifest') {
    throw new ManifestParseError(`Root element is <${root.name}>, expected <manifest>`);
  }

  const prefix = androidPrefix(root);
  const attr = (el, local) => el.attrs[`${prefix}:${local}`];
  const applicationId = options.applicationId ?? root.attrs.package ?? '';
  const allowedUses = new Set(allowedPermissions(applicationId));
  const signaturePermissionName = applicationId ? `${applicationId}.${DYNAMIC_RECEIVER_PERMISSION}` : null;

  // --- application-level flags -------------------------------------------------------------
  const application = root.children.find((c) => c.name === 'application');

  const debuggable = application ? attr(application, 'debuggable') : undefined;
  if (debuggable !== undefined && boolValue(debuggable) !== 'false') {
    add(RULES.DEBUGGABLE, 'application',
      `android:debuggable="${debuggable}" on <application> (release builds must not be debuggable)`);
  }

  const cleartext = application ? attr(application, 'usesCleartextTraffic') : undefined;
  if (cleartext !== undefined && boolValue(cleartext) !== 'false') {
    add(RULES.CLEARTEXT, 'application', `android:usesCleartextTraffic="${cleartext}" on <application>`);
  }

  const allowBackup = application ? attr(application, 'allowBackup') : undefined;
  if (allowBackup === undefined) {
    add(RULES.ALLOW_BACKUP, 'application', 'android:allowBackup is absent on <application> (defaults to true); it must be "false"');
  } else if (boolValue(allowBackup) !== 'false') {
    add(RULES.ALLOW_BACKUP, 'application', `android:allowBackup="${allowBackup}" on <application>; it must be "false"`);
  }

  for (const [rule, local] of [
    [RULES.NETWORK_SECURITY_CONFIG, 'networkSecurityConfig'],
    [RULES.DATA_EXTRACTION_RULES, 'dataExtractionRules'],
    [RULES.FULL_BACKUP_CONTENT, 'fullBackupContent'],
  ]) {
    const value = application ? attr(application, local) : undefined;
    if (value === undefined || value.trim() === '') {
      add(rule, 'application', `android:${local} is missing on <application>`);
    }
  }

  // --- permissions -------------------------------------------------------------------------
  for (const el of walk(root)) {
    if (USES_PERMISSION_TAGS.has(el.name)) {
      const name = attr(el, 'name');
      if (name === undefined) {
        add(RULES.USES_PERMISSION, '(unnamed)', `<${el.name}> has no android:name`);
      } else if (!allowedUses.has(name)) {
        add(RULES.USES_PERMISSION, name, `<${el.name}> "${name}" is outside the allowed permission set`);
      }
    } else if (el.name === 'permission') {
      const name = attr(el, 'name');
      const level = attr(el, 'protectionLevel');
      if (name === undefined || name !== signaturePermissionName) {
        add(RULES.PERMISSION, name ?? '(unnamed)', `<permission> "${name ?? '(unnamed)'}" is not the allowed signature permission`);
      } else if (level !== 'signature') {
        add(RULES.PERMISSION, name,
          `<permission> "${name}" has android:protectionLevel=${level === undefined ? '(absent)' : `"${level}"`}; it must be "signature"`);
      }
    }
  }

  // --- exported components -----------------------------------------------------------------
  for (const el of walk(root)) {
    if (!COMPONENT_TAGS.has(el.name)) continue;
    const name = attr(el, 'name') ?? attr(el, 'targetActivity') ?? '(unnamed)';
    const exported = attr(el, 'exported');
    const label = `<${el.name}> ${name}`;
    const isMainActivity = el.name === 'activity' && simpleName(name) === ALLOWED_EXPORTED_ACTIVITY_SIMPLE_NAME;

    if (exported === undefined) {
      // From targetSdk 31 a component with an intent-filter must declare android:exported explicitly.
      if (el.children.some((c) => c.name === 'intent-filter')) {
        add(RULES.EXPORTED_MISSING, name, `${label} has an <intent-filter> but no explicit android:exported`);
      }
    } else if (boolValue(exported) !== 'false' && !isMainActivity) {
      add(RULES.EXPORTED, name, `${label} is exported (android:exported="${exported}"); only MainActivity may be exported`);
    }
  }

  return violations;
}

/** One printable line per violation. */
export function formatViolation(v) {
  return `[${v.rule}] ${v.message}`;
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const USAGE = 'Usage: node auditManifest.mjs <merged AndroidManifest.xml> [--application-id <id>]';

/** Run the CLI; returns the exit status. `io` is injectable for tests. */
export function main(argv, io = { out: (s) => console.log(s), err: (s) => console.error(s) }) {
  let file = null;
  let applicationId;
  for (let k = 0; k < argv.length; k++) {
    const arg = argv[k];
    if (arg === '--application-id') {
      applicationId = argv[++k];
      if (!applicationId) { io.err(USAGE); return 2; }
    } else if (arg.startsWith('--') || file !== null) {
      io.err(USAGE);
      return 2;
    } else {
      file = arg;
    }
  }
  if (file === null) { io.err(USAGE); return 2; }

  let violations;
  try {
    violations = auditManifest(readFileSync(file, 'utf8'), { applicationId });
  } catch (error) {
    io.err(`Manifest audit could not read ${file}: ${error.message}`);
    return 2;
  }

  if (violations.length === 0) {
    io.out(`Manifest audit passed: ${file}`);
    return 0;
  }
  io.err(`Manifest audit found ${violations.length} violation${violations.length === 1 ? '' : 's'} in ${file}:`);
  for (const v of violations) io.err(`  - ${formatViolation(v)}`);
  return 1;
}

function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = main(process.argv.slice(2));
}
