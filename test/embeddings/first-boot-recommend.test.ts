import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { autoRecommendPreset } from '../../src/embeddings/auto-recommend.js';

// Capture stderr writes without printing.
let stderrOutput = '';
beforeEach(() => {
  stderrOutput = '';
  vi.spyOn(process.stderr, 'write').mockImplementation((msg: string | Uint8Array) => {
    stderrOutput += typeof msg === 'string' ? msg : '';
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Create a temp vault with the given files: { relPath: content } */
function makeTempVault(files: Record<string, string>): string {
  const vaultPath = mkdtempSync(join(tmpdir(), 'obsidian-brain-autorecommend-'));
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = join(vaultPath, relPath);
    const dir = absPath.substring(0, absPath.lastIndexOf('/'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(absPath, content, 'utf-8');
  }
  return vaultPath;
}

function cleanVault(vaultPath: string) {
  rmSync(vaultPath, { recursive: true, force: true });
}

describe('autoRecommendPreset — vault language detection', () => {
  it('English-only vault → recommends english', async () => {
    const vaultPath = makeTempVault({
      'note1.md': 'This is a note about programming and software development.',
      'note2.md': 'Another note about machine learning and artificial intelligence.',
      'note3.md': 'Personal journal about daily activities and reflections.',
    });
    try {
      const result = await autoRecommendPreset({}, vaultPath, undefined);
      expect(result.skipped).toBe(false);
      expect(result.preset).toBe('english');
    } finally {
      cleanVault(vaultPath);
    }
  });

  it('English-only vault → logs auto-recommend message to stderr', async () => {
    const vaultPath = makeTempVault({
      'note.md': 'Just some plain English text here.',
    });
    try {
      await autoRecommendPreset({}, vaultPath, undefined);
      expect(stderrOutput).toContain('auto-recommended preset "english"');
      expect(stderrOutput).toContain('set EMBEDDING_PRESET explicitly to override');
    } finally {
      cleanVault(vaultPath);
    }
  });

  it('Mixed English + Arabic vault → recommends multilingual', async () => {
    const vaultPath = makeTempVault({
      'english.md': 'This is an English note about daily life.',
      // Arabic text: "Hello, how are you today?" with substantial Arabic content
      'arabic.md': 'مرحبا، كيف حالك اليوم؟ أنا بخير شكراً لك. هذا النص يحتوي على كثير من الكلمات العربية لأغراض الاختبار.',
    });
    try {
      const result = await autoRecommendPreset({}, vaultPath, undefined);
      expect(result.skipped).toBe(false);
      expect(result.preset).toBe('multilingual');
    } finally {
      cleanVault(vaultPath);
    }
  });

  it('Mixed English + Arabic vault → logs multilingual recommendation to stderr', async () => {
    const vaultPath = makeTempVault({
      'english.md': 'Some English text.',
      'arabic.md': 'هذا نص عربي طويل يحتوي على كلمات كثيرة جداً لضمان تجاوز عتبة خمسة بالمئة.',
    });
    try {
      await autoRecommendPreset({}, vaultPath, undefined);
      expect(stderrOutput).toContain('auto-recommended preset "multilingual"');
    } finally {
      cleanVault(vaultPath);
    }
  });

  it('Pure CJK vault → recommends multilingual', async () => {
    const vaultPath = makeTempVault({
      // Traditional Chinese text
      'cjk.md': '这是一篇关于编程和软件开发的笔记。机器学习是人工智能的一个重要分支。自然语言处理让计算机能够理解人类语言。',
      'cjk2.md': '日本語のノートです。プログラミングと機械学習について書いています。自然言語処理は重要な技術です。',
    });
    try {
      const result = await autoRecommendPreset({}, vaultPath, undefined);
      expect(result.skipped).toBe(false);
      expect(result.preset).toBe('multilingual');
    } finally {
      cleanVault(vaultPath);
    }
  });

  it('Empty vault → defaults to english, no crash', async () => {
    const vaultPath = makeTempVault({});
    try {
      const result = await autoRecommendPreset({}, vaultPath, undefined);
      expect(result.skipped).toBe(false);
      expect(result.preset).toBe('english');
    } finally {
      cleanVault(vaultPath);
    }
  });

  it('Empty vault → still logs recommendation to stderr', async () => {
    const vaultPath = makeTempVault({});
    try {
      await autoRecommendPreset({}, vaultPath, undefined);
      expect(stderrOutput).toContain('auto-recommended preset');
    } finally {
      cleanVault(vaultPath);
    }
  });
});

describe('autoRecommendPreset — skip conditions', () => {
  it('skips when EMBEDDING_PRESET is set', async () => {
    const vaultPath = makeTempVault({ 'note.md': 'English text.' });
    try {
      const result = await autoRecommendPreset(
        { EMBEDDING_PRESET: 'multilingual' },
        vaultPath,
        undefined,
      );
      expect(result.skipped).toBe(true);
      // No stderr output when skipped
      expect(stderrOutput).not.toContain('auto-recommended');
    } finally {
      cleanVault(vaultPath);
    }
  });

  it('skips when EMBEDDING_MODEL is set', async () => {
    const vaultPath = makeTempVault({ 'note.md': 'English text.' });
    try {
      const result = await autoRecommendPreset(
        { EMBEDDING_MODEL: 'custom/model' },
        vaultPath,
        undefined,
      );
      expect(result.skipped).toBe(true);
      expect(stderrOutput).not.toContain('auto-recommended');
    } finally {
      cleanVault(vaultPath);
    }
  });

  it('skips when EMBEDDING_MODEL is set even alongside EMBEDDING_PRESET', async () => {
    const vaultPath = makeTempVault({ 'note.md': 'English text.' });
    try {
      const result = await autoRecommendPreset(
        { EMBEDDING_MODEL: 'custom/model', EMBEDDING_PRESET: 'english' },
        vaultPath,
        undefined,
      );
      expect(result.skipped).toBe(true);
    } finally {
      cleanVault(vaultPath);
    }
  });

  it('skips when storedEmbeddingModel is set (DB has prior embedding_model)', async () => {
    const vaultPath = makeTempVault({ 'note.md': 'English text.' });
    try {
      const result = await autoRecommendPreset(
        {},
        vaultPath,
        'Xenova/bge-small-en-v1.5', // DB already knows the model
      );
      expect(result.skipped).toBe(true);
      expect(stderrOutput).not.toContain('auto-recommended');
    } finally {
      cleanVault(vaultPath);
    }
  });

  it('does NOT skip when both env vars are empty strings (treated as unset)', async () => {
    const vaultPath = makeTempVault({ 'note.md': 'English text.' });
    try {
      const result = await autoRecommendPreset(
        { EMBEDDING_MODEL: '', EMBEDDING_PRESET: '' },
        vaultPath,
        undefined,
      );
      expect(result.skipped).toBe(false);
    } finally {
      cleanVault(vaultPath);
    }
  });
});

describe('autoRecommendPreset — Cyrillic detection', () => {
  it('Cyrillic-heavy vault → recommends multilingual', async () => {
    const vaultPath = makeTempVault({
      // Russian text
      'russian.md': 'Это заметка о программировании и разработке программного обеспечения. Машинное обучение является важной частью искусственного интеллекта.',
    });
    try {
      const result = await autoRecommendPreset({}, vaultPath, undefined);
      expect(result.preset).toBe('multilingual');
    } finally {
      cleanVault(vaultPath);
    }
  });
});
