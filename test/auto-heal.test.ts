import { describe, it, expect } from 'vitest';
import { isLikelyAbiFailure } from '../src/auto-heal.js';

describe('auto-heal.isLikelyAbiFailure', () => {
  it('matches the canonical NODE_MODULE_VERSION error from better-sqlite3', () => {
    const msg =
      "The module '/Users/x/.npm/_npx/abc/node_modules/better-sqlite3/build/Release/better_sqlite3.node' " +
      'was compiled against a different Node.js version using NODE_MODULE_VERSION 141. ' +
      'This version of Node.js requires NODE_MODULE_VERSION 137.';
    expect(isLikelyAbiFailure(msg)).toBe(true);
  });

  it('matches Node ERR_DLOPEN_FAILED', () => {
    expect(isLikelyAbiFailure('Error [ERR_DLOPEN_FAILED]: dlopen failed')).toBe(true);
  });

  it('matches the prose-form "compiled against a different Node.js version"', () => {
    expect(
      isLikelyAbiFailure('was compiled against a different Node.js version using x'),
    ).toBe(true);
  });

  it('matches dlopen Symbol-not-found (sqlite-vec on macOS)', () => {
    expect(isLikelyAbiFailure('dlopen failed: Symbol not found: __ZN3sql4Func')).toBe(true);
  });

  it('matches dlopen image-not-found (missing platform pkg)', () => {
    expect(isLikelyAbiFailure('dlopen failed: image not found')).toBe(true);
  });

  it('matches incompatible-architecture (x64 binary on arm64 Mac)', () => {
    expect(isLikelyAbiFailure('mach-o, but built for incompatible architecture')).toBe(true);
  });

  it("matches sqlite-vec's missing-optional-dep symptom", () => {
    expect(isLikelyAbiFailure("Cannot find module 'sqlite-vec-darwin-arm64'")).toBe(true);
  });

  it('does not falsely match unrelated errors', () => {
    expect(isLikelyAbiFailure('Cannot find module "obsidian-brain"')).toBe(false);
    expect(isLikelyAbiFailure('SQLITE_CORRUPT: database disk image is malformed')).toBe(false);
    expect(isLikelyAbiFailure('TypeError: foo is not a function')).toBe(false);
    expect(isLikelyAbiFailure('')).toBe(false);
  });
});
