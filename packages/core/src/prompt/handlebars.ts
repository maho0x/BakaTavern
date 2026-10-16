/**
 * Renders Handlebars templates (SillyTavern's story strings) without compiling them to
 * JavaScript. SillyTavern uses `Handlebars.compile(storyString, { noEscape: true })`, which
 * generates code and runs it with `new Function`; that would rule out a strict Content Security
 * Policy. This walks the AST from Handlebars' own parser instead (so whitespace control and
 * standalone lines are identical) and follows the semantics of the generated code: helper,
 * ambiguous and simple expressions, `blockHelperMissing`, `helperMissing`, the built-in helpers,
 * `@data` variables, block parameters and `../` paths. Partials and decorators are not supported.
 */

import type HandlebarsType from 'handlebars';

type Handlebars = typeof HandlebarsType;
type Node = hbs.AST.Node;
type Program = hbs.AST.Program;
type PathExpression = hbs.AST.PathExpression;
type Expression = hbs.AST.Expression;
type Hash = hbs.AST.Hash;

/** A data frame (`@index`, `@root`, ...); `_parent` links to the enclosing one. */
type DataFrame = Record<string, unknown> & { _parent?: DataFrame };

export interface HelperOptions {
  name: string;
  hash: Record<string, unknown>;
  data: DataFrame;
  fn?: (context: unknown, options?: { data?: DataFrame; blockParams?: unknown[] }) => string;
  inverse?: (context: unknown, options?: { data?: DataFrame; blockParams?: unknown[] }) => string;
  lookupProperty: (parent: unknown, name: string) => unknown;
}

export type Helper = (this: unknown, ...args: unknown[]) => unknown;

/** Helpers known at compile time: always called as helpers, never looked up on the context. */
const KNOWN_HELPERS = new Set([
  'helperMissing',
  'blockHelperMissing',
  'each',
  'if',
  'unless',
  'with',
  'log',
  'lookup',
]);

interface Frame {
  context: unknown;
  /** `depths[0]` is the current context, `depths[n]` the one `n` levels up (`../`). */
  depths: unknown[];
  data: DataFrame;
  /** Block parameters in scope, innermost first. */
  blockParams: { names: string[]; values: unknown[] }[];
}

/** Own properties only, like Handlebars' prototype access control. */
function lookupProperty(parent: unknown, name: string): unknown {
  if (parent === null || parent === undefined) return parent;
  const result = (parent as Record<string, unknown>)[name];
  if (result === null || result === undefined) return result;
  return Object.prototype.hasOwnProperty.call(parent, name) ? result : undefined;
}

function isEmpty(value: unknown): boolean {
  if (!value && value !== 0) return true;
  return Array.isArray(value) && value.length === 0;
}

function createFrame(object: DataFrame): DataFrame {
  return { ...object, _parent: object };
}

const scopedId = (path: PathExpression) => /^\.|this\b/.test(path.original);
const simpleId = (path: PathExpression) => path.parts.length === 1 && !scopedId(path) && !path.depth;

/** `{{"foo"}}` and `{{true}}` are treated as paths named by the literal. */
function asPath(path: PathExpression | hbs.AST.Literal): PathExpression {
  if ((path as PathExpression).parts) return path as PathExpression;
  const original = String((path as { original?: unknown }).original);
  return { type: 'PathExpression', data: false, depth: 0, parts: [original], original, loc: path.loc };
}

class TemplateError extends Error {}

/** Handlebars' built-in helpers; `helper` finds the others (for `each` in `blockHelperMissing`). */
function builtinHelpers(helper: (name: string) => Helper | undefined): Record<string, Helper> {
  return {
    blockHelperMissing(this: unknown, ...args: unknown[]) {
      const [context, options] = args as [unknown, HelperOptions];
      if (context === true) return options.fn!(this);
      if (context === false || context === null || context === undefined) return options.inverse!(this);
      if (Array.isArray(context)) {
        return context.length > 0 ? helper('each')!.call(this, context, options) : options.inverse!(this);
      }
      return options.fn!(context, options);
    },
    each(this: unknown, ...args: unknown[]) {
      const options = args.at(-1) as HelperOptions | undefined;
      if (args.length < 2 || !options) throw new TemplateError('Must pass iterator to #each');
      let context = args[0];
      if (typeof context === 'function') context = (context as Helper).call(this);
      const data = createFrame(options.data);
      let ret = '';
      let i = 0;
      const run = (field: string | number, index: number, last: boolean) => {
        Object.assign(data, { key: field, index, first: index === 0, last });
        const value = (context as Record<string | number, unknown>)[field];
        ret += options.fn!(value, { data, blockParams: [value, field] });
      };
      if (context && typeof context === 'object') {
        if (Array.isArray(context)) {
          for (const j = context.length; i < j; i++) if (i in context) run(i, i, i === context.length - 1);
        } else if (Symbol.iterator in context) {
          const list = [...(context as Iterable<unknown>)];
          context = list;
          for (const j = list.length; i < j; i++) run(i, i, i === list.length - 1);
        } else {
          let prior: string | undefined;
          for (const key of Object.keys(context)) {
            if (prior !== undefined) run(prior, i - 1, false);
            prior = key;
            i++;
          }
          if (prior !== undefined) run(prior, i - 1, true);
        }
      }
      if (i === 0) ret = options.inverse!(this);
      return ret;
    },
    if(this: unknown, ...args: unknown[]) {
      if (args.length !== 2) throw new TemplateError('#if requires exactly one argument');
      let conditional = args[0];
      const options = args[1] as HelperOptions;
      if (typeof conditional === 'function') conditional = (conditional as Helper).call(this);
      if ((!options.hash.includeZero && !conditional) || isEmpty(conditional)) return options.inverse!(this);
      return options.fn!(this);
    },
    unless(this: unknown, ...args: unknown[]) {
      if (args.length !== 2) throw new TemplateError('#unless requires exactly one argument');
      const options = args[1] as HelperOptions;
      return helper('if')!.call(this, args[0], { ...options, fn: options.inverse, inverse: options.fn });
    },
    with(this: unknown, ...args: unknown[]) {
      if (args.length !== 2) throw new TemplateError('#with requires exactly one argument');
      let context = args[0];
      const options = args[1] as HelperOptions;
      if (typeof context === 'function') context = (context as Helper).call(this);
      if (isEmpty(context)) return options.inverse!(this);
      return options.fn!(context, { data: options.data, blockParams: [context] });
    },
    log: () => undefined,
    lookup(...args: unknown[]) {
      const [obj, field] = args;
      if (!obj) return obj;
      return lookupProperty(obj, String(field));
    },
  };
}

class Interpreter {
  readonly helpers: Record<string, Helper>;

  constructor(helpers: Record<string, Helper>) {
    this.helpers = { ...builtinHelpers((name) => this.helper(name)), ...helpers };
  }

  /** A registered helper (own properties only, like Handlebars' `lookupProperty`). */
  helper(name: string): Helper | undefined {
    return lookupProperty(this.helpers, name) as Helper | undefined;
  }

  render(program: Program, context: unknown): string {
    const frame: Frame = { context, depths: [context], data: { root: context }, blockParams: [] };
    return this.program(program, frame);
  }

  program(program: Program, frame: Frame): string {
    let out = '';
    for (const statement of program.body) out += this.statement(statement, frame);
    return out;
  }

  /** `options.fn` / `options.inverse` for a block: renders `program` with a new context. */
  wrap(program: Program | undefined, frame: Frame) {
    if (!program) return () => '';
    return (context: unknown, options: { data?: DataFrame; blockParams?: unknown[] } = {}) => {
      // Handlebars compares loosely.
      const depths = context != frame.depths[0] ? [context, ...frame.depths] : frame.depths;
      const names = program.blockParams ?? [];
      const blockParams = names.length
        ? [{ names, values: options.blockParams ?? [] }, ...frame.blockParams]
        : frame.blockParams;
      return this.program(program, { context, depths, data: options.data ?? frame.data, blockParams });
    };
  }

  statement(node: Node, frame: Frame): string {
    switch (node.type) {
      case 'ContentStatement':
        return (node as hbs.AST.ContentStatement).value;
      case 'CommentStatement':
        return '';
      case 'MustacheStatement':
      case 'BlockStatement': {
        const value = this.sexpr(node as hbs.AST.BlockStatement, frame);
        return value === null || value === undefined ? '' : String(value);
      }
      case 'PartialStatement':
      case 'PartialBlockStatement': {
        const name = (node as hbs.AST.PartialStatement).name as PathExpression;
        throw new TemplateError(`The partial ${name.original} could not be found`);
      }
      default:
        throw new TemplateError(`Unsupported template statement: ${node.type}`);
    }
  }

  /** Evaluates a mustache, block or subexpression like Handlebars' compiled code. */
  sexpr(
    node: hbs.AST.MustacheStatement | hbs.AST.BlockStatement | hbs.AST.SubExpression,
    frame: Frame,
  ): unknown {
    const path = asPath(node.path);
    const block = node.type === 'BlockStatement' ? (node as hbs.AST.BlockStatement) : undefined;
    const fns = block
      ? { fn: this.wrap(block.program, frame), inverse: this.wrap(block.inverse, frame) }
      : {};
    const simple = simpleId(path);
    const isBlockParam = simple && this.blockParam(path.parts[0]!, frame) !== undefined;
    let isHelper =
      !isBlockParam && (node.type === 'SubExpression' || Boolean(node.params?.length) || Boolean(node.hash));
    const eligible = !isBlockParam && (isHelper || simple);
    if (eligible && !isHelper && KNOWN_HELPERS.has(path.parts[0]!)) isHelper = true;

    if (isHelper) {
      const params = node.params.map((p) => this.expression(p, frame));
      const name = path.parts[0]!;
      if (KNOWN_HELPERS.has(name)) {
        const helper = this.helper(name);
        if (typeof helper !== 'function') throw new TemplateError(`helpers.${name} is not a function`);
        return helper.call(frame.context, ...params, this.options(name, node.hash, frame, fns));
      }
      const helper =
        (simple ? this.helper(name) : undefined) ||
        this.lookup(path, frame, true) ||
        this.helper('helperMissing');
      if (typeof helper !== 'function') throw new TemplateError(`${path.original} is not a function`);
      return (helper as Helper).call(
        frame.context,
        ...params,
        this.options(path.original, node.hash, frame, fns),
      );
    }

    if (eligible) {
      // Ambiguous: a helper if one is registered, otherwise a value, `helperMissing` if neither.
      const name = path.parts[0]!;
      let helper: unknown = this.helper(name) || this.lookup(path, frame, false);
      if (helper === null || helper === undefined) helper = this.helper('helperMissing');
      const options = this.options(name, undefined, frame, fns);
      let value = typeof helper === 'function' ? (helper as Helper).call(frame.context, options) : helper;
      if (block && !this.helper(name)) {
        value = this.helpers.blockHelperMissing!.call(frame.context, value, options);
      }
      return value;
    }

    // Simple: a value (functions are called), handed to `blockHelperMissing` for blocks.
    let value = this.lookup(path, frame, false);
    if (typeof value === 'function') value = (value as Helper).call(frame.context);
    if (block) {
      value = this.helpers.blockHelperMissing!.call(
        frame.context,
        value,
        this.options(path.original, undefined, frame, fns),
      );
    }
    return value;
  }

  options(
    name: string,
    hash: Hash | undefined,
    frame: Frame,
    fns: Pick<HelperOptions, 'fn' | 'inverse'>,
  ): HelperOptions {
    const values: Record<string, unknown> = {};
    for (const pair of hash?.pairs ?? []) values[pair.key] = this.expression(pair.value, frame);
    return { name, hash: values, data: frame.data, lookupProperty, ...fns };
  }

  expression(node: Expression, frame: Frame): unknown {
    switch (node.type) {
      case 'PathExpression':
        return this.lookup(node as PathExpression, frame, false);
      case 'SubExpression':
        return this.sexpr(node as hbs.AST.SubExpression, frame);
      case 'StringLiteral':
      case 'NumberLiteral':
      case 'BooleanLiteral':
        return (node as hbs.AST.StringLiteral).value;
      case 'UndefinedLiteral':
        return undefined;
      case 'NullLiteral':
        return null;
      default:
        throw new TemplateError(`Unsupported template expression: ${node.type}`);
    }
  }

  blockParam(name: string, frame: Frame): { level: number; index: number } | undefined {
    for (let level = 0; level < frame.blockParams.length; level++) {
      const index = frame.blockParams[level]!.names.indexOf(name);
      if (index >= 0) return { level, index };
    }
    return undefined;
  }

  /** Resolves a path. `falsy` stops at any falsy value (helper lookups); otherwise at null. */
  lookup(path: PathExpression, frame: Frame, falsy: boolean): unknown {
    const parts = path.parts;
    let current: unknown;
    let start = 0;
    if (path.data) {
      let data: DataFrame | undefined = frame.data;
      for (let depth = path.depth; data && depth > 0; depth--) data = data._parent;
      current = data;
      falsy = true;
    } else {
      const param =
        !path.depth && !scopedId(path) && parts.length ? this.blockParam(parts[0]!, frame) : undefined;
      if (param) {
        current = frame.blockParams[param.level]!.values[param.index];
        start = 1;
      } else {
        current = path.depth ? frame.depths[path.depth] : frame.context;
      }
    }
    for (let i = start; i < parts.length; i++) {
      current = falsy
        ? current && lookupProperty(current, parts[i]!)
        : current !== null && current !== undefined
          ? lookupProperty(current, parts[i]!)
          : current;
    }
    return current;
  }
}

let loading: Promise<Handlebars> | undefined;

/** Loads Handlebars' parser (a separate chunk; only Text Completion needs it). */
export function loadHandlebars(): Promise<Handlebars> {
  loading ??= import('handlebars').then(
    (m) => (m as unknown as { default?: Handlebars }).default ?? (m as Handlebars),
  );
  return loading;
}

const parsed = new Map<string, Program>();

/**
 * Renders `template` with `context` (no HTML escaping). Throws on syntax errors, partials and
 * helper misuse, like Handlebars.
 */
export function renderTemplate(
  handlebars: Handlebars,
  template: string,
  context: Record<string, unknown>,
  helpers: Record<string, Helper> = {},
): string {
  let ast = parsed.get(template);
  if (!ast) {
    ast = handlebars.parse(template);
    if (parsed.size >= 100) parsed.delete(parsed.keys().next().value!);
    parsed.set(template, ast);
  }
  return new Interpreter(helpers).render(ast, context);
}
