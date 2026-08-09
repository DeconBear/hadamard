/**
 * Scrollback-friendly renderer for the Hadamard TUI:
 *
 * - Transcript lines are printed permanently into normal scrollback.
 * - A bottom dynamic region is redrawn in place.
 * - The hidden real cursor is parked at the input caret. Terminals and IMEs
 *   use that position even while the TUI draws its own inverse-video caret.
 */
import { wrapToWidth } from './ansi.js';

const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR_DOWN = '\x1b[0J';
const CLEAR_LINE_RIGHT = '\x1b[0K';
const SAVE_CURSOR = '\x1b[s';
const RESTORE_CURSOR = '\x1b[u';

export interface ScreenOutput {
  write(text: string): void;
  columns?: number;
  rows?: number;
  on?(event: 'resize', listener: () => void): unknown;
  off?(event: 'resize', listener: () => void): unknown;
}

export interface DynamicCursorPosition {
  /** Zero-based source line passed to setDynamic. */
  line: number;
  /** Zero-based visible terminal column. */
  column: number;
}

export class TuiScreen {
  private dynamicLines: string[] = [];
  private dynamicVisualCount = 0;
  private parkedRow = 0;
  private parkedColumn = 0;
  private started = false;
  private readonly resizeListener = () => this.redraw();

  constructor(private readonly out: ScreenOutput) {}

  get width(): number {
    return Math.max(this.out.columns ?? 80, 10);
  }

  get height(): number {
    return Math.max(this.out.rows ?? 24, 6);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.out.write(HIDE_CURSOR);
    this.out.on?.('resize', this.resizeListener);
  }

  /** Erase the dynamic region, restore the cursor, and detach listeners. */
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.out.off?.('resize', this.resizeListener);
    this.out.write(this.moveToTop() + CLEAR_DOWN + SHOW_CURSOR);
    this.dynamicLines = [];
    this.dynamicVisualCount = 0;
    this.parkedRow = 0;
    this.parkedColumn = 0;
  }

  /** Print lines permanently into scrollback above the dynamic region. */
  appendStatic(lines: readonly string[]): void {
    if (lines.length === 0) return;
    const wrapped: string[] = [];
    for (const line of lines) wrapped.push(...wrapToWidth(line, this.width));
    this.out.write(
      this.moveToTop()
        + CLEAR_DOWN
        + wrapped.join('\n')
        + '\n'
        + this.buildDynamicPaint(),
    );
  }

  /** Replace the dynamic bottom region. Lines are pre-wrapped to width. */
  setDynamic(lines: readonly string[], cursor?: DynamicCursorPosition): void {
    const wrapped: string[] = [];
    let cursorRow = 0;
    let cursorColumn = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const start = wrapped.length;
      const parts = wrapToWidth(lines[index]!, this.width);
      wrapped.push(...parts);
      if (cursor && cursor.line === index) {
        cursorRow = start + Math.floor(Math.max(cursor.column, 0) / this.width);
        cursorColumn = Math.max(cursor.column, 0) % this.width;
      }
    }

    const maxRows = this.height - 1;
    const startRow = cursor && wrapped.length > maxRows
      ? Math.min(Math.max(cursorRow - maxRows + 1, 0), wrapped.length - maxRows)
      : 0;
    const nextLines = wrapped.slice(startRow, startRow + maxRows);
    const nextParkedRow = cursor
      ? Math.max(0, Math.min(cursorRow - startRow, Math.max(nextLines.length - 1, 0)))
      : 0;
    const nextParkedColumn = cursor ? Math.min(cursorColumn, this.width - 1) : 0;
    if (
      sameLines(this.dynamicLines, nextLines)
      && this.parkedRow === nextParkedRow
      && this.parkedColumn === nextParkedColumn
    ) return;

    const previousLines = this.dynamicLines;
    const previousParkedRow = this.parkedRow;
    this.dynamicLines = nextLines;
    this.parkedRow = nextParkedRow;
    this.parkedColumn = nextParkedColumn;
    if (previousLines.length === nextLines.length && nextLines.length > 0) {
      this.redrawChangedLines(previousLines, previousParkedRow);
    } else {
      this.redraw(previousParkedRow);
    }
  }

  private redraw(previousParkedRow = this.parkedRow): void {
    this.out.write(this.moveToTop(previousParkedRow) + CLEAR_DOWN + this.buildDynamicPaint());
  }

  private redrawChangedLines(previousLines: readonly string[], previousParkedRow: number): void {
    let output = this.moveToTop(previousParkedRow) + SAVE_CURSOR;
    for (let index = 0; index < this.dynamicLines.length; index += 1) {
      if (previousLines[index] === this.dynamicLines[index]) continue;
      output += RESTORE_CURSOR;
      if (index > 0) output += `\x1b[${index}B`;
      output += `\r${this.dynamicLines[index]}${CLEAR_LINE_RIGHT}`;
    }
    output += RESTORE_CURSOR + this.moveFromTopToParkedCursor();
    this.out.write(output);
  }

  private buildDynamicPaint(): string {
    if (this.dynamicLines.length === 0) {
      this.dynamicVisualCount = 0;
      return '';
    }
    this.dynamicVisualCount = this.dynamicLines.length;
    let output = this.dynamicLines.join('\n') + '\r';
    const rowsUp = this.dynamicVisualCount - 1 - this.parkedRow;
    if (rowsUp > 0) output += `\x1b[${rowsUp}A`;
    if (this.parkedColumn > 0) output += `\x1b[${this.parkedColumn}C`;
    return output;
  }

  private moveToTop(row = this.parkedRow): string {
    return `\r${row > 0 ? `\x1b[${row}A` : ''}`;
  }

  private moveFromTopToParkedCursor(): string {
    let output = '\r';
    if (this.parkedRow > 0) output += `\x1b[${this.parkedRow}B`;
    if (this.parkedColumn > 0) output += `\x1b[${this.parkedColumn}C`;
    return output;
  }
}

function sameLines(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((line, index) => line === right[index]);
}
