import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  allowedPermissions,
  auditManifest,
  formatViolation,
  main,
  ManifestParseError,
  RULES,
} from '../../scripts/android/auditManifest.mjs';

const fixtureDir = path.join(__dirname, 'fixtures');
const cleanPath = path.join(fixtureDir, 'clean-release-manifest.xml');
const violatingPath = path.join(fixtureDir, 'violating-release-manifest.xml');
const cleanXml = fs.readFileSync(cleanPath, 'utf8');
const violatingXml = fs.readFileSync(violatingPath, 'utf8');

function runMain(argv: string[]): { status: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const status = main(argv, { out: (s) => out.push(s), err: (s) => err.push(s) });
  return { status, out, err };
}

describe('auditManifest fixtures', () => {
  it('yields no violations for the clean merged release manifest', () => {
    expect(auditManifest(cleanXml)).toEqual([]);
  });

  it('the clean fixture holds the four allowed uses-permission entries, the signature permission and only MainActivity exported', () => {
    expect(cleanXml).toContain('android.permission.INTERNET');
    expect(cleanXml).toContain('android.permission.ACCESS_NETWORK_STATE');
    expect(cleanXml).toContain('android.permission.VIBRATE');
    expect(cleanXml.match(/<uses-permission /g)).toHaveLength(4);
    expect(cleanXml).toContain('android:protectionLevel="signature"');
    expect(cleanXml.match(/android:exported="true"/g)).toHaveLength(1);
    expect(allowedPermissions('online.projectmoney.app')).toEqual([
      'android.permission.INTERNET',
      'android.permission.ACCESS_NETWORK_STATE',
      'android.permission.VIBRATE',
      'online.projectmoney.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION',
    ]);
  });

  it('yields exactly the expected rules for the violating fixture', () => {
    const violations = auditManifest(violatingXml);
    expect(violations.map((v) => v.rule).sort()).toEqual(
      [
        RULES.DEBUGGABLE,
        RULES.CLEARTEXT,
        RULES.ALLOW_BACKUP,
        RULES.USES_PERMISSION,
        RULES.EXPORTED,
        RULES.NETWORK_SECURITY_CONFIG,
      ].sort(),
    );
    expect(violations.find((v) => v.rule === RULES.USES_PERMISSION)?.subject).toBe('android.permission.CAMERA');
    expect(violations.find((v) => v.rule === RULES.EXPORTED)?.subject).toBe('androidx.profileinstaller.ProfileInstallReceiver');
  });

  it('allows ACCESS_NETWORK_STATE but flags a look-alike and any other network permission', () => {
    expect(auditManifest(cleanXml)).toEqual([]);
    for (const name of ['android.permission.ACCESS_WIFI_STATE', 'android.permission.CHANGE_NETWORK_STATE', 'android.permission.ACCESS_NETWORK_STATE.extra']) {
      const xml = cleanXml.replace('</manifest>', `<uses-permission android:name="${name}" /></manifest>`);
      const violations = auditManifest(xml);
      expect(violations.map((v) => v.rule)).toEqual([RULES.USES_PERMISSION]);
      expect(violations[0]?.subject).toBe(name);
    }
  });

  it('flags a permission declaration that is not the signature one', () => {
    const xml = cleanXml.replace('android:protectionLevel="signature"', 'android:protectionLevel="normal"');
    expect(auditManifest(xml).map((v) => v.rule)).toEqual([RULES.PERMISSION]);
  });

  it('flags the stock ProfileInstallReceiver when it is left in the manifest', () => {
    const receiver = `<receiver android:name="androidx.profileinstaller.ProfileInstallReceiver"
      android:exported="true" android:permission="android.permission.DUMP"><intent-filter>
      <action android:name="androidx.profileinstaller.action.INSTALL_PROFILE" /></intent-filter></receiver>`;
    const xml = cleanXml.replace('</application>', `${receiver}</application>`);
    expect(auditManifest(xml).map((v) => v.rule)).toEqual([RULES.EXPORTED]);
  });

  it('reports the missing application attributes when there is no <application>', () => {
    const xml = '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="a.b"></manifest>';
    expect(auditManifest(xml).map((v) => v.rule).sort()).toEqual(
      [RULES.ALLOW_BACKUP, RULES.NETWORK_SECURITY_CONFIG, RULES.DATA_EXTRACTION_RULES, RULES.FULL_BACKUP_CONTENT].sort(),
    );
  });
});

describe('auditManifest CLI main', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-manifest-cli-'));
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  it('exits 0 and reports success for the clean fixture', () => {
    const { status, out, err } = runMain([cleanPath]);
    expect(status).toBe(0);
    expect(out.join('\n')).toContain('Manifest audit passed');
    expect(err).toEqual([]);
  });

  it('exits 1 and prints every violation for the violating fixture', () => {
    const { status, out, err } = runMain([violatingPath]);
    expect(status).toBe(1);
    expect(out).toEqual([]);
    const expected = auditManifest(violatingXml);
    expect(expected).toHaveLength(6);
    expect(err[0]).toContain('6 violations');
    for (const v of expected) expect(err).toContain(`  - ${formatViolation(v)}`);
  });

  it('honours --application-id', () => {
    // With a different application id the real signature permission is no longer in the allowed set.
    const { status, err } = runMain([cleanPath, '--application-id', 'com.example.other']);
    expect(status).toBe(1);
    expect(err.join('\n')).toContain('[usesPermission]');
    expect(err.join('\n')).toContain('[permission]');
  });

  it('exits 2 on usage errors', () => {
    for (const argv of [[], ['--bogus'], [cleanPath, 'extra'], [cleanPath, '--application-id']]) {
      const { status, err } = runMain(argv);
      expect(status).toBe(2);
      expect(err.join('\n')).toContain('Usage:');
    }
  });

  it('exits 2 when the file is unreadable', () => {
    const { status, err } = runMain([path.join(tmpDir, 'does-not-exist.xml')]);
    expect(status).toBe(2);
    expect(err.join('\n')).toContain('could not read');
  });

  it('exits 2 when the file is malformed XML', () => {
    const bad = path.join(tmpDir, 'bad.xml');
    fs.writeFileSync(bad, '<manifest><application></manifest>');
    const { status, err } = runMain([bad]);
    expect(status).toBe(2);
    expect(err.join('\n')).toContain('could not read');
  });
});

describe('auditManifest malformed input', () => {
  const malformed: [string, string][] = [
    ['empty text', ''],
    ['mismatched closing tag', '<manifest><application></manifest>'],
    ['unclosed element', '<manifest><application>'],
    ['unquoted attribute value', '<manifest package=a.b></manifest>'],
    ['unterminated attribute value', '<manifest package="a.b></manifest>'],
    ['unknown entity', '<manifest package="a&bogus;b"></manifest>'],
    ['two root elements', '<manifest></manifest><manifest></manifest>'],
    ['duplicate attribute', '<manifest package="a" package="b"></manifest>'],
    ['text outside the root', 'hello <manifest></manifest>'],
    ['unterminated comment', '<manifest><!-- oops</manifest>'],
  ];

  it.each(malformed)('throws ManifestParseError for %s', (_label, xml) => {
    expect(() => auditManifest(xml)).toThrow(ManifestParseError);
  });

  it('throws ManifestParseError when the root element is not <manifest>', () => {
    expect(() => auditManifest('<resources></resources>')).toThrow(ManifestParseError);
  });

  it('throws ManifestParseError for non-string input', () => {
    expect(() => auditManifest(undefined as unknown as string)).toThrow(ManifestParseError);
  });
});
