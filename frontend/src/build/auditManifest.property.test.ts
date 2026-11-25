import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { assertProperty } from '../test/propertyReport';
import { auditManifest, formatViolation, main, RULES } from '../../scripts/android/auditManifest.mjs';

// ---------------------------------------------------------------------------------------------
// A manifest-shaped model, a renderer to XML, and an independent reference predicate.
// ---------------------------------------------------------------------------------------------

type ComponentTag = 'activity' | 'activity-alias' | 'service' | 'receiver' | 'provider';
type UsesTag = 'uses-permission' | 'uses-permission-sdk-23';

interface Component {
  tag: ComponentTag;
  name: string;
  exported: string | undefined;
  intentFilter: boolean;
}
interface UsesPermission {
  tag: UsesTag;
  name: string;
}
interface PermissionDecl {
  name: string;
  level: string | undefined;
}
interface ManifestModel {
  prefix: string;
  pkg: string;
  /** applicationId option passed to the audit; undefined means "use the manifest package". */
  optionId: string | undefined;
  debuggable: string | undefined;
  cleartext: string | undefined;
  allowBackup: string | undefined;
  networkSecurityConfig: string | undefined;
  dataExtractionRules: string | undefined;
  fullBackupContent: string | undefined;
  uses: UsesPermission[];
  permissions: PermissionDecl[];
  components: Component[];
}

const DYN = 'DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION';
const FALSE_TOKENS = ['false', 'False', 'FALSE'];
const TRUE_TOKENS = ['true', 'True', 'TRUE'];
const REFERENCE_TOKENS = ['@bool/flag', '?attr/flag', '@xml/whatever'];
/** Values that are not a literal false: true in any case, or a resource reference. */
const NOT_FALSE_TOKENS = [...TRUE_TOKENS, ...REFERENCE_TOKENS];
const MAIN = 'online.projectmoney.app.MainActivity';
const COMPONENT_TAGS: ComponentTag[] = ['receiver', 'service', 'provider', 'activity', 'activity-alias'];

const falseValue = fc.constantFrom(...FALSE_TOKENS);
const notFalseValue = fc.constantFrom(...NOT_FALSE_TOKENS);
const anyFlag = fc.option(fc.oneof(falseValue, notFalseValue), { nil: undefined });
const resourceRef = fc.constantFrom('@xml/network_security_config', '@xml/data_extraction_rules', '@xml/backup_rules');
const refOrMissing = fc.option(fc.oneof(resourceRef, fc.constant('')), { nil: undefined });

const packageName = fc.constantFrom('online.projectmoney.app', 'com.example.other');
const prefix = fc.constantFrom('android', 'a', 'and');

const otherNames = ['androidx.profileinstaller.ProfileInstallReceiver', 'com.example.SyncService', '.LegacyActivity', 'com.example.Files'];
const componentName = fc.constantFrom(MAIN, 'com.other.MainActivity', 'MainActivity', 'online.projectmoney.app.MainActivityAlias', ...otherNames);
const componentTag = fc.constantFrom<ComponentTag>(...COMPONENT_TAGS);
const component: fc.Arbitrary<Component> = fc.record({
  tag: componentTag,
  name: componentName,
  exported: fc.option(fc.oneof(falseValue, notFalseValue), { nil: undefined }),
  intentFilter: fc.boolean(),
});

const usesTag = fc.constantFrom<UsesTag>('uses-permission', 'uses-permission-sdk-23');
const disallowedNames = [
  'android.permission.CAMERA',
  'android.permission.INTERNET.extra',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_NETWORK_STATE.extra',
  'com.example.other.' + DYN,
  'online.projectmoney.app.OTHER_PERMISSION',
];

/** uses-permission names drawn from the allowed pool and the disallowed pool. */
function usesArbitrary(effectiveId: string): fc.Arbitrary<UsesPermission> {
  return fc.record({
    tag: usesTag,
    name: fc.constantFrom(
      'android.permission.INTERNET',
      'android.permission.ACCESS_NETWORK_STATE',
      'android.permission.VIBRATE',
      `${effectiveId}.${DYN}`,
      `${effectiveId}.${DYN}`,
      ...disallowedNames,
    ),
  });
}

function permissionArbitrary(effectiveId: string): fc.Arbitrary<PermissionDecl> {
  return fc.record({
    name: fc.constantFrom(`${effectiveId}.${DYN}`, `${effectiveId}.${DYN}`, `${effectiveId}.OTHER`, 'com.example.other.' + DYN),
    level: fc.constantFrom<string | undefined>('signature', 'signature', 'normal', 'dangerous', 'signatureOrSystem', undefined),
  });
}

const manifestModel: fc.Arbitrary<ManifestModel> = fc
  .tuple(packageName, fc.option(packageName, { nil: undefined }))
  .chain(([pkg, optionId]) => {
    const effective = optionId ?? pkg;
    return fc.record({
      prefix,
      pkg: fc.constant(pkg),
      optionId: fc.constant(optionId),
      debuggable: anyFlag,
      cleartext: anyFlag,
      allowBackup: anyFlag,
      networkSecurityConfig: refOrMissing,
      dataExtractionRules: refOrMissing,
      fullBackupContent: refOrMissing,
      uses: fc.array(usesArbitrary(effective), { maxLength: 6 }),
      permissions: fc.array(permissionArbitrary(effective), { maxLength: 3 }),
      components: fc.array(component, { maxLength: 6 }),
    });
  });

/** A model that breaks no rule, with harmless random variation. */
const cleanModel: fc.Arbitrary<ManifestModel> = fc
  .tuple(packageName, fc.boolean(), prefix)
  .chain(([pkg, explicitId, pfx]) => {
    const dyn = `${pkg}.${DYN}`;
    const allowedUses = ['android.permission.INTERNET', 'android.permission.ACCESS_NETWORK_STATE', 'android.permission.VIBRATE', dyn];
    return fc.record({
      prefix: fc.constant(pfx),
      pkg: fc.constant(pkg),
      optionId: fc.constant(explicitId ? pkg : undefined),
      debuggable: fc.option(falseValue, { nil: undefined }),
      cleartext: fc.option(falseValue, { nil: undefined }),
      allowBackup: falseValue,
      networkSecurityConfig: resourceRef,
      dataExtractionRules: resourceRef,
      fullBackupContent: resourceRef,
      uses: fc
        .subarray(allowedUses)
        .chain((names) => fc.tuple(...names.map((name) => usesTag.map((tag) => ({ tag, name }))))) as fc.Arbitrary<UsesPermission[]>,
      permissions: fc.constantFrom<PermissionDecl[]>([], [{ name: dyn, level: 'signature' }]),
      components: fc
        .tuple(
          fc.record({
            tag: fc.constant<ComponentTag>('activity'),
            name: fc.constant(MAIN),
            exported: fc.constantFrom<string | undefined>('true', 'True', ...FALSE_TOKENS, undefined),
            intentFilter: fc.boolean(),
          }),
          fc.array(
            fc.record({
              tag: componentTag,
              name: fc.constantFrom(...otherNames),
              exported: fc.option(falseValue, { nil: undefined }),
              intentFilter: fc.boolean(),
            }),
            { maxLength: 4 },
          ),
        )
        // Only MainActivity may be exported, and a component with an intent-filter needs an explicit value.
        .map(([mainActivity, others]): Component[] => [
          { ...mainActivity, exported: mainActivity.intentFilter && mainActivity.exported === undefined ? 'true' : mainActivity.exported },
          ...others.map((c) => ({ ...c, exported: c.intentFilter && c.exported === undefined ? 'false' : c.exported })),
        ]),
    });
  });

function attr(model: ManifestModel, name: string, value: string | undefined): string {
  return value === undefined ? '' : `\n      ${model.prefix}:${name}="${value}"`;
}

function render(model: ManifestModel): string {
  const p = model.prefix;
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="utf-8"?>');
  lines.push(`<manifest xmlns:${p}="http://schemas.android.com/apk/res/android" package="${model.pkg}">`);
  for (const u of model.uses) lines.push(`  <${u.tag} ${p}:name="${u.name}" />`);
  for (const d of model.permissions) {
    lines.push(`  <permission ${p}:name="${d.name}"${d.level === undefined ? '' : ` ${p}:protectionLevel="${d.level}"`} />`);
  }
  lines.push(
    '  <application'
    + attr(model, 'debuggable', model.debuggable)
    + attr(model, 'usesCleartextTraffic', model.cleartext)
    + attr(model, 'allowBackup', model.allowBackup)
    + attr(model, 'networkSecurityConfig', model.networkSecurityConfig)
    + attr(model, 'dataExtractionRules', model.dataExtractionRules)
    + attr(model, 'fullBackupContent', model.fullBackupContent)
    + '>',
  );
  for (const c of model.components) {
    const exported = c.exported === undefined ? '' : ` ${p}:exported="${c.exported}"`;
    const open = `    <${c.tag} ${p}:name="${c.name}"${exported}`;
    lines.push(
      c.intentFilter
        ? `${open}>\n      <intent-filter><action ${p}:name="android.intent.action.MAIN" /></intent-filter>\n    </${c.tag}>`
        : `${open} />`,
    );
  }
  lines.push('  </application>', '</manifest>');
  return lines.join('\n');
}

/**
 * Independent reference: the sorted list of rule ids the model breaks, one entry per offending
 * element, written directly from the allowlist in the design rather than from the script's code paths.
 */
function referenceRules(model: ManifestModel): string[] {
  const out: string[] = [];
  const effectiveId = model.optionId ?? model.pkg;
  const isFalse = (v: string) => FALSE_TOKENS.includes(v);

  if (model.debuggable !== undefined && !isFalse(model.debuggable)) out.push(RULES.DEBUGGABLE);
  if (model.cleartext !== undefined && !isFalse(model.cleartext)) out.push(RULES.CLEARTEXT);
  if (model.allowBackup === undefined || !isFalse(model.allowBackup)) out.push(RULES.ALLOW_BACKUP);
  if (!model.networkSecurityConfig) out.push(RULES.NETWORK_SECURITY_CONFIG);
  if (!model.dataExtractionRules) out.push(RULES.DATA_EXTRACTION_RULES);
  if (!model.fullBackupContent) out.push(RULES.FULL_BACKUP_CONTENT);

  const allowedUses = [
    'android.permission.INTERNET',
    'android.permission.ACCESS_NETWORK_STATE',
    'android.permission.VIBRATE',
    `${effectiveId}.${DYN}`,
  ];
  for (const u of model.uses) if (!allowedUses.includes(u.name)) out.push(RULES.USES_PERMISSION);

  for (const d of model.permissions) {
    if (d.name !== `${effectiveId}.${DYN}` || d.level !== 'signature') out.push(RULES.PERMISSION);
  }

  for (const c of model.components) {
    const mayBeExported = c.tag === 'activity' && (c.name === 'MainActivity' || c.name.endsWith('.MainActivity'));
    if (c.exported === undefined) {
      if (c.intentFilter) out.push(RULES.EXPORTED_MISSING);
    } else if (!isFalse(c.exported) && !mayBeExported) {
      out.push(RULES.EXPORTED);
    }
  }
  return out.sort();
}

function auditOptions(model: ManifestModel): { applicationId?: string } {
  return model.optionId === undefined ? {} : { applicationId: model.optionId };
}

function audit(model: ManifestModel): string[] {
  return auditManifest(render(model), auditOptions(model)).map((v) => v.rule).sort();
}

// ---------------------------------------------------------------------------------------------
// Single-fault injection into a clean model.
// ---------------------------------------------------------------------------------------------

interface Fault {
  rule: string;
  apply: (model: ManifestModel, pick: number) => ManifestModel;
}

const notFalse = (k: number): string => NOT_FALSE_TOKENS[k % NOT_FALSE_TOKENS.length] as string;

const FAULTS: Fault[] = [
  { rule: RULES.DEBUGGABLE, apply: (m, k) => ({ ...m, debuggable: notFalse(k) }) },
  { rule: RULES.CLEARTEXT, apply: (m, k) => ({ ...m, cleartext: notFalse(k) }) },
  { rule: RULES.ALLOW_BACKUP, apply: (m, k) => ({ ...m, allowBackup: k % 3 === 0 ? undefined : notFalse(k) }) },
  { rule: RULES.NETWORK_SECURITY_CONFIG, apply: (m, k) => ({ ...m, networkSecurityConfig: k % 2 === 0 ? undefined : '' }) },
  { rule: RULES.DATA_EXTRACTION_RULES, apply: (m, k) => ({ ...m, dataExtractionRules: k % 2 === 0 ? undefined : '' }) },
  { rule: RULES.FULL_BACKUP_CONTENT, apply: (m, k) => ({ ...m, fullBackupContent: k % 2 === 0 ? undefined : '' }) },
  {
    rule: RULES.USES_PERMISSION,
    apply: (m, k) => {
      // The foreign-package DYNAMIC_RECEIVER name is only disallowed when the package differs.
      const pool = disallowedNames.filter((name) => name !== `${m.pkg}.${DYN}`);
      return {
        ...m,
        uses: [...m.uses, { tag: k % 2 === 0 ? 'uses-permission' : 'uses-permission-sdk-23', name: pool[k % pool.length] as string }],
      };
    },
  },
  {
    rule: RULES.PERMISSION,
    apply: (m, k) => ({
      ...m,
      permissions: [
        // Either replace the valid declaration with a wrong protection level, or add a second, wrongly named one.
        ...m.permissions.filter((d) => k % 2 !== 0 || d.name !== `${m.pkg}.${DYN}`),
        k % 2 === 0
          ? { name: `${m.pkg}.${DYN}`, level: ['normal', 'dangerous', 'signatureOrSystem', undefined][Math.floor(k / 2) % 4] }
          : { name: `${m.pkg}.OTHER`, level: 'signature' },
      ],
    }),
  },
  {
    rule: RULES.EXPORTED,
    apply: (m, k) => ({
      ...m,
      components: [
        ...m.components,
        {
          tag: COMPONENT_TAGS[k % 5] as ComponentTag,
          name: k % 5 === 3 ? 'com.example.OtherActivity' : (otherNames[k % otherNames.length] as string),
          exported: notFalse(k),
          intentFilter: k % 2 === 0,
        },
      ],
    }),
  },
  {
    rule: RULES.EXPORTED_MISSING,
    apply: (m, k) => ({
      ...m,
      components: [
        ...m.components,
        { tag: COMPONENT_TAGS[k % 5] as ComponentTag, name: otherNames[k % otherNames.length] as string, exported: undefined, intentFilter: true },
      ],
    }),
  },
];

// ---------------------------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------------------------

describe('auditManifest properties', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-manifest-'));
  afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // Feature: android-app-release, Property 9: The manifest audit flags exactly the configured violations
  it('reports exactly the rules the generated manifest breaks, and exits 0 iff there are none', () => {
    const file = path.join(tmpDir, 'AndroidManifest.xml');
    assertProperty(
      fc.property(manifestModel, (model) => {
        const expected = referenceRules(model);
        expect(audit(model)).toEqual(expected);

        fs.writeFileSync(file, render(model));
        const argv = model.optionId === undefined ? [file] : [file, '--application-id', model.optionId];
        const err: string[] = [];
        const status = main(argv, { out: () => undefined, err: (s) => err.push(s) });
        expect(status).toBe(expected.length === 0 ? 0 : 1);
        // The CLI prints every violation, not just the first: one header plus one line per violation.
        expect(err.length).toBe(expected.length === 0 ? 0 : expected.length + 1);
        for (const v of auditManifest(render(model), auditOptions(model))) {
          expect(err).toContain(`  - ${formatViolation(v)}`);
        }
      }),
    );
  });

  // Feature: android-app-release, Property 9: The manifest audit flags exactly the configured violations
  it('reports no violation for a clean generated manifest', () => {
    assertProperty(
      fc.property(cleanModel, (model) => {
        expect(referenceRules(model)).toEqual([]);
        expect(audit(model)).toEqual([]);
      }),
    );
  });

  // Feature: android-app-release, Property 9: The manifest audit flags exactly the configured violations
  it('reports exactly the matching rule for any single injected fault', () => {
    assertProperty(
      fc.property(cleanModel, fc.integer({ min: 0, max: FAULTS.length - 1 }), fc.nat(1000), (model, faultIndex, pick) => {
        const fault = FAULTS[faultIndex] as Fault;
        const faulty = fault.apply(model, pick);
        expect(audit(faulty)).toEqual([fault.rule]);
        expect(referenceRules(faulty)).toEqual([fault.rule]);
      }),
    );
  });
});
