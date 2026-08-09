import { A, wrapToWidth } from './ansi.js';

/** Owns one reasoning segment independently from transport event boundaries. */
export class ReasoningDisplayState {
  private activeText = '';
  private streamed = false;

  get hasActive(): boolean {
    return this.activeText.trim().length > 0;
  }

  get hasStreamedContent(): boolean {
    return this.streamed;
  }

  append(delta: string): void {
    if (!delta) return;
    this.activeText += delta;
    this.streamed = true;
  }

  setCompleteContent(text: string): void {
    if (!this.hasActive && text.trim()) this.activeText = text;
  }

  liveLines(width: number, maxRows = 6): string[] {
    const condensed = this.activeText.replace(/\s+/g, ' ').trim();
    if (!condensed) return [];
    const contentWidth = Math.max(width - 4, 16);
    const lines = wrapToWidth(condensed, contentWidth).map((line, index) => (
      `${A.dim}${index === 0 ? '∴ ' : '  '}${line}${A.reset}`
    ));
    return lines.slice(Math.max(lines.length - maxRows, 0));
  }

  complete(): string[] {
    const condensed = this.activeText.replace(/\s+/g, ' ').trim();
    if (!condensed) return [];
    const words = condensed.split(/\s+/u).length;
    const detail = words > 1 ? `${words} words` : `${[...condensed].length} chars`;
    this.activeText = '';
    this.streamed = false;
    return [`${A.dim}∴ Thinking · ${detail} · collapsed${A.reset}`];
  }

  reset(): void {
    this.activeText = '';
    this.streamed = false;
  }
}
