/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {ParseSourceSpan} from '../parse_util';

import * as o from './output_ast';
import {SourceMapGenerator} from './source_map';

const _SINGLE_QUOTE_ESCAPE_STRING_RE = /'|\\|\n|\r|\$/g;
const _LEGAL_IDENTIFIER_RE = /^[$A-Z_][0-9A-Z_$]*$/i;
const _INDENT_WITH = '  ';
export const CATCH_ERROR_VAR = o.variable('error');
export const CATCH_STACK_VAR = o.variable('stack');

export abstract class OutputEmitter {
  abstract emitStatements(moduleUrl: string, stmts: o.Statement[], exportedVars: string[]): string;
}

class _EmittedLine {
  parts: string[] = [];
  srcSpans: ParseSourceSpan[] = [];
  constructor(public indent: number) {}
}

export class EmitterVisitorContext {
  static createRoot(exportedVars: string[]): EmitterVisitorContext {
    return new EmitterVisitorContext(exportedVars, 0);
  }

  private _lines: _EmittedLine[];
  private _classes: o.ClassStmt[] = [];

  constructor(private _exportedVars: string[], private _indent: number) {
    this._lines = [new _EmittedLine(_indent)];
  }

  private get _currentLine(): _EmittedLine { return this._lines[this._lines.length - 1]; }

  isExportedVar(varName: string): boolean { return this._exportedVars.indexOf(varName) !== -1; }

  println(from?: {sourceSpan?: ParseSourceSpan}|null, lastPart: string = ''): void {
    this.print(from, lastPart, true);
  }

  lineIsEmpty(): boolean { return this._currentLine.parts.length === 0; }

  print(from: {sourceSpan?: ParseSourceSpan}|null, part: string, newLine: boolean = false) {
    if (part.length > 0) {
      this._currentLine.parts.push(part);
      this._currentLine.srcSpans.push(from && from.sourceSpan || null);
    }
    if (newLine) {
      this._lines.push(new _EmittedLine(this._indent));
    }
  }

  removeEmptyLastLine() {
    if (this.lineIsEmpty()) {
      this._lines.pop();
    }
  }

  incIndent() {
    this._indent++;
    this._currentLine.indent = this._indent;
  }

  decIndent() {
    this._indent--;
    this._currentLine.indent = this._indent;
  }

  pushClass(clazz: o.ClassStmt) { this._classes.push(clazz); }

  popClass(): o.ClassStmt { return this._classes.pop(); }

  get currentClass(): o.ClassStmt {
    return this._classes.length > 0 ? this._classes[this._classes.length - 1] : null;
  }

  toSource(): string {
    return this.sourceLines
        .map(l => l.parts.length > 0 ? _createIndent(l.indent) + l.parts.join('') : '')
        .join('\n');
  }

  toSourceMapGenerator(file: string|null = null, startsAtLine: number = 0): SourceMapGenerator {
    const map = new SourceMapGenerator(file);
    for (let i = 0; i < startsAtLine; i++) {
      map.addLine();
    }

    this.sourceLines.forEach(line => {
      map.addLine();

      const spans = line.srcSpans;
      const parts = line.parts;
      let col0 = line.indent * _INDENT_WITH.length;
      let spanIdx = 0;
      // skip leading parts without source spans
      while (spanIdx < spans.length && !spans[spanIdx]) {
        col0 += parts[spanIdx].length;
        spanIdx++;
      }

      while (spanIdx < spans.length) {
        const span = spans[spanIdx];
        const source = span.start.file;
        const sourceLine = span.start.line;
        const sourceCol = span.start.col;

        map.addSource(source.url, source.content)
            .addMapping(col0, source.url, sourceLine, sourceCol);

        col0 += parts[spanIdx].length;
        spanIdx++;

        // assign parts without span or the same span to the previous segment
        while (spanIdx < spans.length && (span === spans[spanIdx] || !spans[spanIdx])) {
          col0 += parts[spanIdx].length;
          spanIdx++;
        }
      }
    });

    return map;
  }

  private get sourceLines(): _EmittedLine[] {
    if (this._lines.length && this._lines[this._lines.length - 1].parts.length === 0) {
      return this._lines.slice(0, -1);
    }
    return this._lines;
  }
}

export abstract class AbstractEmitterVisitor implements o.StatementVisitor, o.ExpressionVisitor {
  constructor(private _escapeDollarInStrings: boolean) {}

  visitExpressionStmt(stmt: o.ExpressionStatement, ctx: EmitterVisitorContext): any {
    stmt.expr.visitExpression(this, ctx);
    ctx.println(stmt, ';');
    return null;
  }

  visitReturnStmt(stmt: o.ReturnStatement, ctx: EmitterVisitorContext): any {
    ctx.print(stmt, `return `);
    stmt.value.visitExpression(this, ctx);
    ctx.println(stmt, ';');
    return null;
  }

  abstract visitCastExpr(ast: o.CastExpr, context: any): any;

  abstract visitDeclareClassStmt(stmt: o.ClassStmt, ctx: EmitterVisitorContext): any;

  visitIfStmt(stmt: o.IfStmt, ctx: EmitterVisitorContext): any {
    ctx.print(stmt, `if (`);
    stmt.condition.visitExpression(this, ctx);
    ctx.print(stmt, `) {`);
    const hasElseCase = stmt.falseCase != null && stmt.falseCase.length > 0;
    if (stmt.trueCase.length <= 1 && !hasElseCase) {
      ctx.print(stmt, ` `);
      this.visitAllStatements(stmt.trueCase, ctx);
      ctx.removeEmptyLastLine();
      ctx.print(stmt, ` `);
    } else {
      ctx.println();
      ctx.incIndent();
      this.visitAllStatements(stmt.trueCase, ctx);
      ctx.decIndent();
      if (hasElseCase) {
        ctx.println(stmt, `} else {`);
        ctx.incIndent();
        this.visitAllStatements(stmt.falseCase, ctx);
        ctx.decIndent();
      }
    }
    ctx.println(stmt, `}`);
    return null;
  }

  abstract visitTryCatchStmt(stmt: o.TryCatchStmt, ctx: EmitterVisitorContext): any;

  visitThrowStmt(stmt: o.ThrowStmt, ctx: EmitterVisitorContext): any {
    ctx.print(stmt, `throw `);
    stmt.error.visitExpression(this, ctx);
    ctx.println(stmt, `;`);
    return null;
  }
  visitCommentStmt(stmt: o.CommentStmt, ctx: EmitterVisitorContext): any {
    const lines = stmt.comment.split('\n');
    lines.forEach((line) => { ctx.println(stmt, `// ${line}`); });
    return null;
  }
  abstract visitDeclareVarStmt(stmt: o.DeclareVarStmt, ctx: EmitterVisitorContext): any;

  visitWriteVarExpr(expr: o.WriteVarExpr, ctx: EmitterVisitorContext): any {
    const lineWasEmpty = ctx.lineIsEmpty();
    if (!lineWasEmpty) {
      ctx.print(expr, '(');
    }
    ctx.print(expr, `${expr.name} = `);
    expr.value.visitExpression(this, ctx);
    if (!lineWasEmpty) {
      ctx.print(expr, ')');
    }
    return null;
  }
  visitWriteKeyExpr(expr: o.WriteKeyExpr, ctx: EmitterVisitorContext): any {
    const lineWasEmpty = ctx.lineIsEmpty();
    if (!lineWasEmpty) {
      ctx.print(expr, '(');
    }
    expr.receiver.visitExpression(this, ctx);
    ctx.print(expr, `[`);
    expr.index.visitExpression(this, ctx);
    ctx.print(expr, `] = `);
    expr.value.visitExpression(this, ctx);
    if (!lineWasEmpty) {
      ctx.print(expr, ')');
    }
    return null;
  }
  visitWritePropExpr(expr: o.WritePropExpr, ctx: EmitterVisitorContext): any {
    const lineWasEmpty = ctx.lineIsEmpty();
    if (!lineWasEmpty) {
      ctx.print(expr, '(');
    }
    expr.receiver.visitExpression(this, ctx);
    ctx.print(expr, `.${expr.name} = `);
    expr.value.visitExpression(this, ctx);
    if (!lineWasEmpty) {
      ctx.print(expr, ')');
    }
    return null;
  }
  visitInvokeMethodExpr(expr: o.InvokeMethodExpr, ctx: EmitterVisitorContext): any {
    expr.receiver.visitExpression(this, ctx);
    let name = expr.name;
    if (expr.builtin != null) {
      name = this.getBuiltinMethodName(expr.builtin);
      if (name == null) {
        // some builtins just mean to skip the call.
        return null;
      }
    }
    ctx.print(expr, `.${name}(`);
    this.visitAllExpressions(expr.args, ctx, `,`);
    ctx.print(expr, `)`);
    return null;
  }

  abstract getBuiltinMethodName(method: o.BuiltinMethod): string;

  visitInvokeFunctionExpr(expr: o.InvokeFunctionExpr, ctx: EmitterVisitorContext): any {
    expr.fn.visitExpression(this, ctx);
    ctx.print(expr, `(`);
    this.visitAllExpressions(expr.args, ctx, ',');
    ctx.print(expr, `)`);
    return null;
  }
  visitReadVarExpr(ast: o.ReadVarExpr, ctx: EmitterVisitorContext): any {
    let varName = ast.name;
    if (ast.builtin != null) {
      switch (ast.builtin) {
        case o.BuiltinVar.Super:
          varName = 'super';
          break;
        case o.BuiltinVar.This:
          varName = 'this';
          break;
        case o.BuiltinVar.CatchError:
          varName = CATCH_ERROR_VAR.name;
          break;
        case o.BuiltinVar.CatchStack:
          varName = CATCH_STACK_VAR.name;
          break;
        default:
          throw new Error(`Unknown builtin variable ${ast.builtin}`);
      }
    }
    ctx.print(ast, varName);
    return null;
  }
  visitInstantiateExpr(ast: o.InstantiateExpr, ctx: EmitterVisitorContext): any {
    ctx.print(ast, `new `);
    ast.classExpr.visitExpression(this, ctx);
    ctx.print(ast, `(`);
    this.visitAllExpressions(ast.args, ctx, ',');
    ctx.print(ast, `)`);
    return null;
  }

  visitLiteralExpr(ast: o.LiteralExpr, ctx: EmitterVisitorContext): any {
    const value = ast.value;
    if (typeof value === 'string') {
      ctx.print(ast, escapeIdentifier(value, this._escapeDollarInStrings));
    } else {
      ctx.print(ast, `${value}`);
    }
    return null;
  }

  abstract visitExternalExpr(ast: o.ExternalExpr, ctx: EmitterVisitorContext): any;

  visitConditionalExpr(ast: o.ConditionalExpr, ctx: EmitterVisitorContext): any {
    ctx.print(ast, `(`);
    ast.condition.visitExpression(this, ctx);
    ctx.print(ast, '? ');
    ast.trueCase.visitExpression(this, ctx);
    ctx.print(ast, ': ');
    ast.falseCase.visitExpression(this, ctx);
    ctx.print(ast, `)`);
    return null;
  }
  visitNotExpr(ast: o.NotExpr, ctx: EmitterVisitorContext): any {
    ctx.print(ast, '!');
    ast.condition.visitExpression(this, ctx);
    return null;
  }
  abstract visitFunctionExpr(ast: o.FunctionExpr, ctx: EmitterVisitorContext): any;
  abstract visitDeclareFunctionStmt(stmt: o.DeclareFunctionStmt, context: any): any;

  visitBinaryOperatorExpr(ast: o.BinaryOperatorExpr, ctx: EmitterVisitorContext): any {
    let opStr: string;
    switch (ast.operator) {
      case o.BinaryOperator.Equals:
        opStr = '==';
        break;
      case o.BinaryOperator.Identical:
        opStr = '===';
        break;
      case o.BinaryOperator.NotEquals:
        opStr = '!=';
        break;
      case o.BinaryOperator.NotIdentical:
        opStr = '!==';
        break;
      case o.BinaryOperator.And:
        opStr = '&&';
        break;
      case o.BinaryOperator.Or:
        opStr = '||';
        break;
      case o.BinaryOperator.Plus:
        opStr = '+';
        break;
      case o.BinaryOperator.Minus:
        opStr = '-';
        break;
      case o.BinaryOperator.Divide:
        opStr = '/';
        break;
      case o.BinaryOperator.Multiply:
        opStr = '*';
        break;
      case o.BinaryOperator.Modulo:
        opStr = '%';
        break;
      case o.BinaryOperator.Lower:
        opStr = '<';
        break;
      case o.BinaryOperator.LowerEquals:
        opStr = '<=';
        break;
      case o.BinaryOperator.Bigger:
        opStr = '>';
        break;
      case o.BinaryOperator.BiggerEquals:
        opStr = '>=';
        break;
      default:
        throw new Error(`Unknown operator ${ast.operator}`);
    }
    ctx.print(ast, `(`);
    ast.lhs.visitExpression(this, ctx);
    ctx.print(ast, ` ${opStr} `);
    ast.rhs.visitExpression(this, ctx);
    ctx.print(ast, `)`);
    return null;
  }

  visitReadPropExpr(ast: o.ReadPropExpr, ctx: EmitterVisitorContext): any {
    ast.receiver.visitExpression(this, ctx);
    ctx.print(ast, `.`);
    ctx.print(ast, ast.name);
    return null;
  }
  visitReadKeyExpr(ast: o.ReadKeyExpr, ctx: EmitterVisitorContext): any {
    ast.receiver.visitExpression(this, ctx);
    ctx.print(ast, `[`);
    ast.index.visitExpression(this, ctx);
    ctx.print(ast, `]`);
    return null;
  }
  visitLiteralArrayExpr(ast: o.LiteralArrayExpr, ctx: EmitterVisitorContext): any {
    const useNewLine = ast.entries.length > 1;
    ctx.print(ast, `[`, useNewLine);
    ctx.incIndent();
    this.visitAllExpressions(ast.entries, ctx, ',', useNewLine);
    ctx.decIndent();
    ctx.print(ast, `]`, useNewLine);
    return null;
  }
  visitLiteralMapExpr(ast: o.LiteralMapExpr, ctx: EmitterVisitorContext): any {
    const useNewLine = ast.entries.length > 1;
    ctx.print(ast, `{`, useNewLine);
    ctx.incIndent();
    this.visitAllObjects(entry => {
      ctx.print(ast, `${escapeIdentifier(entry.key, this._escapeDollarInStrings, entry.quoted)}: `);
      entry.value.visitExpression(this, ctx);
    }, ast.entries, ctx, ',', useNewLine);
    ctx.decIndent();
    ctx.print(ast, `}`, useNewLine);
    return null;
  }

  visitAllExpressions(
      expressions: o.Expression[], ctx: EmitterVisitorContext, separator: string,
      newLine: boolean = false): void {
    this.visitAllObjects(
        expr => expr.visitExpression(this, ctx), expressions, ctx, separator, newLine);
  }

  visitAllObjects<T>(
      handler: (t: T) => void, expressions: T[], ctx: EmitterVisitorContext, separator: string,
      newLine: boolean = false): void {
    for (let i = 0; i < expressions.length; i++) {
      if (i > 0) {
        ctx.print(null, separator, newLine);
      }
      handler(expressions[i]);
    }
    if (newLine) {
      ctx.println();
    }
  }

  visitAllStatements(statements: o.Statement[], ctx: EmitterVisitorContext): void {
    statements.forEach((stmt) => stmt.visitStatement(this, ctx));
  }
}

export function escapeIdentifier(
    input: string, escapeDollar: boolean, alwaysQuote: boolean = true): any {
  if (input == null) {
    return null;
  }
  const body = input.replace(_SINGLE_QUOTE_ESCAPE_STRING_RE, (...match: string[]) => {
    if (match[0] == '$') {
      return escapeDollar ? '\\$' : '$';
    } else if (match[0] == '\n') {
      return '\\n';
    } else if (match[0] == '\r') {
      return '\\r';
    } else {
      return `\\${match[0]}`;
    }
  });
  const requiresQuotes = alwaysQuote || !_LEGAL_IDENTIFIER_RE.test(body);
  return requiresQuotes ? `'${body}'` : body;
}

function _createIndent(count: number): string {
  let res = '';
  for (let i = 0; i < count; i++) {
    res += _INDENT_WITH;
  }
  return res;
}
