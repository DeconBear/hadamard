import puppeteer from 'puppeteer-core';

export interface HtmlLayoutText {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fontSize: number;
  fontFamily: string;
  fontWeight: number;
  italic: boolean;
  color: string;
  align: 'left' | 'center' | 'right' | 'justify';
  bullet: boolean;
}

export interface HtmlLayoutShape {
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string;
  stroke: string;
  strokeWidth: number;
  radius: number;
  ellipse: boolean;
}

export interface HtmlLayout {
  width: number;
  height: number;
  texts: HtmlLayoutText[];
  shapes: HtmlLayoutShape[];
}

const TEXT_SELECTORS = 'h1,h2,h3,h4,h5,h6,p,li,blockquote,figcaption,td,th,button,a,span,b,strong,small,em,label,time';

export async function extractHtmlLayout(html: string, width: number, height: number, browserPath: string): Promise<HtmlLayout> {
  const browser = await puppeteer.launch({
    executablePath: browserPath,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--font-render-hinting=none'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    // Keep the extracted DOM helpers compatible with esbuild/tsx "keep names"
    // wrappers: Puppeteer serializes the evaluate function into the page.
    await page.evaluateOnNewDocument(() => undefined);
    await page.evaluate('window.__name = (target) => target;');
    await page.setContent(html, { waitUntil: 'load', timeout: 20000 });
    await page.evaluate(async () => {
      try { await (document as Document & { fonts: { ready: Promise<unknown> } }).fonts.ready; } catch { /* ignore */ }
    });
    await new Promise(resolve => setTimeout(resolve, 150));
    return await page.evaluate((selectors: string, pageWidth: number, pageHeight: number): HtmlLayout => {
      const toHex = (value: string): string | null => {
        const match = value.match(/rgba?\(([^)]+)\)/);
        if (!match) return null;
        const parts = match[1]!.split(',').map(part => Number(part.trim()));
        if (parts.length < 3) return null;
        const alpha = parts.length > 3 ? parts[3]! : 1;
        if (alpha <= 0.01) return null;
        return '#' + parts.slice(0, 3).map(part => Math.max(0, Math.min(255, Math.round(part))).toString(16).padStart(2, '0')).join('');
      };
      const fontFamily = (value: string): string => value.split(',')[0]!.replace(/["']/g, '').trim() || 'Arial';
      const isVisible = (element: Element, style: CSSStyleDeclaration, rect: DOMRect): boolean => {
        if (rect.width < 2 || rect.height < 2) return false;
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        if (rect.bottom < 0 || rect.right < 0 || rect.top > pageHeight || rect.left > pageWidth) return false;
        return true;
      };
      const texts: HtmlLayoutText[] = [];
      for (const element of Array.from(document.querySelectorAll(selectors))) {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (!isVisible(element, style, rect)) continue;
        const text = (element as HTMLElement).innerText.replace(/\u00a0/g, ' ').trim();
        if (!text || text.length > 3000) continue;
        const parentText = element.parentElement?.closest(selectors);
        if (parentText && parentText !== element) continue;
        const color = toHex(style.color) || '#1f2430';
        const alignValue = style.textAlign;
        const align: HtmlLayoutText['align'] = alignValue === 'center' || alignValue === 'right' || alignValue === 'justify' ? alignValue : 'left';
        texts.push({
          text,
          x: rect.left,
          y: rect.top,
          w: rect.width,
          h: rect.height,
          fontSize: Number.parseFloat(style.fontSize) || 16,
          fontFamily: fontFamily(style.fontFamily),
          fontWeight: Number.parseInt(style.fontWeight, 10) || 400,
          italic: style.fontStyle === 'italic' || style.fontStyle.startsWith('oblique'),
          color,
          align,
          bullet: element.tagName.toLowerCase() === 'li',
        });
      }
      const shapes: HtmlLayoutShape[] = [];
      for (const element of Array.from(document.querySelectorAll('div,section,header,footer,article,aside,main,figure,blockquote'))) {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (!isVisible(element, style, rect)) continue;
        const fill = toHex(style.backgroundColor);
        if (!fill) continue;
        const area = rect.width * rect.height;
        if (area < 900 || area > pageWidth * pageHeight * 0.92) continue;
        const borderWidth = Number.parseFloat(style.borderTopWidth) || 0;
        const stroke = borderWidth > 0 && style.borderTopStyle !== 'none' ? toHex(style.borderTopColor) : null;
        const radius = Number.parseFloat(style.borderTopLeftRadius) || 0;
        shapes.push({
          x: rect.left, y: rect.top, w: rect.width, h: rect.height,
          fill, stroke: stroke || fill, strokeWidth: borderWidth,
          radius, ellipse: radius >= Math.min(rect.width, rect.height) / 2 - 2,
        });
      }
      shapes.sort((left, right) => right.w * right.h - left.w * left.h);
      return { width: pageWidth, height: pageHeight, texts, shapes };
    }, TEXT_SELECTORS, width, height);
  } finally {
    await browser.close().catch(() => undefined);
  }
}
