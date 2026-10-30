// The app bundle is CommonJS: Metro turns every ES module into CommonJS before Hermes runs it. A library whose ES
// build only works as a real ES module therefore runs fine in Node (and in every other test here) and throws on the
// phone. @sinclair/typebox 0.34 is one: its object.mjs declares a top-level `var Object`, which breaks the
// `Object.defineProperty(exports, '__esModule', ...)` line the CommonJS transform puts first. The root layout loads
// it through the Trezor link, so the release APK closed as soon as it opened. metro.config.js resolves it to its
// CommonJS build instead; these tests keep it that way.
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const mobileRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireHere = createRequire(path.join(mobileRoot, 'package.json'));
// Babel as Metro runs it (expo depends on it; the app does not, so no types for it here).
const { transformSync } = requireHere('@babel/core') as {
  transformSync(code: string, options: Record<string, unknown>): { code?: string | null } | null;
};

type Context = { isESMImport?: boolean; resolveRequest: (c: Context, name: string, platform: string | null) => unknown };
type MetroConfig = { resolver: { resolveRequest: (c: Context, name: string, platform: string | null) => unknown } };

/** What metro.config.js passes on to Metro's own resolver for `moduleName`, imported with `import`. */
function contextSeenFor(moduleName: string): Context {
  const config = requireHere('./metro.config.js') as MetroConfig;
  let seen: Context | undefined;
  const context: Context = {
    isESMImport: true,
    resolveRequest: (c) => {
      seen = c;
      return { type: 'sourceFile', filePath: path.join(mobileRoot, 'index.ts') };
    },
  };
  config.resolver.resolveRequest(context, moduleName, 'android');
  if (!seen) throw new Error(`metro.config.js did not resolve ${moduleName}`);
  return seen;
}

/** The directory of package `name` as `req` finds it (its exports may not list package.json). */
function packageRoot(req: NodeJS.Require, name: string): string {
  let dir = path.dirname(req.resolve(name));
  while (dir !== path.dirname(dir)) {
    try {
      if ((JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string }).name === name) return dir;
    } catch {
      /* no package.json here */
    }
    dir = path.dirname(dir);
  }
  throw new Error(`no package root for ${name}`);
}

/** Where @trezor/schema-utils (the module that imports typebox in the app) lives, and what it imports from it. */
function schemaUtilsTypeboxImports(): { from: string; specifiers: string[] } {
  const schemaUtils = packageRoot(createRequire(requireHere.resolve('@trezor/connect-mobile')), '@trezor/schema-utils');
  const lib = path.join(schemaUtils, 'lib');
  const specifiers = new Set<string>();
  for (const file of readdirSync(lib).filter((f) => f.endsWith('.js'))) {
    for (const m of readFileSync(path.join(lib, file), 'utf8').matchAll(/from\s+["'](@sinclair\/typebox(?:\/[^"']*)?)["']/g)) {
      specifiers.add(m[1]!);
    }
  }
  return { from: path.join(lib, 'index.js'), specifiers: [...specifiers] };
}

describe('metro.config.js: @sinclair/typebox', () => {
  it('resolves @sinclair/typebox and its subpaths through the "require" (CommonJS) exports', () => {
    expect(contextSeenFor('@sinclair/typebox').isESMImport).toBe(false);
    expect(contextSeenFor('@sinclair/typebox/errors').isESMImport).toBe(false);
    expect(contextSeenFor('@sinclair/typebox/value').isESMImport).toBe(false);
  });

  it('leaves every other package as it was imported', () => {
    expect(contextSeenFor('@sinclair/typebox-codegen').isESMImport).toBe(true);
    expect(contextSeenFor('nostr-tools').isESMImport).toBe(true);
    expect(contextSeenFor('./network.js').isESMImport).toBe(true);
  });

  it('every typebox entry the Trezor link imports has a CommonJS build that loads as CommonJS', () => {
    const { from, specifiers } = schemaUtilsTypeboxImports();
    expect(specifiers).toContain('@sinclair/typebox');
    const req = createRequire(from); // Node's require() takes the "require" branch, as Metro now does
    for (const spec of specifiers) {
      const file = req.resolve(spec);
      expect(file, spec).toMatch(/[\\/]build[\\/]cjs[\\/]/);
      expect(() => req(spec), spec).not.toThrow();
    }
    expect(typeof (req('@sinclair/typebox') as { Object: unknown }).Object).toBe('function');
  });

  // Why the rule exists. If a newer typebox makes this pass, the rule in metro.config.js can go.
  it('the ES build of typebox object.mjs throws when Metro has made it CommonJS', () => {
    const { from } = schemaUtilsTypeboxImports();
    const esmEntry = path.join(packageRoot(createRequire(from), '@sinclair/typebox'), 'build/esm/type/object/object.mjs');
    const source = readFileSync(esmEntry, 'utf8');
    const out = transformSync(source, {
      filename: esmEntry,
      cwd: mobileRoot,
      babelrc: false,
      configFile: false,
      presets: [requireHere.resolve('babel-preset-expo')],
      caller: { name: 'metro', bundler: 'metro', platform: 'android', isDev: false },
    });
    expect(out?.code).toMatch(/var Object\b/);
    const run = new Function('exports', 'require', out!.code!) as (exports: object, require: (id: string) => unknown) => void;
    expect(() => run({}, () => ({}))).toThrow(/defineProperty/);
  });
});
