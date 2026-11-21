import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * Repository assertions for task 17.2 (retire duplicate calculations and broad
 * reload/loading paths).
 *
 * The flag-off legacy pages are the rollback path, so they keep their browser
 * math, session cache, and one `window.location.reload()`. These assertions
 * make that exception exact: it is confined to named legacy functions, and
 * nothing a clarity page runs can reach it or any other document reload.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

interface Source {
  rel: string;
  file: ts.SourceFile;
}

function walk(directory: string, found: string[] = []): string[] {
  for (const name of readdirSync(directory)) {
    const full = join(directory, name);
    if (statSync(full).isDirectory()) walk(full, found);
    else if (['.ts', '.tsx'].includes(extname(full))) found.push(full);
  }
  return found;
}

/** Every production source file: no tests, fixtures, or declaration files. */
const SOURCES: Source[] = walk(SRC)
  .map((full) => ({ full, rel: relative(SRC, full).split('\\').join('/') }))
  .filter(({ rel }) => !/\.test\.tsx?$/.test(rel) && !rel.startsWith('test/') && !rel.endsWith('.d.ts'))
  .map(({ full, rel }) => ({
    rel,
    file: ts.createSourceFile(rel, readFileSync(full, 'utf8'), ts.ScriptTarget.ES2022, true, rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS),
  }));

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  ts.forEachChild(node, (child) => visit(child, callback));
}

/** Name of the top-level function or component that contains `node`, or ''. */
function topLevelOwner(node: ts.Node): string {
  let current: ts.Node = node;
  while (current.parent && !ts.isSourceFile(current.parent)) current = current.parent;
  if (ts.isFunctionDeclaration(current)) return current.name?.text ?? '';
  if (ts.isVariableStatement(current)) {
    const declaration = current.declarationList.declarations[0];
    return declaration && ts.isIdentifier(declaration.name) ? declaration.name.text : '';
  }
  return '';
}

function isInsideImport(node: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isImportDeclaration(current)) return true;
  }
  return false;
}

const NAVIGATING_MEMBERS = new Set(['reload', 'assign', 'replace']);

/** `location.reload()`, `location.assign()`, `location.replace()`, `location.href = …`, `location = …`, `history.go()`. */
function documentNavigations(source: Source): { owner: string; text: string }[] {
  const found: { owner: string; text: string }[] = [];
  visit(source.file, (node) => {
    if (ts.isPropertyAccessExpression(node)) {
      const target = node.expression.getText(source.file);
      const isLocation = target === 'location' || target.endsWith('.location');
      if (isLocation && NAVIGATING_MEMBERS.has(node.name.text)) {
        found.push({ owner: topLevelOwner(node), text: node.getText(source.file) });
      }
      if (isLocation && node.name.text === 'href' && ts.isBinaryExpression(node.parent)
        && node.parent.left === node && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        found.push({ owner: topLevelOwner(node), text: node.parent.getText(source.file) });
      }
      if ((target === 'history' || target.endsWith('.history')) && node.name.text === 'go') {
        found.push({ owner: topLevelOwner(node), text: node.getText(source.file) });
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const left = node.left.getText(source.file);
      if (left === 'location' || left.endsWith('.location')) {
        found.push({ owner: topLevelOwner(node), text: node.getText(source.file) });
      }
    }
  });
  return found;
}

describe('rollback-only legacy paths (task 17.2)', () => {
  it('finds the production sources it is meant to scan', () => {
    const rels = SOURCES.map((source) => source.rel);
    expect(rels).toEqual(expect.arrayContaining(['pages/Plan.tsx', 'pages/Dashboard.tsx', 'api.ts', 'clarity/rollout.ts']));
    expect(rels.some((rel) => rel.endsWith('.test.tsx') || rel.startsWith('test/'))).toBe(false);
  });

  it('only the flag-off LegacyPlan page may reload or navigate the document', () => {
    const found = SOURCES.flatMap((source) => documentNavigations(source).map((hit) => ({ rel: source.rel, ...hit })));

    // Exact match: removing the legacy reload must also remove this allowance.
    expect(found).toEqual([
      { rel: 'pages/Plan.tsx', owner: 'LegacyPlan', text: 'window.location.reload' },
    ]);
  });

  it('no clarity-owned function or module reloads the document', () => {
    const clarityOwned = SOURCES.filter((source) => (
      /^(clarity|components\/(clarity|dashboard|goals|journey|plan|spending|trips))\//.test(source.rel)
      || source.rel === 'pages/GuidedJourneyPage.tsx'
    ));
    expect(clarityOwned.length).toBeGreaterThan(20);
    for (const source of clarityOwned) expect(documentNavigations(source), source.rel).toEqual([]);

    // Page hosts mix a Clarity* and a Legacy* branch. Only the Clarity* functions are held to the rule.
    for (const source of SOURCES.filter((candidate) => candidate.rel.startsWith('pages/'))) {
      const inClarityFunction = documentNavigations(source).filter((hit) => hit.owner.startsWith('Clarity'));
      expect(inClarityFunction, source.rel).toEqual([]);
    }
  });

  it('every financial-change report states that nothing reloaded and no page-wide loading appeared', () => {
    const reports: string[] = [];
    for (const source of SOURCES.filter((candidate) => candidate.rel !== 'clarity/measurement.ts')) {
      visit(source.file, (node) => {
        if (!ts.isPropertyAssignment(node) || !ts.isIdentifier(node.name)) return;
        if (node.name.text !== 'causedReload' && node.name.text !== 'causedPageWideLoading') return;
        reports.push(`${source.rel}:${node.name.text}`);
        expect(node.initializer.kind, `${source.rel} ${node.name.text}`).toBe(ts.SyntaxKind.FalseKeyword);
      });
    }
    // The three mutation hooks and the pay/bills form each report; losing one would hide a regression.
    expect(reports.filter((entry) => entry.endsWith('causedReload')).length).toBeGreaterThanOrEqual(3);
    expect(reports.filter((entry) => entry.endsWith('causedPageWideLoading')).length).toBeGreaterThanOrEqual(3);
  });

  it('no Clarity* page function returns early to replace the page while data loads', () => {
    const LOADING_CONDITION = /load|fetch|pending|busy|spinner/i;
    for (const source of SOURCES) {
      visit(source.file, (node) => {
        if (!ts.isFunctionDeclaration(node) || !node.body || !node.name?.text.startsWith('Clarity')) return;
        for (const statement of node.body.statements) {
          if (!ts.isIfStatement(statement)) continue;
          let returns = false;
          visit(statement.thenStatement, (inner) => { if (ts.isReturnStatement(inner)) returns = true; });
          if (!returns) continue;
          expect(LOADING_CONDITION.test(statement.expression.getText(source.file)), `${source.rel} ${node.name.text}: ${statement.expression.getText(source.file)}`).toBe(false);
        }
      });
    }
  });

  const ROLLBACK_MODULES: Record<string, string[]> = {
    // module (relative to src, no extension) -> the only files that may import it
    insights: ['components/FiveYearProjection.tsx', 'pages/Dashboard.tsx', 'pages/Plan.tsx'],
    'hooks/useCachedPlan': ['api.ts', 'pages/Dashboard.tsx', 'pages/Plan.tsx'],
    'components/FiveYearProjection': ['pages/Dashboard.tsx'],
  };

  it('only legacy pages import the rollback-only browser math and financial session cache', () => {
    const importers: Record<string, string[]> = Object.fromEntries(Object.keys(ROLLBACK_MODULES).map((name) => [name, []]));
    for (const source of SOURCES) {
      visit(source.file, (node) => {
        if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
        const specifier = node.moduleSpecifier.text;
        if (!specifier.startsWith('.')) return;
        const target = relative(SRC, resolve(SRC, dirname(source.rel), specifier)).split('\\').join('/');
        if (target in importers) importers[target]!.push(source.rel);
      });
    }
    for (const [name, allowed] of Object.entries(ROLLBACK_MODULES)) {
      expect([...importers[name]!].sort(), name).toEqual(allowed);
    }
  });

  it('legacy math and cache are referenced only from Legacy* functions, never from a Clarity* branch', () => {
    const ROLLBACK_NAMES = new Set(['buildInsights', 'buildProjection', 'legacyDemoInsights', 'readCachedPlan', 'writeCachedPlan', 'FiveYearProjection']);
    const hosts = SOURCES.filter((source) => ['pages/Dashboard.tsx', 'pages/Plan.tsx'].includes(source.rel));
    expect(hosts).toHaveLength(2);
    for (const source of hosts) {
      const uses: string[] = [];
      visit(source.file, (node) => {
        if (!ts.isIdentifier(node) || !ROLLBACK_NAMES.has(node.text) || isInsideImport(node)) return;
        uses.push(`${node.text} in ${topLevelOwner(node)}`);
        expect(topLevelOwner(node), `${source.rel}: ${node.text}`).toMatch(/^Legacy/);
      });
      expect(uses.length, source.rel).toBeGreaterThan(0);
    }
  });

  it('no Clarity* function renders or calls a Legacy* component', () => {
    for (const source of SOURCES) {
      visit(source.file, (node) => {
        if (!ts.isIdentifier(node) || !node.text.startsWith('Legacy') || isInsideImport(node)) return;
        const owner = topLevelOwner(node);
        expect(owner.startsWith('Clarity'), `${source.rel}: ${node.text} used in ${owner}`).toBe(false);
      });
    }
  });
});
