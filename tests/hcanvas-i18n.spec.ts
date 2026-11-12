import { describe, expect, it } from 'vitest';
import { getLanguage, setLanguage, t, translatePhrase } from '../src/hcanvas/client/i18n.js';

describe('hcanvas i18n', () => {
  it('translates static labels and dynamic counts', () => {
    setLanguage('zh');
    expect(translatePhrase('Canvases')).toBe('画布');
    expect(translatePhrase('Saved · rev 12')).toBe('已保存 · rev 12');
    expect(translatePhrase('3 pages · rev 2')).toBe('3 页 · rev 2');
    expect(translatePhrase('Block · text')).toBe('块 · 文本');
    expect(t('Plugins:')).toBe('插件：');
    expect(translatePhrase('Read-only')).toBe('只读');
  });

  it('switches back to English without keeping Chinese strings', () => {
    setLanguage('zh');
    expect(translatePhrase('Files')).toBe('文件');
    setLanguage('en');
    expect(getLanguage()).toBe('en');
    expect(translatePhrase('Files')).toBe('Files');
  });
});
