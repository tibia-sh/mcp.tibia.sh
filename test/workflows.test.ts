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
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'yaml';

const WORKFLOWS = new URL('../.github/workflows/', import.meta.url);

/** The reusable workflow other workflows may call, as `uses:` names it. */
const LOCAL_CI = './.github/workflows/ci.yml';
/** An action or reusable workflow of another repository, pinned by a full commit SHA. */
const PINNED = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+@[0-9a-f]{40}$/;
/** The required checks, which are ci.yml's job IDs. */
const REQUIRED_JOBS = ['container', 'unit', 'worker'];
/** What the wrangler deploy step of deploy.yml's deploy job runs. It is the one step that gets the deploy token. */
const WRANGLER_DEPLOY = 'pnpm exec wrangler deploy --var DEPLOY_COMMIT:${{ github.sha }}';
/** What the deploy job runs before wrangler deploy: the registry's signature on every installed package, verified. */
const AUDIT_SIGNATURES = 'pnpm audit signatures';
/** What the last step of deploy.yml's smoke job runs: the served-artifact check of the live URL, for this commit. */
const SMOKE_CHECK =
  'node scripts/served-artifact.ts https://mcp.tibia.sh/wiki --wait-seconds 600 --expect-commit ${{ github.sha }}';
/** What bump.yml's bump job runs right after the checkout: the move to the tip of main, which a queued run pins on. */
const BUMP_FETCH = 'git fetch --depth=1 origin main && git switch --detach FETCH_HEAD';
/** The two scripts that end bump.yml's bump job, in order. The publish is the one step that gets the trigger token. */
const BUMP_PIN = 'node scripts/bump.ts pin "$PACKAGE" "$VERSION"';
const BUMP_PUBLISH = 'node scripts/bump.ts publish "$PACKAGE" "$VERSION"';
/** The path of a job's or a step's own if: or continue-on-error. Job IDs hold no dots. */
const CONDITION = /^jobs\.[^.]+(?:\.steps\.\d+)?\.(?:if|continue-on-error)$/;
/** The secrets context as an expression names it, and not a property or an identifier that only contains the word. */
const SECRETS_CONTEXT = /(?<![\w.-])secrets(?![\w-])/i;
/** The vars context, which holds CLOUDFLARE_ACCOUNT_ID, matched the same way. */
const VARS_CONTEXT = /(?<![\w.-])vars(?![\w-])/i;

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

/** The parsed workflow in .github/workflows/<file>, which must exist. */
function workflow(file: string): unknown {
  const found = workflows.find((candidate) => candidate.file === file);
  assert.ok(found, `.github/workflows/${file} does not exist`);
  return found.document;
}

/** The steps of a job in a workflow, which must be a sequence. */
function stepsOf(file: string, job: string): unknown[] {
  const steps = jobsOf(file, workflow(file))[job]?.['steps'];
  assert.ok(Array.isArray(steps), `${file} jobs.${job} has no steps`);
  return steps;
}

/** The first of steps that runs exactly command, with its index. where names the job, for the failure. */
function stepRunning(steps: unknown[], command: string, where: string): { at: number; step: Mapping } {
  const at = steps.findIndex((step) => isMapping(step) && step['run'] === command);
  const step = steps[at];
  assert.ok(isMapping(step), `${where} has no step that runs ${command}`);
  return { at, step };
}

/**
 * The events that trigger a parsed workflow, as a mapping of event name to its filters or null, whether `on:` names
 * one event, lists several, or maps them.
 */
function triggers(file: string, document: unknown): Mapping {
  const on = isMapping(document) ? document['on'] : undefined;
  if (typeof on === 'string') return { [on]: null };
  if (Array.isArray(on) && on.every((event) => typeof event === 'string')) {
    return Object.fromEntries(on.map((event) => [event, null]));
  }
  assert.ok(isMapping(on), `${file} has no on: naming its triggers`);
  return on;
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

/** The expressions in document that reference the context, each as `<file> <path>: <expression>`. */
function references(file: string, document: unknown, context: RegExp): string[] {
  return expressions(file, document)
    .filter(({ expression }) => context.test(expression))
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

/** The uses: node of every step in every workflow whose action matches action. There must be at least one. */
function stepsUsing(action: RegExp, label: string): Node[] {
  const steps = allNodes().filter(({ key, value }) => key === 'uses' && typeof value === 'string' && action.test(value));
  assert.ok(steps.length > 0, `no workflow has ${label} step`);
  return steps;
}

/** Where each of steps has a with: other than exactly inputs. */
function differingInputs(steps: Node[], inputs: Mapping): string[] {
  return steps
    .filter(({ holder }) => !isDeepStrictEqual(isMapping(holder) ? holder['with'] : undefined, inputs))
    .map(({ where }) => where);
}

test('every actions/checkout step has exactly with: { persist-credentials: false }', () => {
  const checkouts = stepsUsing(/^actions\/checkout@/i, 'an actions/checkout');
  // Any other input, a ref above all, could check out a commit other than the one CI tested or deploy.yml labels.
  assert.deepEqual(differingInputs(checkouts, { 'persist-credentials': false }), []);
});

test("every actions/setup-node step has exactly with: { node-version: '26', package-manager-cache: false }", () => {
  const setups = stepsUsing(/^actions\/setup-node@/i, 'an actions/setup-node');
  // node-version is the Node every job runs on. setup-node caches by itself whenever package.json names a
  // packageManager, and package-manager-cache: false keeps a job from restoring what another run saved.
  assert.deepEqual(differingInputs(setups, { 'node-version': '26', 'package-manager-cache': false }), []);
});

test('every pnpm/setup step has exactly with: { install: true, require-lockfile: true }', () => {
  const setups = stepsUsing(/^pnpm\/setup@/i, 'a pnpm/setup');
  // Together the two inputs run pnpm install --frozen-lockfile, and fail without pnpm-lock.yaml. Any other input
  // could install a pnpm other than the one packageManager pins, or restore a store another run saved.
  assert.deepEqual(differingInputs(setups, { install: true, 'require-lockfile': true }), []);
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

test("ci.yml's triggers are exactly pull_request and workflow_call", () => {
  assert.deepEqual(Object.keys(triggers('ci.yml', workflow('ci.yml'))).toSorted(), ['pull_request', 'workflow_call']);
});

test("deploy.yml's triggers are exactly a push to main and workflow_dispatch", () => {
  assert.deepEqual(triggers('deploy.yml', workflow('deploy.yml')), {
    push: { branches: ['main'] },
    workflow_dispatch: null,
  });
});

test("bump.yml's triggers are exactly a first-party-release dispatch and a workflow_dispatch with two inputs", () => {
  assert.deepEqual(triggers('bump.yml', workflow('bump.yml')), {
    repository_dispatch: { types: ['first-party-release'] },
    workflow_dispatch: {
      inputs: {
        package: { description: '@tibia.sh/tibiawiki-mcp or @tibia.sh/tibiawiki-data', required: true },
        version: { description: 'The version to pin, as npm names it', required: true },
      },
    },
  });
});

test('no workflow is triggered by pull_request_target', () => {
  const targeted = workflows
    .filter(({ file, document }) => Object.hasOwn(triggers(file, document), 'pull_request_target'))
    .map(({ file }) => file);
  assert.deepEqual(targeted, []);
});

test('no workflow has secrets: inherit', () => {
  const inherits = (value: unknown) => typeof value === 'string' && value.trim().toLowerCase() === 'inherit';
  const inheriting = allNodes()
    .filter(({ key, value }) => key === 'secrets' && inherits(value))
    .map(({ where }) => where);
  assert.deepEqual(inheriting, []);
});

test('ci.yml references no secrets context', () => {
  assert.deepEqual(references('ci.yml', workflow('ci.yml'), SECRETS_CONTEXT), []);
});

test('the secrets any workflow references are the two tokens, once each, in the env of the step that uses it', () => {
  // The deploy token reaches the wrangler step of deploy.yml, and the release trigger token the publish step of
  // bump.yml. Every other step of every workflow, the whole of ci.yml above all, runs without a secret.
  const wrangler = stepRunning(stepsOf('deploy.yml', 'deploy'), WRANGLER_DEPLOY, 'deploy.yml jobs.deploy');
  const publish = stepRunning(stepsOf('bump.yml', 'bump'), BUMP_PUBLISH, 'bump.yml jobs.bump');
  assert.deepEqual(
    workflows.flatMap(({ file, document }) => references(file, document, SECRETS_CONTEXT)).toSorted(),
    [
      `bump.yml jobs.bump.steps.${publish.at}.env.GH_TOKEN: secrets.HOSTING_DISPATCH_TOKEN`,
      `deploy.yml jobs.deploy.steps.${wrangler.at}.env.CLOUDFLARE_API_TOKEN: secrets.CLOUDFLARE_API_TOKEN`,
    ],
  );
  assert.deepEqual(wrangler.step['env'], {
    CLOUDFLARE_API_TOKEN: '${{ secrets.CLOUDFLARE_API_TOKEN }}',
    CLOUDFLARE_ACCOUNT_ID: '${{ vars.CLOUDFLARE_ACCOUNT_ID }}',
    WRANGLER_SEND_METRICS: 'false',
  });
  assert.deepEqual(publish.step['env'], { GH_TOKEN: '${{ secrets.HOSTING_DISPATCH_TOKEN }}' });
});

test('no run: in bump.yml contains ${{, so the payload reaches the scripts as arguments read from env', () => {
  // A dispatch payload is untrusted. Interpolated into a command line, it would be run as shell text.
  const interpolating = [...nodes('bump.yml', workflow('bump.yml'))]
    .filter(({ key, value }) => key === 'run' && typeof value === 'string' && value.includes('${{'))
    .map(({ where }) => where);
  assert.deepEqual(interpolating, []);
});

test("no expression outside deploy.yml's deploy job references the vars context", () => {
  const outside = workflows
    .flatMap(({ file, document }) => references(file, document, VARS_CONTEXT))
    .filter((reference) => !reference.startsWith('deploy.yml jobs.deploy.'));
  assert.deepEqual(outside, []);
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
    references('fixture', found, SECRETS_CONTEXT).map((line) => line.split(': ')[0]),
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

test("the vars scan finds vars.X, vars['X'] and toJSON(vars), and not steps.vars.x or inputs.no-vars", () => {
  const found = parse(
    [
      'dotted: ${{ vars.CLOUDFLARE_ACCOUNT_ID }}',
      "indexed: ${{ vars['CLOUDFLARE_ACCOUNT_ID'] }}",
      'whole: ${{ toJSON(vars) }}',
      'not-expressions: "echo vars ${{ steps.vars.outputs.x }} ${{ inputs.no-vars }} ${{ env.VARS }}"',
    ].join('\n'),
  ) as unknown;
  assert.deepEqual(
    references('fixture', found, VARS_CONTEXT).map((line) => line.split(': ')[0]),
    ['fixture dotted', 'fixture indexed', 'fixture whole'],
  );
});

test('ci.yml defines exactly the jobs unit, container and worker, none with if: or name:', () => {
  const jobs = jobsOf('ci.yml', workflow('ci.yml'));
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

test('no job or step in any workflow has an if: or continue-on-error, so a failure stops what depends on it', () => {
  assert.deepEqual(
    allNodes()
      .filter(({ path }) => CONDITION.test(path))
      .map(({ where }) => where),
    [],
  );
});

test('no job in any workflow has a static name: of a required check', () => {
  const shadowing = workflows.flatMap(({ file, document }) =>
    Object.entries(jobsOf(file, document))
      .filter(([, job]) => {
        const name = job['name'];
        return typeof name === 'string' && REQUIRED_JOBS.includes(name.trim().toLowerCase());
      })
      .map(([id]) => `${file} jobs.${id}`),
  );
  assert.deepEqual(shadowing, []);
});

test("deploy.yml's deploy job needs the ci job, which calls ci.yml, and deploys in cloudflare-production", () => {
  const { ci, deploy } = jobsOf('deploy.yml', workflow('deploy.yml'));
  assert.ok(ci && deploy, 'deploy.yml needs a ci job and a deploy job');
  assert.equal(ci['uses'], LOCAL_CI);
  assert.equal(deploy['needs'], 'ci');
  assert.equal(deploy['environment'], 'cloudflare-production');
});

test("deploy.yml's smoke job needs deploy and has no environment", () => {
  const { smoke } = jobsOf('deploy.yml', workflow('deploy.yml'));
  assert.ok(smoke, 'deploy.yml has no smoke job');
  assert.equal(smoke['needs'], 'deploy');
  assert.ok(
    !Object.hasOwn(smoke, 'environment'),
    'deploy.yml jobs.smoke has an environment, whose secrets it could then read',
  );
});

test("deploy.yml's deploy job runs pnpm audit signatures, then wrangler deploy", () => {
  const steps = stepsOf('deploy.yml', 'deploy');
  const audit = stepRunning(steps, AUDIT_SIGNATURES, 'deploy.yml jobs.deploy').at;
  const deploy = stepRunning(steps, WRANGLER_DEPLOY, 'deploy.yml jobs.deploy').at;
  assert.ok(
    audit < deploy,
    `deploy.yml jobs.deploy runs ${AUDIT_SIGNATURES} at step ${audit}, after wrangler deploy at step ${deploy}`,
  );
});

test("deploy.yml's smoke job ends by running the served-artifact check for this commit", () => {
  const last = stepsOf('deploy.yml', 'smoke').at(-1);
  assert.ok(isMapping(last), 'deploy.yml jobs.smoke has no last step');
  assert.equal(last['run'], SMOKE_CHECK);
});

test('deploy.yml runs in the concurrency group deploy, which never cancels a run in progress', () => {
  const document = workflow('deploy.yml');
  assert.deepEqual(isMapping(document) ? document['concurrency'] : undefined, {
    group: 'deploy',
    'cancel-in-progress': false,
  });
});

test("bump.yml's one job is bump, in release-trigger, bounded at 45 minutes, with the payload in its env", () => {
  const jobs = jobsOf('bump.yml', workflow('bump.yml'));
  assert.deepEqual(Object.keys(jobs), ['bump']);
  const { bump } = jobs;
  assert.ok(bump, 'bump.yml has no bump job');
  // The environment holds the token and deploys from main only. The bound backs the two waits of the scripts, of
  // 10 and 30 minutes, and the install.
  assert.equal(bump['environment'], 'release-trigger');
  assert.equal(bump['timeout-minutes'], 45);
  // On a workflow_dispatch the inputs, otherwise the client_payload of the repository_dispatch, and nothing else.
  assert.deepEqual(bump['env'], {
    PACKAGE: "${{ github.event_name == 'workflow_dispatch' && inputs.package || github.event.client_payload.package }}",
    VERSION: "${{ github.event_name == 'workflow_dispatch' && inputs.version || github.event.client_payload.version }}",
  });
});

test('bump.yml runs in the concurrency group bump, which never cancels a run and keeps every waiting run', () => {
  // GitHub keeps one waiting run per group unless queue is max, and replaces it with the next one, which could drop
  // a data release behind a server release. With queue: max every run waits its turn, one after the other.
  const document = workflow('bump.yml');
  assert.deepEqual(isMapping(document) ? document['concurrency'] : undefined, {
    group: 'bump',
    'cancel-in-progress': false,
    queue: 'max',
  });
});

test("bump.yml's bump job is the checkout, the fetch of main, setup-node, pnpm/setup, the pin and the publish", () => {
  // A run that waited in the queue was given the main of its event time. The fetch moves it to the tip of main,
  // where the previous run merged, before the install and the scripts read anything. The actions are named without
  // their commit, which a pin bump moves.
  const shape = stepsOf('bump.yml', 'bump').map((step) => {
    if (!isMapping(step)) return step;
    return typeof step['uses'] === 'string' ? step['uses'].replace(/@.*$/, '') : step['run'];
  });
  assert.deepEqual(shape, [
    'actions/checkout',
    BUMP_FETCH,
    'actions/setup-node',
    'pnpm/setup',
    BUMP_PIN,
    BUMP_PUBLISH,
  ]);
});

test("the publish step is the only step of bump.yml's bump job with an env", () => {
  // The token is in that env and nowhere else, so the pin, which runs pnpm and the lockfile check, never sees it.
  const steps = stepsOf('bump.yml', 'bump');
  const withEnv = steps.flatMap((step, at) => (isMapping(step) && Object.hasOwn(step, 'env') ? [at] : []));
  assert.deepEqual(withEnv, [stepRunning(steps, BUMP_PUBLISH, 'bump.yml jobs.bump').at]);
});

test('wrangler.jsonc has no build key', () => {
  const config: unknown = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  assert.ok(isMapping(config), 'wrangler.jsonc is not an object');
  assert.ok(!Object.hasOwn(config, 'build'), 'wrangler.jsonc has a build key, a command wrangler deploy would run');
});
