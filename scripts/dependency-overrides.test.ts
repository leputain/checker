import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { deflateSync, inflateSync } from 'node:zlib';

const projectRequire = createRequire(import.meta.url);
const satoriRequire = createRequire(projectRequire.resolve('satori/package.json'));
// fflate 0.7.x exposes its declarations outside the package exports map, so a
// types-only import fails under bundler resolution. Keep this public API local.
type FflateOperations = {
  strToU8(value: string): Uint8Array;
  strFromU8(value: Uint8Array): string;
  zlibSync(value: Uint8Array, options: { level: 6 }): Uint8Array;
  unzlibSync(value: Uint8Array): Uint8Array;
  zipSync(files: Record<string, Uint8Array>, options: { level: 6 }): Uint8Array;
  unzipSync(value: Uint8Array): Record<string, Uint8Array>;
};
const fflate: FflateOperations = satoriRequire('fflate');
const coreEntry = projectRequire.resolve('@esbuild-kit/core-utils');
const coreRequire = createRequire(coreEntry);
const coreUtils: typeof import('@esbuild-kit/core-utils') = projectRequire('@esbuild-kit/core-utils');
const miniflareEntry = projectRequire.resolve('miniflare');
const miniflareRequire = createRequire(miniflareEntry);
const sharp: typeof import('sharp')['default'] = miniflareRequire('sharp');

async function resolvedVersion(entry: string, expectedName: string) {
  let directory = path.dirname(entry);
  while (true) {
    try {
      const metadata = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
      if (metadata.name === expectedName) return metadata.version;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Cannot locate resolved ${expectedName} package metadata.`);
    directory = parent;
  }
}

// Resolve through satori itself: testing a different hoisted fflate would not
// exercise the scoped override used by its image/font conversion dependency.
const unicodeText = 'Синтетическая оценка: 80 / 100; схема SQLite; 🧪; Ελληνικά.\n'.repeat(500);
const textBytes = fflate.strToU8(unicodeText);
const binaryBytes = Uint8Array.from({ length: 65_536 }, (_, index) => (index * 37) % 256);
const compressed = fflate.zlibSync(textBytes, { level: 6 });
assert.deepEqual(fflate.unzlibSync(compressed), textBytes, 'satori fflate must preserve UTF-8 bytes');
assert.deepEqual(new Uint8Array(inflateSync(compressed)), textBytes, 'Node must decode fflate zlib output');
assert.deepEqual(
  fflate.unzlibSync(new Uint8Array(deflateSync(textBytes))),
  textBytes,
  'satori fflate must decode independently produced Node zlib data',
);
assert.equal(fflate.strFromU8(fflate.unzlibSync(compressed)), unicodeText);

const files = {
  'отчёт/оценка 🧪.txt': textBytes,
  'данные/байты.bin': binaryBytes,
  'empty.txt': new Uint8Array(),
};
const archive = fflate.zipSync(files, { level: 6 });
const extracted = fflate.unzipSync(archive);
assert.deepEqual(Object.keys(extracted).sort(), Object.keys(files).sort(), 'ZIP must retain Unicode paths');
for (const [name, bytes] of Object.entries(files)) {
  assert.deepEqual(extracted[name], bytes, `ZIP content must survive roundtrip: ${name}`);
}

// Exercise the legacy loader's public transform API rather than the upgraded
// esbuild package directly. Importing defineConfig has no database side effects.
const configPath = fileURLToPath(new URL('./synthetic-drizzle.config.cts', import.meta.url));
const configSource = `
import { defineConfig, type Config } from 'drizzle-kit';
type SyntheticDialect = 'sqlite';
const dialect: SyntheticDialect = 'sqlite';
const options = {
  dialect,
  schema: './db/schema.ts',
  out: './drizzle',
  verbose: false,
  strict: true,
} satisfies Config;
export default defineConfig(options);
`;
const expectedConfig = {
  dialect: 'sqlite', schema: './db/schema.ts', out: './drizzle', verbose: false, strict: true,
};
const registerSourceMap = coreUtils.installSourceMapSupport();

function assertTransformedConfig(result: ReturnType<typeof coreUtils.transformSync>) {
  const sourceMap = JSON.parse(typeof result.map === 'string' ? result.map : JSON.stringify(result.map));
  assert.equal(sourceMap.version, 3);
  assert(sourceMap.sources.some((source: string) => source.replaceAll('\\', '/').endsWith('synthetic-drizzle.config.cts')));
  assert(sourceMap.sourcesContent.includes(configSource), 'source maps must retain the original TypeScript');
  assert.equal(typeof sourceMap.mappings, 'string');
  assert(sourceMap.mappings.length > 0, 'source maps must contain actual mappings');
  assert.equal(result.warnings?.length ?? 0, 0);

  const executableCode = registerSourceMap(result, configPath);
  const syntheticModule = { exports: {} as Record<string, unknown> };
  runInNewContext(executableCode, {
    module: syntheticModule,
    exports: syntheticModule.exports,
    require: projectRequire,
    __filename: configPath,
    __dirname: path.dirname(configPath),
  }, { filename: configPath, timeout: 1_000 });
  assert.deepEqual(
    JSON.parse(JSON.stringify(syntheticModule.exports.default)),
    expectedConfig,
    'the transformed Drizzle config must execute with the original values',
  );
  const inlineMap = /sourceMappingURL=data:application\/json;base64,([A-Za-z0-9+/=]+)/u.exec(executableCode);
  if (inlineMap) {
    assert.deepEqual(JSON.parse(Buffer.from(inlineMap[1], 'base64').toString('utf8')), sourceMap);
  }
}

assertTransformedConfig(coreUtils.transformSync(configSource, configPath, { format: 'cjs' }));
assertTransformedConfig(await coreUtils.transform(configSource, configPath, { format: 'cjs' }));
assert.equal(await resolvedVersion(satoriRequire.resolve('fflate'), 'fflate'), '0.7.5');
assert.equal(await resolvedVersion(coreRequire.resolve('esbuild'), 'esbuild'), '0.28.2');
assert.equal(await resolvedVersion(miniflareEntry, 'miniflare'), '5.20261006.1-alpha');
assert.equal(await resolvedVersion(miniflareRequire.resolve('undici'), 'undici'), '7.29.1');
assert.equal(await resolvedVersion(miniflareRequire.resolve('sharp'), 'sharp'), '0.35.5');

// Resolve through Miniflare, so this exercises its selected native dependency
// rather than a different sharp copy belonging to Next. No image or network I/O occurs.
const rgba = Buffer.from([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 64, 0, 0, 0, 0]);
const png = await sharp(rgba, { raw: { width: 2, height: 2, channels: 4 } }).png().toBuffer();
const pngMetadata = await sharp(png).metadata();
assert.equal(pngMetadata.format, 'png');
assert.equal(pngMetadata.width, 2);
assert.equal(pngMetadata.height, 2);
assert.equal(pngMetadata.channels, 4);
assert.deepEqual(await sharp(png).ensureAlpha().raw().toBuffer(), rgba,
  'Miniflare sharp must preserve exact RGBA samples across native PNG encode/decode');

console.log('dependency override tests: PASS');
