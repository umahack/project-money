#!/usr/bin/env node
// Verify_Script for the Android release build (android-app-release spec, Requirements 14.4-14.8, 8.5, 8.7).
//
//   npm run android:verify [-- <options>]        (from frontend/)
//
// Runs these steps IN ORDER on the built release outputs and stops at the first failing step
// (the failing step is named in the summary and the exit status is 1):
//
//   1. Manifest audit        auditManifest.mjs on the merged release manifest
//                            (app/build/intermediates/merged_manifests/release/processReleaseManifest/AndroidManifest.xml)
//   2. apksigner             `apksigner verify --verbose --print-certs` on the release APK; a debug certificate
//                            (subject containing "Android Debug") is rejected
//   3. jarsigner             `jarsigner -verify` on the release AAB; a debug certificate is rejected
//   4. aapt2 badging         `aapt2 dump badging`: package id, versionName (= package.json "version"),
//                            versionCode (= buildNumber when known), targetSdk 36, minSdk 24, not debuggable, and
//                            the permission list equals the Allowed_Permission_Set exactly
//   5. APK manifest audit    the manifest decoded from the APK (`aapt2 dump xmltree`) goes through the same audit
//   6. Release web bundle    the web bundle packaged in the APK (assets/public) or a directory given by --web-dir:
//                            no `accounts.google.com`, `localhost:4000`, `10.0.2.2`, `http://` API URL, or direct
//                            `console.<method>(` call site; the API origin is present; the CSP <meta> is present,
//                            has no 'unsafe-eval', and connect-src is 'self' plus the API origin only; the web-only
//                            SEO files (sitemap.xml, robots.txt) are not packaged
//
// Android SDK tools are resolved from ANDROID_HOME, ANDROID_SDK_ROOT, then ~/Library/Android/sdk (newest
// build-tools directory); they do not need to be on PATH. `jarsigner` comes from JAVA_HOME or PATH. No network access.
//
// Documented allowances in the bundle check (everything else is a failure):
//   * console: the bundled @capacitor/core contains exactly one default error handler, `<id>.console.error(err)`
//     (member access on the window/global object, not a bare `console.` call). Occurrences of that exact form are
//     allowed up to KNOWN_CAPACITOR_CONSOLE_ERROR_MAX (1) in total; a second one, any other `<id>.console.<m>(`
//     form, and every bare `console.<method>(` call is a failure.
//   * accounts.google.com: the lazy Google Sign-In loader keeps the literal `https://accounts.google.com/gsi/client`
//     in a JS chunk even though it never runs on native (Requirement 2.6). That one literal inside JS is reported as
//     a note; it is a failure in index.html/CSP, in any non-JS file, and in any other form.
//   * http://: XML namespace URIs (www.w3.org, schemas.*, purl.org, ns.adobe.com) and the bare `http://localhost`
//     that react-router uses as a placeholder base for URL parsing are not API URLs. Any other `http://` is a failure.
//
// Exit status: 0 all steps passed, 1 a step failed, 2 usage error.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditManifest, formatViolation, ManifestParseError } from './auditManifest.mjs';

export const APPLICATION_ID = 'online.projectmoney.app';
export const EXPECTED_TARGET_SDK = 36;
export const EXPECTED_MIN_SDK = 24;
export const API_BASE_FALLBACK = 'https://project-money-api.onrender.com'; // .env.android.example default
export const KNOWN_CAPACITOR_CONSOLE_ERROR_MAX = 1;
export const KNOWN_GSI_LITERAL = 'https://accounts.google.com/gsi/client';

export const ALLOWED_PERMISSIONS = Object.freeze([
  'android.permission.INTERNET',
  'android.permission.ACCESS_NETWORK_STATE',
  'android.permission.VIBRATE',
  `${APPLICATION_ID}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`,
]);

const ANDROID_NS_URI = 'http://schemas.android.com/apk/res/android';
const TEXT_EXTENSIONS = new Set(['.js', '.mjs', '.html', '.css', '.json', '.webmanifest', '.svg', '.txt', '.xml']);
const JS_EXTENSIONS = new Set(['.js', '.mjs']);
const HTTP_ALLOWED_HOSTS = [/^www\.w3\.org$/i, /^schemas\.[a-z0-9.-]+$/i, /^purl\.org$/i, /^ns\.adobe\.com$/i, /^www\.apple\.com$/i];
// Web-only SEO files that must not be packaged (same list as ANDROID_EXCLUDED_PUBLIC_FILES in build/androidBuild.ts).
export const ANDROID_EXCLUDED_WEB_FILES = Object.freeze(['sitemap.xml', 'robots.txt']);

// ---------------------------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------------------------

/** Compare dotted numeric versions: negative when a < b. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Stable build-tools directory names (e.g. "36.0.0"), newest first. Release candidates are ignored. */
export function sortBuildTools(names) {
  return names.filter((n) => /^\d+(\.\d+){0,3}$/.test(n)).sort((a, b) => compareVersions(b, a));
}

/** SDK root candidates in priority order (ANDROID_HOME, ANDROID_SDK_ROOT, ~/Library/Android/sdk). */
export function sdkRootCandidates(env, home) {
  return [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, path.join(home, 'Library', 'Android', 'sdk')].filter(Boolean);
}

/** Parse a dotenv-style file into an object (no interpolation). */
export function parseEnvFile(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    out[m[1]] = value;
  }
  return out;
}

/** Parse `apksigner verify --verbose --print-certs` output. */
export function parseApksigner(output) {
  const schemes = {};
  for (const m of output.matchAll(/^Verified using v([\d.]+) scheme[^:]*:\s*(true|false)\s*$/gm)) schemes[`v${m[1]}`] = m[2] === 'true';
  const signers = [];
  for (const m of output.matchAll(/^Signer #(\d+) certificate DN:\s*(.*)$/gm)) signers.push({ index: Number(m[1]), dn: m[2].trim() });
  return { verifies: /^Verifies\s*$/m.test(output), schemes, signers };
}

/** True for the Android debug keystore certificate (subject CN=Android Debug). */
export function isDebugCertificate(text) {
  return /Android Debug/i.test(text);
}

/** Parse `jarsigner -verify [-verbose -certs]` output. */
export function parseJarsigner(output) {
  return {
    verified: /^jar verified\./m.test(output),
    unsigned: /jar is unsigned/i.test(output),
    debugCertificate: isDebugCertificate(output),
  };
}

/** Parse `aapt2 dump badging` output. */
export function parseBadging(text) {
  const pkg = /^package: name='([^']*)'(?: versionCode='([^']*)')?(?: versionName='([^']*)')?/m.exec(text);
  const permissions = [...text.matchAll(/^uses-permission(?:-sdk-23)?: name='([^']+)'/gm)].map((m) => m[1]);
  return {
    packageName: pkg?.[1] ?? null,
    versionCode: pkg?.[2] ?? null,
    versionName: pkg?.[3] ?? null,
    minSdk: /^minSdkVersion:'(\d+)'/m.exec(text)?.[1] ?? null,
    targetSdk: /^targetSdkVersion:'(\d+)'/m.exec(text)?.[1] ?? null,
    permissions,
    debuggable: /^application-debuggable\b/m.test(text),
  };
}

/** Compare parsed badging with the expectation; returns [{ ok, label, detail }]. */
export function checkBadging(parsed, expected) {
  const checks = [];
  const eq = (label, actual, want) => checks.push({ ok: actual === want, label, detail: `got ${show(actual)}, expected ${show(want)}` });
  eq('package name', parsed.packageName, expected.packageName);
  eq('versionName (package.json version)', parsed.versionName, expected.versionName);
  if (expected.versionCode != null) {
    eq('versionCode (buildNumber)', parsed.versionCode, String(expected.versionCode));
  } else {
    const ok = /^[1-9]\d{0,9}$/.test(parsed.versionCode ?? '');
    checks.push({ ok, label: 'versionCode present', detail: `got ${show(parsed.versionCode)} (buildNumber not given; pass --build-number or BUILD_NUMBER to compare it)` });
  }
  eq('targetSdkVersion', parsed.targetSdk, String(expected.targetSdk));
  eq('minSdkVersion', parsed.minSdk, String(expected.minSdk));
  checks.push({ ok: !parsed.debuggable, label: 'not debuggable', detail: parsed.debuggable ? 'badging reports application-debuggable' : 'no application-debuggable entry' });
  const got = [...new Set(parsed.permissions)].sort();
  const want = [...expected.permissions].sort();
  const extra = got.filter((p) => !want.includes(p));
  const missing = want.filter((p) => !got.includes(p));
  checks.push({
    ok: extra.length === 0 && missing.length === 0 && got.length === parsed.permissions.length,
    label: 'permissions equal the Allowed_Permission_Set',
    detail: extra.length === 0 && missing.length === 0 ? got.join(', ') : `unexpected: [${extra.join(', ')}] missing: [${missing.join(', ')}]`,
  });
  return checks;
}

function show(v) {
  return v === null || v === undefined ? '(absent)' : `"${v}"`;
}

const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

function decodeXmltreeValue(raw) {
  const v = raw.startsWith('"') ? raw.replace(/ \(Raw: ".*"\)\s*$/, '') : raw;
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\(["\\])/g, '$1');
  const typed = /^\(type 0x([0-9a-f]+)\)0x([0-9a-f]+)$/i.exec(v);
  if (typed && typed[1].toLowerCase() === '12') return parseInt(typed[2], 16) === 0 ? 'false' : 'true';
  return v;
}

const PROTECTION_BASE = ['normal', 'dangerous', 'signature', 'signatureOrSystem'];

/**
 * Convert `aapt2 dump xmltree --file AndroidManifest.xml` output into manifest XML text that
 * auditManifest() can read. Booleans become true/false and a numeric protectionLevel becomes its
 * name when it is a plain base level (so only a pure `signature` level reads as "signature").
 */
export function xmltreeToManifestXml(text) {
  const prefixByUri = new Map();
  const rootHolder = { children: [] };
  const stack = [{ indent: -1, node: rootHolder }];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\s*)([NEAT]):\s?(.*)$/.exec(line);
    if (!m) continue;
    const indent = m[1].length;
    const body = m[3];
    if (m[2] === 'N') {
      const ns = /^([^=]+)=(.*?)(?:\s+\(line=\d+\))?$/.exec(body);
      if (ns) prefixByUri.set(ns[2], ns[1]);
    } else if (m[2] === 'E') {
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
      const node = { name: body.replace(/\s*\(line=\d+\)\s*$/, ''), attrs: [], children: [] };
      stack[stack.length - 1].node.children.push(node);
      stack.push({ indent, node });
    } else if (m[2] === 'A' && stack.length > 1) {
      const a = /^(.+?)(?:\(0x[0-9a-fA-F]+\))?=(.*)$/.exec(body);
      if (!a) continue;
      let name = a[1];
      for (const [uri, prefix] of prefixByUri) {
        if (name.startsWith(`${uri}:`)) { name = `${prefix}:${name.slice(uri.length + 1)}`; break; }
      }
      let value = decodeXmltreeValue(a[2]);
      if (name.endsWith(':protectionLevel') && /^0x[0-9a-f]+$/i.test(value)) {
        const n = parseInt(value, 16);
        value = n >= 0 && n < PROTECTION_BASE.length ? PROTECTION_BASE[n] : value;
      }
      stack[stack.length - 1].node.attrs.push([name, value]);
    }
  }
  const root = rootHolder.children[0];
  if (!root) throw new ManifestParseError('aapt2 xmltree output contains no elements');
  if (![...prefixByUri.values()].includes('android')) prefixByUri.set(ANDROID_NS_URI, 'android');
  const render = (node, depth) => {
    const attrs = node.attrs.map(([k, v]) => ` ${k}="${escapeXml(v)}"`).join('');
    const xmlns = depth === 0 ? [...prefixByUri].map(([uri, p]) => ` xmlns:${p}="${uri}"`).join('') : '';
    const pad = '  '.repeat(depth);
    if (node.children.length === 0) return `${pad}<${node.name}${xmlns}${attrs}/>\n`;
    return `${pad}<${node.name}${xmlns}${attrs}>\n${node.children.map((c) => render(c, depth + 1)).join('')}${pad}</${node.name}>\n`;
  };
  return render(root, 0);
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeHtmlEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** The decoded content of the Content-Security-Policy <meta>, or null when there is none. */
export function extractCspMeta(html) {
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (!/http-equiv\s*=\s*["']?content-security-policy["']?/i.test(tag[0])) continue;
    const content = /\bcontent\s*=\s*"([^"]*)"/i.exec(tag[0]) ?? /\bcontent\s*=\s*'([^']*)'/i.exec(tag[0]);
    if (content) return decodeHtmlEntities(content[1]);
  }
  return null;
}

/** directive -> tokens */
export function parseCsp(policy) {
  const out = new Map();
  for (const part of policy.split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length > 0) out.set(tokens[0].toLowerCase(), tokens.slice(1));
  }
  return out;
}

/** Checks on the CSP policy string; returns [{ ok, label, detail }]. */
export function checkCsp(policy, apiOrigin) {
  if (policy === null) return [{ ok: false, label: 'CSP <meta> present in index.html', detail: 'no <meta http-equiv="Content-Security-Policy"> found' }];
  const csp = parseCsp(policy);
  const all = [...csp.values()].flat();
  const connect = csp.get('connect-src') ?? csp.get('default-src') ?? [];
  const allowedConnect = new Set(["'self'", ...(apiOrigin ? [apiOrigin] : [])]);
  const badConnect = connect.filter((t) => !allowedConnect.has(t));
  return [
    { ok: true, label: 'CSP <meta> present in index.html', detail: `${csp.size} directives` },
    { ok: !all.includes("'unsafe-eval'"), label: "CSP has no 'unsafe-eval'", detail: all.includes("'unsafe-eval'") ? "'unsafe-eval' present" : 'absent' },
    { ok: !/accounts\.google\.com/i.test(policy), label: 'CSP does not reference accounts.google.com', detail: 'Google Sign-In is not available on Android' },
    {
      ok: badConnect.length === 0 && (!apiOrigin || connect.includes(apiOrigin)),
      label: "CSP connect-src is 'self' plus the API origin only",
      detail: badConnect.length > 0 ? `unexpected: ${badConnect.join(' ')}` : `connect-src ${connect.join(' ') || '(absent)'}`,
    },
  ];
}

function snippet(text, index, length) {
  const s = text.slice(Math.max(0, index - 30), index + length + 30).replace(/\s+/g, ' ');
  return s.length > 140 ? `${s.slice(0, 140)}...` : s;
}

/**
 * Scan packaged web files for forbidden content.
 * @param {{ path: string, text: string }[]} files text files only
 * @param {{ apiOrigin?: string }} [options]
 * @returns {{ findings: { rule: string, file: string, detail: string }[], notes: string[] }}
 */
export function scanBundle(files, options = {}) {
  const findings = [];
  const notes = [];
  const add = (rule, file, detail) => findings.push({ rule, file, detail });
  let capacitorConsoleErrors = 0;
  let apiOriginSeen = false;

  for (const { path: file, text } of files) {
    const ext = path.extname(file).toLowerCase();
    const isJs = JS_EXTENSIONS.has(ext);
    if (options.apiOrigin && text.includes(options.apiOrigin)) apiOriginSeen = true;

    for (const m of text.matchAll(/(?:https?:\/\/)?accounts\.google\.com[^\s"'`)<>\\;,]*/g)) {
      if (isJs && m[0] === KNOWN_GSI_LITERAL) {
        notes.push(`${file}: known gated Google Sign-In loader literal (not loaded on native)`);
      } else {
        add('accounts.google.com', file, snippet(text, m.index, m[0].length));
      }
    }
    for (const needle of ['localhost:4000', '10.0.2.2']) {
      let at = text.indexOf(needle);
      while (at !== -1) {
        add(needle, file, snippet(text, at, needle.length));
        at = text.indexOf(needle, at + needle.length);
      }
    }
    for (const m of text.matchAll(/http:\/\/([^\s"'`)<>\\;,{}|/?#]*)([^\s"'`)<>\\;,{}|]*)/g)) {
      const host = m[1];
      const bareLocalhost = host.toLowerCase() === 'localhost' && m[2] === '';
      if (bareLocalhost || HTTP_ALLOWED_HOSTS.some((re) => re.test(host))) continue;
      add('http://', file, snippet(text, m.index, m[0].length));
    }
    if (isJs) {
      for (const m of text.matchAll(/(^|[^\w$.])console\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
        add('console', file, `console.${m[2]}( ${snippet(text, m.index + m[1].length, 20)}`);
      }
      for (const m of text.matchAll(/([\w$]+)\s*\.\s*console\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
        if (m[2] === 'error') {
          capacitorConsoleErrors += 1;
          if (capacitorConsoleErrors === 1) notes.push(`${file}: known Capacitor runtime handler ${m[1]}.console.error(...)`);
          else add('console', file, `${m[1]}.console.error( beyond the one allowed Capacitor handler: ${snippet(text, m.index, 20)}`);
        } else {
          add('console', file, `${m[1]}.console.${m[2]}( ${snippet(text, m.index, 20)}`);
        }
      }
    }
  }
  if (capacitorConsoleErrors > KNOWN_CAPACITOR_CONSOLE_ERROR_MAX) {
    notes.push(`found ${capacitorConsoleErrors} \`<id>.console.error(\` sites, only ${KNOWN_CAPACITOR_CONSOLE_ERROR_MAX} is allowed`);
  }
  if (options.apiOrigin && !apiOriginSeen) add('api-origin', '(bundle)', `the API origin ${options.apiOrigin} does not appear in the bundle`);
  return { findings, notes };
}

/**
 * Paths of packaged web files that must not ship (ANDROID_EXCLUDED_WEB_FILES at the bundle root).
 * @param {string[]} paths bundle-relative paths, optionally prefixed with `assets/public/`
 * @returns {string[]}
 */
export function findExcludedWebFiles(paths) {
  return paths.filter((p) => ANDROID_EXCLUDED_WEB_FILES.includes(p.replace(/\\/g, '/').replace(/^assets\/public\//, '')));
}
/** Render the PASS/FAIL summary table. */
export function formatTable(results) {
  const rows = results.map((r, i) => [String(i + 1), r.name, r.status, r.summary ?? '']);
  const head = ['#', 'STEP', 'RESULT', 'DETAIL'];
  const widths = head.map((h, c) => Math.max(h.length, ...rows.map((r) => r[c].length)));
  const line = (cells) => cells.map((cell, c) => cell.padEnd(widths[c])).join('  ').trimEnd();
  return [line(head), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

const HELP = `Usage: node scripts/android/verify.mjs [options]      (npm run android:verify -- [options])

Verifies the built Android release outputs. Steps run in order and the first failing step stops the run:
  1. Manifest audit (merged release manifest)   2. apksigner verify (release APK)   3. jarsigner -verify (release AAB)
  4. aapt2 dump badging                          5. APK manifest audit (aapt2 xmltree)   6. Release web bundle

Options:
  --apk <file>            release APK        (default: android/app/build/outputs/apk/release/app-release.apk)
  --aab <file>            release AAB        (default: android/app/build/outputs/bundle/release/app-release.aab)
  --manifest <file>       merged manifest    (default: android/app/build/intermediates/merged_manifests/release/processReleaseManifest/AndroidManifest.xml)
  --web-dir <dir>         scan this web bundle directory instead of assets/public inside the APK
  --api-base <url>        expected API base  (default: VITE_API_BASE, then frontend/.env.android[.local], then .env.android.example)
  --build-number <n>      expected versionCode (default: BUILD_NUMBER, then buildNumber in android/gradle.properties)
  --self-test             run the built-in checks of the pure helpers and exit
  -h, --help              show this help

SDK tools: ANDROID_HOME, ANDROID_SDK_ROOT, then ~/Library/Android/sdk (newest build-tools); jarsigner from JAVA_HOME or PATH.
Exit status: 0 all steps passed, 1 a step failed, 2 usage error.`;

/** Parse argv; returns { options } or { error } or { help } or { selfTest }. */
export function parseArgs(argv) {
  const options = {};
  const valueFlags = { '--apk': 'apk', '--aab': 'aab', '--manifest': 'manifest', '--web-dir': 'webDir', '--api-base': 'apiBase', '--build-number': 'buildNumber' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return { help: true };
    if (arg === '--self-test') return { selfTest: true };
    if (arg in valueFlags) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) return { error: `${arg} needs a value` };
      options[valueFlags[arg]] = value;
    } else {
      return { error: `Unknown argument: ${arg}` };
    }
  }
  if (options.buildNumber !== undefined && !/^[1-9]\d{0,9}$/.test(options.buildNumber)) return { error: '--build-number must be a positive integer' };
  return { options };
}

// ---------------------------------------------------------------------------------------------
// Environment: tools, files, processes
// ---------------------------------------------------------------------------------------------

function run(command, args, extra = {}) {
  const r = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], ...extra });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
}

function resolveSdkTool(name) {
  const candidates = sdkRootCandidates(process.env, os.homedir());
  const root = candidates.find((c) => existsSync(path.join(c, 'build-tools')));
  if (!root) {
    throw new Error(`Android SDK build-tools not found. Looked in: ${candidates.join(', ')}. Set ANDROID_HOME (or ANDROID_SDK_ROOT) to your SDK, or install build-tools with the SDK Manager.`);
  }
  for (const version of sortBuildTools(readdirSync(path.join(root, 'build-tools')))) {
    const file = path.join(root, 'build-tools', version, name);
    if (existsSync(file)) return file;
  }
  throw new Error(`"${name}" was not found in any ${path.join(root, 'build-tools')}/<version> directory. Install Android SDK build-tools with the SDK Manager.`);
}

function resolveJarsigner() {
  const candidates = [];
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, 'bin', 'jarsigner'));
  candidates.push('/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/jarsigner');
  for (const c of candidates) if (existsSync(c)) return c;
  const probe = run('jarsigner', ['-help']);
  if (!probe.error) return 'jarsigner';
  throw new Error('jarsigner was not found. Install a JDK, or set JAVA_HOME to one (jarsigner is a JDK tool, not an Android SDK tool).');
}

function fileExists(p) {
  try { return statSync(p).isFile(); } catch { return false; }
}

function listFiles(dir, accept) {
  try {
    return readdirSync(dir).map((n) => path.join(dir, n)).filter((p) => fileExists(p) && accept(path.basename(p))).sort();
  } catch { return []; }
}

function findApk(apkDir) {
  const all = listFiles(apkDir, (n) => n.endsWith('.apk'));
  const signed = all.filter((p) => !/unsigned/i.test(p) && !/androidTest/i.test(p));
  const preferred = signed.find((p) => path.basename(p) === 'app-release.apk') ?? signed[0];
  if (preferred) return preferred;
  if (all.length > 0) throw new Error(`Only an unsigned release APK was found (${all.map((p) => path.basename(p)).join(', ')}) in ${apkDir}. Build with keystore.properties configured so assembleRelease signs it.`);
  throw new Error(`No release APK in ${apkDir}. Run \`npm run android:release -- -PbuildNumber=<n>\` first.`);
}

function findAab(bundleDir) {
  const all = listFiles(bundleDir, (n) => n.endsWith('.aab'));
  const found = all.find((p) => path.basename(p) === 'app-release.aab') ?? all[0];
  if (!found) throw new Error(`No release AAB in ${bundleDir}. Run \`npm run android:release -- -PbuildNumber=<n>\` first.`);
  return found;
}

function findMergedManifest(androidDir) {
  const base = path.join(androidDir, 'app', 'build', 'intermediates', 'merged_manifests', 'release');
  const preferred = path.join(base, 'processReleaseManifest', 'AndroidManifest.xml');
  if (fileExists(preferred)) return preferred;
  try {
    for (const d of readdirSync(base)) {
      const f = path.join(base, d, 'AndroidManifest.xml');
      if (fileExists(f)) return f;
    }
  } catch { /* fall through */ }
  throw new Error(`Merged release manifest not found at ${preferred}. Run the release build first.`);
}

function readTextIfExists(file) {
  return fileExists(file) ? readFileSync(file, 'utf8') : null;
}

function resolveApiBase(frontendDir, explicit) {
  if (explicit) return { value: explicit, source: '--api-base' };
  if (process.env.VITE_API_BASE) return { value: process.env.VITE_API_BASE, source: 'VITE_API_BASE' };
  for (const name of ['.env.android.local', '.env.android']) {
    const text = readTextIfExists(path.join(frontendDir, name));
    const value = text ? parseEnvFile(text).VITE_API_BASE : undefined;
    if (value) return { value, source: name };
  }
  const example = readTextIfExists(path.join(frontendDir, '.env.android.example'));
  const exampleValue = example ? parseEnvFile(example).VITE_API_BASE : undefined;
  return { value: exampleValue || API_BASE_FALLBACK, source: '.env.android.example (fallback)' };
}

function resolveBuildNumber(androidDir, explicit) {
  if (explicit) return Number(explicit);
  if (/^[1-9]\d{0,9}$/.test(process.env.BUILD_NUMBER ?? '')) return Number(process.env.BUILD_NUMBER);
  const props = readTextIfExists(path.join(androidDir, 'gradle.properties'));
  const m = props ? /^\s*buildNumber\s*=\s*(\d+)\s*$/m.exec(props) : null;
  return m ? Number(m[1]) : null;
}

/** Read the packaged web bundle text files from an APK (assets/public/**) using unzip. */
function readApkWebBundle(apk) {
  const list = run('unzip', ['-Z1', apk]);
  if (list.error || list.status !== 0) throw new Error(`Could not list ${apk} with unzip: ${list.error?.message ?? list.stderr.trim()}`);
  const entries = list.stdout.split('\n').filter((e) => e.startsWith('assets/public/') && !e.endsWith('/'));
  const files = [];
  for (const entry of entries) {
    if (!TEXT_EXTENSIONS.has(path.extname(entry).toLowerCase())) continue;
    const r = run('unzip', ['-p', apk, entry.replace(/[[\]*?\\]/g, '\\$&')]);
    if (r.status !== 0) throw new Error(`Could not read ${entry} from the APK: ${r.stderr.trim()}`);
    files.push({ path: entry, text: r.stdout });
  }
  return { files, entryCount: entries.length, paths: entries };
}

function readDirWebBundle(dir) {
  const files = [];
  const paths = [];
  let entryCount = 0;
  const walkDir = (d) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      if (statSync(p).isDirectory()) walkDir(p);
      else {
        entryCount += 1;
        paths.push(path.relative(dir, p));
        if (TEXT_EXTENSIONS.has(path.extname(name).toLowerCase())) files.push({ path: path.relative(dir, p), text: readFileSync(p, 'utf8') });
      }
    }
  };
  walkDir(dir);
  return { files, entryCount, paths };
}

// ---------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------

const chk = (ok, label, detail = '') => ({ ok, label, detail });

function auditChecks(xml, label) {
  const violations = auditManifest(xml, { applicationId: APPLICATION_ID });
  if (violations.length === 0) return [chk(true, `${label} passes the manifest audit`)];
  return violations.map((v) => chk(false, `${label}: audit violation`, formatViolation(v)));
}

function buildSteps(ctx) {
  const state = {};
  const apk = () => (state.apk ??= ctx.apk ?? findApk(path.join(ctx.androidDir, 'app', 'build', 'outputs', 'apk', 'release')));
  return [
    {
      name: 'Manifest audit (merged release manifest)',
      run: () => {
        const file = ctx.manifest ?? findMergedManifest(ctx.androidDir);
        return [chk(true, 'manifest file', path.relative(ctx.frontendDir, file)), ...auditChecks(readFileSync(file, 'utf8'), 'merged release manifest')];
      },
    },
    {
      name: 'apksigner verify (release APK)',
      run: () => {
        const file = apk();
        const r = run(resolveSdkTool('apksigner'), ['verify', '--verbose', '--print-certs', file]);
        if (r.error) throw r.error;
        const out = `${r.stdout}\n${r.stderr}`;
        const parsed = parseApksigner(out);
        const checks = [chk(true, 'APK', path.relative(ctx.frontendDir, file))];
        checks.push(chk(r.status === 0 && parsed.verifies, 'apksigner verify succeeds', r.status === 0 ? 'Verifies' : `exit ${r.status}: ${out.trim().split('\n').slice(0, 3).join(' | ')}`));
        checks.push(chk(Object.entries(parsed.schemes).some(([k, v]) => k !== 'v1' && v), 'signed with APK Signature Scheme v2 or later', JSON.stringify(parsed.schemes)));
        checks.push(chk(parsed.signers.length > 0, 'signer certificate reported', parsed.signers.map((s) => s.dn).join('; ') || 'none'));
        checks.push(chk(!isDebugCertificate(out), 'not signed with the Android debug certificate', isDebugCertificate(out) ? 'certificate subject contains "Android Debug"' : 'upload/release certificate'));
        return checks;
      },
    },
    {
      name: 'jarsigner -verify (release AAB)',
      run: () => {
        const file = ctx.aab ?? findAab(path.join(ctx.androidDir, 'app', 'build', 'outputs', 'bundle', 'release'));
        const r = run(resolveJarsigner(), ['-verify', '-verbose', '-certs', file]);
        if (r.error) throw r.error;
        const parsed = parseJarsigner(`${r.stdout}\n${r.stderr}`);
        return [
          chk(true, 'AAB', path.relative(ctx.frontendDir, file)),
          chk(r.status === 0 && parsed.verified && !parsed.unsigned, 'jarsigner -verify reports "jar verified."', r.status === 0 ? (parsed.unsigned ? 'jar is unsigned' : 'ok') : `exit ${r.status}`),
          chk(!parsed.debugCertificate, 'not signed with the Android debug certificate', parsed.debugCertificate ? 'certificate subject contains "Android Debug"' : 'upload/release certificate'),
        ];
      },
    },
    {
      name: 'aapt2 dump badging',
      run: () => {
        const r = run(resolveSdkTool('aapt2'), ['dump', 'badging', apk()]);
        if (r.error || r.status !== 0) throw new Error(`aapt2 dump badging failed: ${r.error?.message ?? r.stderr.trim()}`);
        return checkBadging(parseBadging(r.stdout), {
          packageName: APPLICATION_ID,
          versionName: ctx.versionName,
          versionCode: ctx.buildNumber,
          targetSdk: EXPECTED_TARGET_SDK,
          minSdk: EXPECTED_MIN_SDK,
          permissions: ALLOWED_PERMISSIONS,
        });
      },
    },
    {
      name: 'APK manifest audit (aapt2 xmltree)',
      run: () => {
        const r = run(resolveSdkTool('aapt2'), ['dump', 'xmltree', '--file', 'AndroidManifest.xml', apk()]);
        if (r.error || r.status !== 0) throw new Error(`aapt2 dump xmltree failed: ${r.error?.message ?? r.stderr.trim()}`);
        return auditChecks(xmltreeToManifestXml(r.stdout), 'manifest decoded from the APK');
      },
    },
    {
      name: 'Release web bundle',
      run: () => {
        const api = ctx.api;
        let origin;
        try { origin = new URL(api.value).origin; } catch { throw new Error(`API base "${api.value}" (from ${api.source}) is not a valid URL.`); }
        const source = ctx.webDir ? readDirWebBundle(ctx.webDir) : readApkWebBundle(apk());
        const where = ctx.webDir ? ctx.webDir : `${path.basename(apk())}!/assets/public`;
        const checks = [
          chk(source.entryCount > 0, 'packaged web bundle found', `${source.entryCount} files in ${where}`),
          chk(origin.startsWith('https://'), 'API base is https', `${origin} (from ${api.source})`),
        ];
        if (source.entryCount === 0) return checks;
        const { findings, notes } = scanBundle(source.files, { apiOrigin: origin });
        const byRule = new Map();
        for (const f of findings) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);
        const rules = [
          ['accounts.google.com', 'no accounts.google.com reference'],
          ['localhost:4000', 'no localhost:4000'],
          ['10.0.2.2', 'no 10.0.2.2'],
          ['http://', 'no http:// API URL'],
          ['console', 'no console.* call sites'],
          ['api-origin', 'API origin present in the bundle'],
        ];
        for (const [rule, label] of rules) {
          const hits = byRule.get(rule) ?? [];
          const shown = hits.slice(0, 5).map((h) => `${h.file}: ${h.detail}`).join(' || ');
          checks.push(chk(hits.length === 0, label, hits.length === 0 ? 'none' : `${hits.length} found: ${shown}${hits.length > 5 ? ' || ...' : ''}`));
        }
        const excluded = findExcludedWebFiles(source.paths);
        checks.push(chk(excluded.length === 0, 'no web-only SEO files (sitemap.xml, robots.txt)', excluded.length === 0 ? 'none' : `found: ${excluded.join(', ')}`));
        for (const n of [...new Set(notes)]) checks.push(chk(true, 'note (allowed)', n));
        const index = source.files.find((f) => /(^|\/)index\.html$/.test(f.path.replace(/^assets\/public\//, '')));
        if (!index) checks.push(chk(false, 'CSP <meta> present in index.html', 'index.html not found in the bundle'));
        else checks.push(...checkCsp(extractCspMeta(index.text), origin));
        return checks;
      },
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------------------------

/** Run steps in order and stop at the first failure. Returns { results, ok }. */
export function runSteps(steps, io) {
  const results = [];
  let failed = false;
  for (const step of steps) {
    if (failed) { results.push({ name: step.name, status: 'SKIPPED', summary: 'an earlier step failed' }); continue; }
    io.out(`\n== ${step.name}`);
    let checks;
    try {
      checks = step.run();
    } catch (error) {
      checks = [chk(false, 'step could not run', error.message)];
    }
    for (const c of checks) io.out(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.label}${c.detail ? ` - ${c.detail}` : ''}`);
    const bad = checks.filter((c) => !c.ok);
    if (bad.length > 0) failed = true;
    results.push({ name: step.name, status: bad.length === 0 ? 'PASS' : 'FAIL', summary: bad.length === 0 ? `${checks.length} checks` : `${bad.length} of ${checks.length} checks failed: ${bad[0].label}` });
  }
  return { results, ok: !failed };
}

export function main(argv, io = { out: (s) => console.log(s), err: (s) => console.error(s) }) {
  const parsed = parseArgs(argv);
  if (parsed.help) { io.out(HELP); return 0; }
  if (parsed.error) { io.err(`${parsed.error}\n\n${HELP}`); return 2; }
  if (parsed.selfTest) return selfTest(io);

  const frontendDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const androidDir = path.join(frontendDir, 'android');
  const o = parsed.options;
  let versionName;
  try {
    versionName = JSON.parse(readFileSync(path.join(frontendDir, 'package.json'), 'utf8')).version;
    if (!versionName) throw new Error('no "version" field');
  } catch (error) {
    io.err(`Cannot read the version from ${path.join(frontendDir, 'package.json')}: ${error.message}`);
    return 1;
  }
  const abs = (p) => (p === undefined ? undefined : path.resolve(process.cwd(), p));
  const ctx = {
    frontendDir,
    androidDir,
    versionName,
    apk: abs(o.apk),
    aab: abs(o.aab),
    manifest: abs(o.manifest),
    webDir: abs(o.webDir),
    api: resolveApiBase(frontendDir, o.apiBase),
    buildNumber: resolveBuildNumber(androidDir, o.buildNumber),
  };
  io.out(`Android release verification (versionName ${versionName}, buildNumber ${ctx.buildNumber ?? 'unknown'}, API base ${ctx.api.value})`);
  const { results, ok } = runSteps(buildSteps(ctx), io);
  io.out(`\n${formatTable(results)}`);
  if (ok) { io.out('\nRESULT: PASS'); return 0; }
  const failedStep = results.find((r) => r.status === 'FAIL');
  io.err(`\nRESULT: FAIL - step "${failedStep.name}" failed; later steps were not run.`);
  return 1;
}

// ---------------------------------------------------------------------------------------------
// --self-test: tiny checks of the pure helpers (no files, no tools)
// ---------------------------------------------------------------------------------------------

export function selfTest(io = { out: console.log, err: console.error }) {
  const cases = [];
  const test = (name, fn) => cases.push([name, fn]);
  const eq = (a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };

  test('sortBuildTools picks the newest stable version first', () => eq(sortBuildTools(['35.0.0', '36.0.0', '9.0.0', '36.1.0-rc1']), ['36.0.0', '35.0.0', '9.0.0']));
  test('parseBadging + checkBadging accept the allowed set', () => {
    const text = [`package: name='${APPLICATION_ID}' versionCode='7' versionName='2.0.0'`, "minSdkVersion:'24'", "targetSdkVersion:'36'",
      ...ALLOWED_PERMISSIONS.map((p) => `uses-permission: name='${p}'`)].join('\n');
    eq(checkBadging(parseBadging(text), { packageName: APPLICATION_ID, versionName: '2.0.0', versionCode: 7, targetSdk: 36, minSdk: 24, permissions: ALLOWED_PERMISSIONS }).filter((c) => !c.ok), []);
    const bad = `${text}\nuses-permission: name='android.permission.CAMERA'`;
    eq(checkBadging(parseBadging(bad), { packageName: APPLICATION_ID, versionName: '2.0.0', versionCode: 7, targetSdk: 36, minSdk: 24, permissions: ALLOWED_PERMISSIONS }).filter((c) => !c.ok).length, 1);
  });
  test('checkBadging requires ACCESS_NETWORK_STATE (offline detection) and rejects ACCESS_WIFI_STATE', () => {
    const base = [`package: name='${APPLICATION_ID}' versionCode='7' versionName='2.0.0'`, "minSdkVersion:'24'", "targetSdkVersion:'36'"];
    const expected = { packageName: APPLICATION_ID, versionName: '2.0.0', versionCode: 7, targetSdk: 36, minSdk: 24, permissions: ALLOWED_PERMISSIONS };
    const without = ALLOWED_PERMISSIONS.filter((p) => p !== 'android.permission.ACCESS_NETWORK_STATE');
    const missing = [...base, ...without.map((p) => `uses-permission: name='${p}'`)].join('\n');
    eq(checkBadging(parseBadging(missing), expected).filter((c) => !c.ok).length, 1);
    const wifi = [...base, ...ALLOWED_PERMISSIONS.map((p) => `uses-permission: name='${p}'`), "uses-permission: name='android.permission.ACCESS_WIFI_STATE'"].join('\n');
    eq(checkBadging(parseBadging(wifi), expected).filter((c) => !c.ok).length, 1);
  });
  test('parseApksigner detects a debug certificate', () => {
    const out = 'Verifies\nVerified using v2 scheme (APK Signature Scheme v2): true\nSigner #1 certificate DN: C=US, O=Android, CN=Android Debug';
    const p = parseApksigner(out);
    eq([p.verifies, p.schemes.v2, isDebugCertificate(p.signers[0].dn)], [true, true, true]);
  });
  test('xmltreeToManifestXml feeds auditManifest', () => {
    const tree = [
      'N: android=http://schemas.android.com/apk/res/android (line=2)',
      '  E: manifest (line=2)',
      '    A: package="online.projectmoney.app" (Raw: "online.projectmoney.app")',
      '      E: permission (line=5)',
      '        A: http://schemas.android.com/apk/res/android:name(0x01010003)="online.projectmoney.app.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION" (Raw: "x")',
      '        A: http://schemas.android.com/apk/res/android:protectionLevel(0x01010009)=0x00000002',
      '      E: application (line=9)',
      '        A: http://schemas.android.com/apk/res/android:allowBackup(0x01010280)=false',
      '        A: http://schemas.android.com/apk/res/android:networkSecurityConfig(0x01010527)=@0x7f100004',
      '        A: http://schemas.android.com/apk/res/android:dataExtractionRules(0x0101063e)=@0x7f100002',
      '        A: http://schemas.android.com/apk/res/android:fullBackupContent(0x010104eb)=@0x7f100000',
      '          E: receiver (line=12)',
      '            A: http://schemas.android.com/apk/res/android:name(0x01010003)="x.R" (Raw: "x.R")',
      '            A: http://schemas.android.com/apk/res/android:exported(0x01010010)=true',
    ].join('\n');
    const v = auditManifest(xmltreeToManifestXml(tree), { applicationId: APPLICATION_ID });
    eq(v.map((x) => x.rule), ['exported']);
  });
  test('scanBundle allows exactly one Capacitor console.error and flags the rest', () => {
    const ok = scanBundle([{ path: 'a.js', text: 'const h=e=>e.console.error(e);fetch(`https://api.example.com/x`)' }], { apiOrigin: 'https://api.example.com' });
    eq(ok.findings, []);
    const bad = scanBundle([{ path: 'a.js', text: 'e.console.error(1);x.console.error(2);console.log(3);fetch("http://10.0.2.2:4000/a");"https://api.example.com"' }], { apiOrigin: 'https://api.example.com' });
    eq([...new Set(bad.findings.map((f) => f.rule))].sort(), ['10.0.2.2', 'console', 'http://']);
  });
  test('scanBundle ignores namespace URIs and the react-router localhost base', () => {
    const r = scanBundle([{ path: 'a.js', text: 'a="http://www.w3.org/2000/svg";new URL(`http://localhost`);"https://api.example.com"' }], { apiOrigin: 'https://api.example.com' });
    eq(r.findings, []);
  });
  test('scanBundle no longer allows the sitemap namespace URI', () => {
    eq(scanBundle([{ path: 'sitemap.xml', text: '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' }]).findings.map((f) => f.rule), ['http://']);
  });
  test('findExcludedWebFiles flags root sitemap.xml and robots.txt only', () => {
    eq(findExcludedWebFiles(['assets/public/index.html', 'assets/public/sitemap.xml', 'assets/public/robots.txt', 'assets/public/assets/robots.txt']),
      ['assets/public/sitemap.xml', 'assets/public/robots.txt']);
    eq(findExcludedWebFiles(['index.html', 'robots.txt', 'og.png']), ['robots.txt']);
    eq(findExcludedWebFiles(['index.html', 'manifest.webmanifest']), []);
  });
  test('scanBundle allows only the known GSI literal in JS', () => {
    eq(scanBundle([{ path: 'a.js', text: `s="${KNOWN_GSI_LITERAL}"` }]).findings, []);
    eq(scanBundle([{ path: 'index.html', text: `<script src="${KNOWN_GSI_LITERAL}">` }]).findings.length, 1);
  });
  test('extractCspMeta decodes entities and checkCsp judges the policy', () => {
    const html = '<meta http-equiv="Content-Security-Policy" content="default-src &#39;self&#39;; connect-src &#39;self&#39; https://api.example.com">';
    const policy = extractCspMeta(html);
    eq(policy, "default-src 'self'; connect-src 'self' https://api.example.com");
    eq(checkCsp(policy, 'https://api.example.com').filter((c) => !c.ok), []);
    eq(checkCsp("script-src 'unsafe-eval'; connect-src 'self' http://x", 'https://api.example.com').filter((c) => !c.ok).length, 2);
    eq(checkCsp(null, null)[0].ok, false);
  });

  let failed = 0;
  for (const [name, fn] of cases) {
    try { fn(); io.out(`ok   ${name}`); } catch (error) { failed += 1; io.err(`FAIL ${name}: ${error.message}`); }
  }
  io.out(`${cases.length - failed}/${cases.length} self-tests passed`);
  return failed === 0 ? 0 : 1;
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
