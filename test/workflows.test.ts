/**
 * Where the workflows let code and credentials reach, read from the parsed YAML and wrangler.jsonc.
 *
 * A text match cannot tell which job a step belongs to, or whether a word is a key, a value or an expression, so
 * every file in .github/workflows/ is parsed with `yaml`, and wrangler.jsonc, which carries no comments, with
 * JSON.parse.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

const WORKFLOWS = new URL('../.github/workflows/', import.meta.url);

/** The reusable workflow other workflows may call, as `uses:` names it. */
const LOCAL_CI = './.github/workflows/ci.yml';
/** An action or reusable workflow of another repository, pinned by a full commit SHA. */
const PINNED = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+@[0-9a-f]{40}$/;
/** The required checks, which are ci.yml's job IDs. */
const REQUIRED_JOBS = ['container', 'unit', 'worker'];
/** The secrets context as an expression names it, and not a property or an identifier that only contains the word. */
const SECRETS_CONTEXT = /(?<![\w.-])secrets(?![\w-])/i;

type Mapping = Record<string, unknown>;

function isMapping(value: unknown): value is Mapping {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Every workflow file, parsed. */
const workflows = readdirSync(WORKFLOWS, { withFileTypes: true })
  .filter((entry) => !entry.isDirectory())
  .map((entry) => {
    const document: unknown = parse(readFileSync(new URL(entry.name, WORKFLOWS), 'utf8'));
    return { file: entry.name, document };
  });

type Node = { where: string; path: string; key: string; value: unknown; holder: object };

/**
 * Every mapping entry and sequence item under value, depth first, with its dotted path, the mapping or sequence
 * holding it, and where it is as `<file> <path>`.
 */
function* nodes(file: string, value: unknown, path = ''): Generator<Node> {
  if (typeof value !== 'object' || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    const childPath = path === '' ? key : `${path}.${key}`;
    yield { where: `${file} ${childPath}`, path: childPath, key, value: child, holder: value };
    yield* nodes(file, child, childPath);
  }
}

/** Every node of every workflow. */
function allNodes(): Node[] {
  return workflows.flatMap(({ file, document }) => [...nodes(file, document)]);
}

/** The jobs of a parsed workflow, which must be a mapping of mappings. */
function jobsOf(file: string, document: unknown): Record<string, Mapping> {
  const jobs = isMapping(document) ? document['jobs'] : undefined;
  assert.ok(isMapping(jobs) && Object.values(jobs).every(isMapping), `${file} has no mapping of jobs`);
  return jobs as Record<string, Mapping>;
}

/** The parsed ci.yml. */
function ciWorkflow(): unknown {
  const ci = workflows.find(({ file }) => file === 'ci.yml');
  assert.ok(ci, '.github/workflows/ci.yml does not exist');
  return ci.document;
}

/**
 * The body of every ${{ }} in text, ended where GitHub's template reader ends it: at the first }} outside a
 * single-quoted string, so a quoted }} does not end it early. A body left unclosed runs to the end of text.
 * (actions/runner, src/Sdk/DTObjectTemplating/ObjectTemplating/TemplateReader.cs, ParseScalar.)
 */
function expressionBodies(text: string): string[] {
  const bodies: string[] = [];
  for (let start = text.indexOf('${{'); start !== -1; ) {
    let inString = false;
    let end = -1;
    for (let at = start + '${{'.length; at < text.length && end === -1; at += 1) {
      if (text[at] === "'") inString = !inString;
      else if (!inString && text[at] === '}' && text[at - 1] === '}') end = at;
    }
    bodies.push(text.slice(start + '${{'.length, end === -1 ? text.length : end - 1));
    start = end === -1 ? -1 : text.indexOf('${{', end + 1);
  }
  return bodies;
}

/**
 * What a workflow may evaluate as an expression, each with where it is: the ${{ }} bodies in every key and string
 * value, and the whole of each `if:` value, which GitHub evaluates as an expression with or without ${{ }}.
 */
function expressions(file: string, document: unknown): Array<{ where: string; expression: string }> {
  return [...nodes(file, document)].flatMap(({ where, key, value }) => {
    const bodies = expressionBodies(key);
    if (typeof value === 'string') bodies.push(...(key === 'if' ? [value] : expressionBodies(value)));
    return bodies.map((expression) => ({ where, expression: expression.trim() }));
  });
}

/** The expressions in document that reference the secrets context. */
function secretsReferences(file: string, document: unknown): string[] {
  return expressions(file, document)
    .filter(({ expression }) => SECRETS_CONTEXT.test(expression))
    .map(({ where, expression }) => `${where}: ${expression}`);
}

test(`every uses: is ${LOCAL_CI} or an action pinned by a full commit SHA`, () => {
  const refs = allNodes().filter(({ key }) => key === 'uses');
  assert.ok(refs.length > 0, 'no workflow has a uses:');
  const unpinned = refs
    .filter(({ value }) => value !== LOCAL_CI && !(typeof value === 'string' && PINNED.test(value)))
    .map(({ where, value }) => `${where}: ${JSON.stringify(value)}`);
  assert.deepEqual(unpinned, []);
});

test('every actions/checkout step has with: { persist-credentials: false }', () => {
  const checkouts = allNodes().filter(
    ({ key, value }) => key === 'uses' && typeof value === 'string' && /^actions\/checkout@/i.test(value),
  );
  assert.ok(checkouts.length > 0, 'no workflow has an actions/checkout step');
  const persisting = checkouts
    .filter(({ holder }) => {
      const inputs = isMapping(holder) ? holder['with'] : undefined;
      return !isMapping(inputs) || inputs['persist-credentials'] !== false;
    })
    .map(({ where }) => where);
  assert.deepEqual(persisting, []);
});

test("every workflow's top-level permissions are exactly { contents: read }, and no job sets permissions", () => {
  assert.ok(workflows.length > 0, 'no workflow was found');
  for (const { file, document } of workflows) {
    const permissions = isMapping(document) ? document['permissions'] : undefined;
    assert.deepEqual(permissions, { contents: 'read' }, `${file} top-level permissions`);
    const jobs = Object.entries(jobsOf(file, document));
    const widening = jobs.filter(([, job]) => Object.hasOwn(job, 'permissions')).map(([id]) => `${file} jobs.${id}`);
    assert.deepEqual(widening, [], 'jobs that set permissions');
  }
});

test('no workflow has secrets: inherit', () => {
  const inherits = (value: unknown) => typeof value === 'string' && value.trim().toLowerCase() === 'inherit';
  const inheriting = allNodes()
    .filter(({ key, value }) => key === 'secrets' && inherits(value))
    .map(({ where }) => where);
  assert.deepEqual(inheriting, []);
});

test('ci.yml references no secrets context', () => {
  assert.deepEqual(secretsReferences('ci.yml', ciWorkflow()), []);
});

test('the secrets scan ends expressions where GitHub does, and reads keys and bare if: values', () => {
  const found = parse(
    [
      'quoted-braces: "${{ contains(\'}}\', secrets.A) }}"',
      "escaped-quote: ${{ format('it''s }}', secrets.B) }}",
      'second: "${{ github.sha }} and ${{ secrets.C }}"',
      "if: secrets.D != ''",
      'unclosed: "${{ secrets.E"',
      'env:',
      '  ${{ secrets.F }}: key',
      'not-expressions: "echo secrets are not read ${{ steps.secrets.outputs.x }} ${{ inputs.no-secrets }}"',
    ].join('\n'),
  ) as unknown;
  assert.deepEqual(
    secretsReferences('fixture', found).map((line) => line.split(': ')[0]),
    [
      'fixture quoted-braces',
      'fixture escaped-quote',
      'fixture second',
      'fixture if',
      'fixture unclosed',
      'fixture env.${{ secrets.F }}',
    ],
  );
});

test('ci.yml defines exactly the jobs unit, container and worker, none with if: or name:', () => {
  const jobs = jobsOf('ci.yml', ciWorkflow());
  assert.deepEqual(Object.keys(jobs).toSorted(), REQUIRED_JOBS);
  const keyed = (key: string) => Object.keys(jobs).filter((id) => Object.hasOwn(jobs[id] as Mapping, key));
  assert.deepEqual(keyed('if'), [], 'ci.yml jobs with an if:, whose required check a condition could skip');
  assert.deepEqual(keyed('name'), [], 'ci.yml jobs with a name:, whose check is then not named by the job ID');
});

test('no workflow but ci.yml defines a job with the ID of a required check', () => {
  const reused = workflows
    .filter(({ file }) => file !== 'ci.yml')
    .flatMap(({ file, document }) =>
      Object.keys(jobsOf(file, document))
        .filter((id) => REQUIRED_JOBS.includes(id))
        .map((id) => `${file} jobs.${id}`),
    );
  assert.deepEqual(reused, []);
});

test('wrangler.jsonc has no build key', () => {
  const config: unknown = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.ok(isMapping(config), 'wrangler.jsonc is not an object');
  assert.ok(!Object.hasOwn(config, 'build'), 'wrangler.jsonc has a build key, a command wrangler deploy would run');
});
