import Handlebars from 'handlebars';
import { describe, expect, it } from 'vitest';

import { renderTemplate, type Helper } from './handlebars.ts';
import templates from './st-templates.json' with { type: 'json' };

const context = {
  a: 'alpha',
  b: 'beta',
  list: ['x', 'y', 'z'],
  obj: { x: 1, y: 0 },
  zero: 0,
  empty: [],
  html: '<b>&</b>',
  description: 'Desc',
  personality: 'Pers',
  scenario: 'Scen',
  system: 'Sys',
  persona: 'Persona',
  wiBefore: 'WB',
  wiAfter: 'WA',
  loreBefore: 'WB',
  loreAfter: 'WA',
  anchorBefore: 'AB',
  anchorAfter: '',
  mesExamples: 'EX',
  mesExamplesRaw: 'EXR',
  char: 'Seraphina',
  user: 'User',
};

// SillyTavern's helpers.
const helpers: Record<string, Helper> = {
  trim: () => '{{trim}}',
  helperMissing: (...args: unknown[]) => `{{${(args.at(-1) as { name: string }).name}}}`,
};

const edgeCases = [
  '{{#if a}}A{{else if b}}B{{else}}C{{/if}}',
  '{{#unless a}}not a{{/unless}}|{{#unless b}}not b{{else}}b{{/unless}}',
  '{{#each list}}{{@index}}:{{this}}{{#if @first}}(first){{/if}}{{#if @last}}(last){{/if}},{{/each}}',
  '{{#each obj}}{{@key}}={{this}};{{/each}}',
  '{{#with obj}}{{x}}-{{../a}}{{/with}}',
  '{{#each list as |item i|}}[{{i}}:{{item}}]{{/each}}',
  '{{lookup obj "x"}} {{obj.x}} {{obj.missing}} {{this.a}} {{./a}} {{@root.a}}',
  '{{#a}}inside {{this}}{{/a}}{{#missing}}no{{else}}yes{{/missing}}{{#list}}<{{this}}>{{/list}}',
  '  {{#if a}}\n  standalone\n  {{/if}}\n{{~a~}} x {{~#if b}} y {{~/if~}} z\n',
  '{{!-- comment --}}{{! other }}{{zero}}|{{#if zero}}t{{else}}f{{/if}}|{{#if zero includeZero=true}}t{{else}}f{{/if}}',
  '{{#if empty}}e{{else}}ne{{/if}}{{#each empty}}x{{else}}none{{/each}}',
  '{{unknownThing}} {{unknown arg}} {{#unknownBlock}}x{{/unknownBlock}} {{trim}} {{random::a::b}}',
  '{{{a}}} {{&a}} {{html}}',
  '{{#if (lookup obj "x")}}sub{{/if}} {{#with (lookup obj "y")}}y{{else}}no y{{/with}}',
  '{{#each list}}{{#if @last}}{{../a}}{{/if}}{{/each}} {{#if a}}{{../a}}{{/if}}',
  '{{toString}} {{constructor}} {{a.length}} {{list.length}}',
  '{{#if}}x{{/if}}',
  '{{> partial}}',
  '{{#if a}}unclosed',
];

describe('renderTemplate', () => {
  const reference = Handlebars.create();
  for (const [name, helper] of Object.entries(helpers)) reference.registerHelper(name, helper);
  const render = (render: () => string) => {
    try {
      return render();
    } catch {
      return 'error';
    }
  };
  const storyStrings = templates.context.map((t) => (t.data as { story_string: string }).story_string);

  it.each([...storyStrings, ...edgeCases])('renders %j like Handlebars', (template) => {
    const expected = render(() => reference.compile(template, { noEscape: true })(context));
    expect(render(() => renderTemplate(Handlebars, template, context, helpers))).toBe(expected);
  });
});
