import type { NotebookVariables } from './variables.js';

type Expression =
  | { kind: 'number'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'unary'; operator: string; argument: Expression }
  | { kind: 'binary'; operator: string; left: Expression; right: Expression }
  | { kind: 'call'; name: string; argument: Expression };

export type ComputationLanguage = 'python' | 'octave' | 'cpp';

export interface LatexComputation {
  language: ComputationLanguage;
  code: string;
  target: string;
  symbols: string[];
}

const COMMANDS: Record<string, string> = {
  sin: 'sin', cos: 'cos', tan: 'tan', asin: 'asin', acos: 'acos', atan: 'atan',
  exp: 'exp', ln: 'ln', log: 'log', sqrt: 'sqrt', abs: 'abs',
};

class Parser {
  private index = 0;
  readonly symbols = new Set<string>();
  constructor(private readonly source: string, private readonly known: string[]) {}

  parse(): Expression {
    const expression = this.expression();
    this.space();
    if (this.index < this.source.length) throw new Error('Unsupported LaTeX near "' + this.source.slice(this.index, this.index + 18) + '".');
    return expression;
  }

  private space(): void {
    for (;;) {
      while (/\s/u.test(this.source[this.index] || '')) this.index += 1;
      const spacing = /^\\(?:left|right|quad|qquad)\b|^\\(?:,|;|:|!)/u.exec(this.source.slice(this.index));
      if (!spacing) return;
      this.index += spacing[0].length;
    }
  }

  private take(text: string): boolean {
    this.space();
    if (!this.source.startsWith(text, this.index)) return false;
    this.index += text.length;
    return true;
  }

  private expression(): Expression {
    let left = this.term();
    for (;;) {
      if (this.take('+')) left = { kind: 'binary', operator: '+', left, right: this.term() };
      else if (this.take('-')) left = { kind: 'binary', operator: '-', left, right: this.term() };
      else return left;
    }
  }

  private term(): Expression {
    let left = this.unary();
    for (;;) {
      if (this.take('\\cdot') || this.take('\\times') || this.take('*')) {
        left = { kind: 'binary', operator: '*', left, right: this.unary() };
      } else if (this.take('/') || this.take('\\div')) {
        left = { kind: 'binary', operator: '/', left, right: this.unary() };
      } else if (this.primaryStarts()) {
        left = { kind: 'binary', operator: '*', left, right: this.unary() };
      } else return left;
    }
  }

  private primaryStarts(): boolean {
    this.space();
    const rest = this.source.slice(this.index);
    return /^(?:\d|\.\d|\(|\{|[A-Za-z]|\\(?:frac|sqrt|sin|cos|tan|asin|acos|atan|exp|ln|log|abs|pi)\b)/u.test(rest);
  }

  private unary(): Expression {
    if (this.take('+')) return this.unary();
    if (this.take('-')) return { kind: 'unary', operator: '-', argument: this.unary() };
    return this.power();
  }

  private power(): Expression {
    const left = this.primary();
    if (!this.take('^')) return left;
    return { kind: 'binary', operator: '^', left, right: this.unary() };
  }

  private group(open = '{', close = '}'): Expression {
    if (!this.take(open)) throw new Error('Expected "' + open + '" in the LaTeX expression.');
    const result = this.expression();
    if (!this.take(close)) throw new Error('Expected "' + close + '" in the LaTeX expression.');
    return result;
  }

  private primary(): Expression {
    this.space();
    const rest = this.source.slice(this.index);
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)/u.exec(rest);
    if (number) {
      this.index += number[0].length;
      return { kind: 'number', value: number[0] };
    }
    if (this.source.startsWith('\\frac', this.index)) {
      this.index += 5;
      return { kind: 'binary', operator: '/', left: this.group(), right: this.group() };
    }
    if (this.source.startsWith('\\sqrt', this.index)) {
      this.index += 5;
      if (this.take('[')) {
        const root = this.expression();
        if (!this.take(']')) throw new Error('Expected "]" after the root degree.');
        return { kind: 'binary', operator: '^', left: this.primary(), right: { kind: 'binary', operator: '/', left: { kind: 'number', value: '1' }, right: root } };
      }
      return { kind: 'call', name: 'sqrt', argument: this.primary() };
    }
    if (rest.startsWith('\\pi')) {
      this.index += 3;
      return { kind: 'name', value: 'pi' };
    }
    const command = /^\\([A-Za-z]+)/u.exec(rest);
    if (command && COMMANDS[command[1]!] !== undefined) {
      this.index += command[0].length;
      const name = COMMANDS[command[1]!]!;
      const argument = this.source[this.index] === '{' ? this.group() : this.unary();
      return { kind: 'call', name, argument };
    }
    if (this.take('(')) {
      const result = this.expression();
      if (!this.take(')')) throw new Error('Expected ")" in the LaTeX expression.');
      return result;
    }
    if (this.source[this.index] === '{') return this.group();
    if (/[A-Za-z]/u.test(this.source[this.index] || '')) {
      let name = '';
      const known = this.known.find(candidate => this.source.startsWith(candidate, this.index));
      if (known) {
        name = known;
        this.index += known.length;
      } else {
        name = this.source[this.index]!;
        this.index += 1;
      }
      if (this.take('_')) {
        name += '_';
        if (this.take('{')) {
          const start = this.index;
          while (this.index < this.source.length && this.source[this.index] !== '}') this.index += 1;
          name += this.source.slice(start, this.index).replace(/[^A-Za-z0-9_]/g, '');
          if (!this.take('}')) throw new Error('Expected "}" after the subscript.');
        } else name += this.source[this.index++] || '';
      }
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new Error('Unsupported variable subscript.');
      this.symbols.add(name);
      return { kind: 'name', value: name };
    }
    throw new Error('Expected a number, variable, function or parenthesized expression.');
  }
}

function render(node: Expression, language: ComputationLanguage): string {
  if (node.kind === 'number') return node.value;
  if (node.kind === 'name') {
    if (node.value !== 'pi') return node.value;
    return language === 'python' ? 'math.pi' : language === 'octave' ? 'pi' : '3.14159265358979323846';
  }
  if (node.kind === 'unary') return '(-' + render(node.argument, language) + ')';
  if (node.kind === 'call') {
    const argument = render(node.argument, language);
    const functions: Record<string, [string, string, string]> = {
      sqrt: ['math.sqrt', 'sqrt', 'std::sqrt'], abs: ['abs', 'abs', 'std::abs'],
      sin: ['math.sin', 'sin', 'std::sin'], cos: ['math.cos', 'cos', 'std::cos'], tan: ['math.tan', 'tan', 'std::tan'],
      asin: ['math.asin', 'asin', 'std::asin'], acos: ['math.acos', 'acos', 'std::acos'], atan: ['math.atan', 'atan', 'std::atan'],
      exp: ['math.exp', 'exp', 'std::exp'], ln: ['math.log', 'log', 'std::log'], log: ['math.log10', 'log10', 'std::log10'],
    };
    const names = functions[node.name];
    if (!names) throw new Error('Unsupported function: ' + node.name);
    return names[language === 'python' ? 0 : language === 'octave' ? 1 : 2] + '(' + argument + ')';
  }
  const left = render(node.left, language);
  const right = render(node.right, language);
  if (node.operator === '^') {
    if (language === 'python') return '((' + left + ') ** (' + right + '))';
    if (language === 'octave') return '((' + left + ') ^ (' + right + '))';
    return 'std::pow(' + left + ', ' + right + ')';
  }
  return '(' + left + ' ' + node.operator + ' ' + right + ')';
}

export function latexToComputation(tex: string, language: ComputationLanguage, variables: NotebookVariables = {}): LatexComputation {
  const source = tex.trim().replace(/^\\(?:displaystyle|textstyle)\s*/u, '');
  const assignment = source.indexOf('=');
  let target = 'formula_result';
  let expressionSource = source;
  if (assignment >= 0) {
    const candidate = source.slice(0, assignment).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(candidate)) throw new Error('Calculation supports assignment to a simple variable, for example E = m c^2.');
    if (source.indexOf('=', assignment + 1) >= 0) throw new Error('Equations with multiple equals signs are not numeric assignments.');
    target = candidate;
    expressionSource = source.slice(assignment + 1);
  }
  if (!expressionSource.trim()) throw new Error('Enter a numeric expression to calculate.');
  const known = Object.keys(variables).sort((left, right) => right.length - left.length);
  const parser = new Parser(expressionSource, known);
  const expression = parser.parse();
  const symbols = [...parser.symbols].filter(symbol => symbol !== 'pi' && symbol !== target);
  const rendered = render(expression, language);
  if (language === 'python') {
    return { language, target, symbols, code: 'import math\n' + target + ' = ' + rendered + '\nhc_set(' + JSON.stringify(target) + ', ' + target + ')\nprint(' + target + ')' };
  }
  if (language === 'octave') {
    return { language, target, symbols, code: target + ' = ' + rendered + ';\nhc_set(' + JSON.stringify(target) + ', ' + target + ');\ndisp(' + target + ');' };
  }
  const declarations = symbols.map(symbol => 'const double ' + symbol + ' = hc_get(' + JSON.stringify(symbol) + ', 0.0);').join('\n');
  return { language, target, symbols, code: (declarations ? declarations + '\n' : '') + 'const double ' + target + ' = ' + rendered + ';\nhc_set(' + JSON.stringify(target) + ', ' + target + ');\nstd::cout << ' + target + ' << std::endl;' };
}
