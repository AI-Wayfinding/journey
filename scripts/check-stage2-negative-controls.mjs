import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (dir, path) => readFileSync(join(dir, path), 'utf8');
const trackedDiff = () => execFileSync('git', ['diff', '--binary', 'HEAD', '--', '.'], { cwd: root });
const before = trackedDiff();
mkdirSync(join(root, '.scratch'), { recursive: true });
const tree = mkdtempSync(join(root, '.scratch/stage2-negative-'));
const originals = new Map();
const run = (command, args, cwd = tree) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
  assert(!result.error && !result.signal && Number.isInteger(result.status), `Could not run ${command}: ${result.error ?? result.signal}`);
  return { status: result.status, output: result.stdout + result.stderr };
};
const setup = (command, args, cwd) => {
  const result = run(command, args, cwd);
  assert.equal(result.status, 0, `Setup failed: ${command} ${args.join(' ')}\n${result.output}`);
  return result;
};
function patch(path, old, replacement) {
  const source = read(tree, path);
  assert.equal(source.split(old).length, 2, `Mutation anchor must be unique: ${path}: ${old}`);
  if (!originals.has(path)) originals.set(path, source);
  writeFileSync(join(tree, path), source.replace(old, replacement));
}
function restore() {
  for (const [path, source] of originals) writeFileSync(join(tree, path), source);
  originals.clear();
}
const rulesPath = 'packages/rules/rules.bend';
const contract = 'test/stage2-projects.test.ts', storage = contract, link = 'test/stage2-link.test.ts';
const self = 'enforces self-only live person joins and derives agents without independent participation or content elevation';
const removal = 'invalidates removal participation so readmission does not resurrect pairs; expiry and agent limits are live';
const separation = 'never elevates D17 to edit, comment, delete, placement or blob staging, including during rotation';
const placement = 'keeps one same-journey placement, intersections, attribution, content/blob identity and archived nonparticipant reads';
const lifecycle = 'shares only metadata revisions, records every state transition including archive/reopening and remains readable';
const payload = 'fails closed on signatures, references, ciphertext commitments, payload authority and missing keyed epochs without partial state';
const versions = 'requires a signed Stage 2 barrier and all capabilities, while 0.1.5 remains supported for old histories';
const linkSelectors = 'selects main/project/all without project membership or recovery/download/mutation routes';
const pagination = 'continues large Unicode purposes, text and effective rosters under PAGE_LIMIT with unchanged selectors and no plaintext storage';
const mutation = (name, path, old, replacement, pkg, file, test, proof = false) => ({ name, path, old, replacement, pkg, file, test, proof });
const bend = (name, old, replacement, test, proof = false) => mutation(name, rulesPath, old, replacement, 'core', contract, test, proof);
const cases = [
  bend('participation: self-only', 'Nat.is_eq(actor, member) && is_person(find(members, actor))', 'True{} && is_person(find(members, actor))', self, true),
  bend('participation: agents cannot join', 'Nat.is_eq(actor, member) && is_person(find(members, actor))', 'Nat.is_eq(actor, member) && True{}', self, true),
  bend('inheritance: live adding person', 'case Agent{}: live && project_person(find(members, owner), pairs, project)', 'case Agent{}: live && True{}', removal, true),
  bend('invalidation: removal cannot resurrect pairs', 'active && Bool.not(Nat.is_eq(member, person))} <> project_remove', 'active && True{}} <> project_remove', removal, true),
  bend('D17: metadata requires participation', 'case ProjectStateChange{id, _, _}: project_participant(members, pairs, id, actor)', 'case ProjectStateChange{id, _, _}: True{}', self),
  bend('D17: purpose requires participation', 'case ProjectPurpose{id, _}: project_participant(members, pairs, id, actor)', 'case ProjectPurpose{id, _}: True{}', self),
  bend('D17: content is not metadata', 'content_write(member_access(find(members, actor), members), pending) && artifact_ready(minimum)', 'True{} && artifact_ready(minimum)', separation, true),
  bend('D17: blob staging still needs content access', 'server_content(access, identity, version, pending) && Nat.is_eq(epoch, current)', 'True{} && Nat.is_eq(epoch, current)', separation),
  bend('creation: content authority not guide status', 'case ProjectCreate{_}: content_write(member_access(find(members, actor), members), pending)', 'case ProjectCreate{_}: True{}', self, true),
  bend('creation: getting-started initial state', 'ProjectInfo{id, revision, GettingStarted{}} <> items', 'ProjectInfo{id, revision, Active{}} <> items', 'creates a fixed initial state with empty participation and committed private purpose; old histories are empty', true),
  bend('predecessor: purpose revision', 'project_guard(Nat.is_eq(old, predecessor), ProjectIndex{project_put(items, ProjectInfo{id, revision, previous})', 'project_guard(True{}, ProjectIndex{project_put(items, ProjectInfo{id, revision, previous})', lifecycle, true),
  bend('predecessor: state revision', 'project_guard(Nat.is_eq(old, predecessor) && Bool.not(phase_eq(previous, next))', 'project_guard(True{} && Bool.not(phase_eq(previous, next))', lifecycle),
  bend('participation: duplicate join/leave conflict', '&& Bool.pick(Bool, active, Bool.not(before), before), ProjectIndex{items, pair_put', '&& True{}, ProjectIndex{items, pair_put', self, true),
  bend('placement: content authority', 'case ArtifactProject{_, _, _, _, _}: content_write(member_access(find(members, actor), members), pending)', 'case ArtifactProject{_, _, _, _, _}: True{}', separation, true),
  bend('placement: observed predecessor', '&& Nat.is_eq(old, predecessor) && Bool.not(Nat.is_eq(previous, project))', '&& True{} && Bool.not(Nat.is_eq(previous, project))', placement, true),
  bend('placement: single same-journey project', '(Nat.is_eq(project, 0n) || project_exists(project_find(items, project)))', 'True{}', placement),
  bend('placement: deleted reference', 'Bool.not(deleted) && Nat.is_eq(author, creator) && Nat.is_eq(writer, actor) && Nat.is_eq(old, predecessor)', 'True{} && Nat.is_eq(author, creator) && Nat.is_eq(writer, actor) && Nat.is_eq(old, predecessor)', placement, true),
  bend('filter: main intersection', '(Nat.is_eq(selector, 1n) || Nat.is_eq(selector, project))', 'True{}', placement),
  bend('version: signed project barrier', 'project_ready(minimum) && project_previous(action, revision)', 'True{} && project_previous(action, revision)', versions, true),
  bend('capability: project required', 'control && artifact && project && project_ready(client)', 'control && artifact && True{} && project_ready(client)', versions, true),
  bend('capability: control required', 'control && artifact && project && project_ready(client)', 'True{} && artifact && project && project_ready(client)', versions),
  bend('capability: artifact required', 'control && artifact && project && project_ready(client)', 'control && True{} && project && project_ready(client)', versions),
  mutation('version: no partial future keyed history', 'packages/core/src/controlProof.ts', "!stage0Rules.version_ge(ruleVersion('0.1.6'), ruleVersion(state.minClientVersion))", 'Boolean(false)', 'core', contract, versions),
  mutation('payload: ciphertext commitment', 'packages/core/src/projects.ts', 'await projectPurposeHash(record.body.purpose) !== body.purposeHash', 'false', 'core', contract, payload),
  mutation('payload: extra fields are not authority', 'packages/core/src/projects.ts', "!shape(record.body, ['purpose'])", 'false', 'core', contract, payload),
  mutation('public: exact named fields', 'packages/core/src/projects.ts', '!shape(body, projectFields(type))', 'false', 'core', contract, 'rejects unexpected fields, multiple/foreign shapes, unknown states and malformed references before replay'),
  mutation('public: unknown controls', 'packages/core/src/projects.ts', '(PROJECT_ACTIONS as readonly string[]).includes(type)', 'true', 'core', contract, 'rejects unknown project controls even with an empty public body'),
  mutation('atomicity: persisted verified projection', 'packages/server/src/enclave.ts', "this.sql.exec('UPDATE authority SET state=?', JSON.stringify(verified.state));\n      this.sql.exec('UPDATE meta SET nextLog=?', proof.seq + 1);\n    });\n    return Response.json({ seq: proof.seq, memberDelta: 0, removed: [], minClientVersion: verified.state.minClientVersion }", "this.sql.exec('UPDATE authority SET state=?', JSON.stringify(state));\n      this.sql.exec('UPDATE meta SET nextLog=?', proof.seq + 1);\n    });\n    return Response.json({ seq: proof.seq, memberDelta: 0, removed: [], minClientVersion: verified.state.minClientVersion }", 'server', storage, 'atomically persists verified projection, exact retries and fresh-object replay without plaintext or caller extras'),
  mutation('link: no mutation route', 'packages/server/src/index.ts', "app.get('/a/:secret', async c => {", "app.all('/a/:secret', async c => {", 'server', link, linkSelectors),
  mutation('link: read-only scope', 'packages/server/src/agentLink.ts', "scope: 'read', expiresAt:", "scope: 'readwrite', expiresAt:", 'server', link, linkSelectors),
  mutation('link: selector intersection', 'packages/server/src/agentLink.ts', 'artifacts.filter(a => selected.has(a.id))', 'artifacts', 'server', link, linkSelectors),
  mutation('link: continuation selector', 'packages/server/src/agentLink.ts', "selector === undefined ? '' : `&project=${encodeURIComponent(selector)}`", "true ? '' : `&project=${encodeURIComponent(selector)}`", 'server', link, pagination),
  mutation('link: UTF-8 pagination bound', 'packages/server/src/agentLink.ts', 'export const PAGE_LIMIT = 12_000;', 'export const PAGE_LIMIT = 120_000;', 'server', link, pagination),
];

function testCase(c) {
  const report = join(tree, '.scratch/report.json');
  rmSync(report, { force: true });
  const result = run(process.execPath, [join(tree, 'node_modules/vitest/vitest.mjs'), 'run', c.file, '-t', c.test.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), '--reporter=json', `--outputFile=${report}`], join(tree, `packages/${c.pkg}`));
  let data;
  try { data = JSON.parse(readFileSync(report, 'utf8')); } catch { throw new Error(`Missing test report: ${c.name}\n${result.output}`); }
  assert.equal(data.testResults.length, 1, `Setup/runtime failure: ${c.name}\n${result.output}`);
  assert(data.testResults.every(s => !s.message), `Setup/runtime failure: ${c.name}\n${data.testResults.map(s => s.message).join('\n')}\n${result.output}`);
  const tests = data.testResults.flatMap(s => s.assertionResults).filter(t => t.status !== 'pending' && t.status !== 'skipped');
  assert.equal(tests.length, 1, `Must execute exactly the named test: ${c.name}\n${result.output}`);
  assert.equal(tests[0].title, c.test, `Wrong test: ${c.name}`);
  return { result, test: tests[0] };
}
function assertionFailure(outcome, name) {
  assert.equal(outcome.result.status, 1, `Mutation survived: ${name}\n${outcome.result.output}`);
  assert.equal(outcome.test.status, 'failed', `Expected assertion failure: ${name}`);
  const messages = outcome.test.failureMessages.join('\n');
  assert.match(messages, /AssertionError|expected .* (?:to |but )|promise resolved .*instead of rejecting/is, `Not an assertion failure: ${name}\n${messages}`);
  console.log(`Assertion exit=${outcome.result.status}: ${name}: ${messages.split('\n').find(line => /AssertionError|expected|promise resolved/i.test(line))}`);
  assert.doesNotMatch(messages, /Cannot find (?:module|package)|SyntaxError|Transform failed|No test files|did not start|beforeAll hook/i, `Setup failure is not a negative control: ${name}`);
}
function proofFailure(name) {
  for (const args of [['PROOF.bend'], ['PROOF.bend', '--verdict']]) {
    const result = run(process.execPath, ['../../scripts/bend.mjs', ...args], join(tree, 'packages/rules'));
    // Bend can report a rejected theorem with exit 0. The verdict, not its exit alone, is the contract.
    console.log(`Proof exit=${result.status}: ${name}: ${args.join(' ')}: ${result.output.split('\n').find(line => /Type mismatch|Invalid proof|PROOFS? (?:FAIL|REJECT)|Proof.*(?:failed|invalid)/i.test(line))}`);
    assert(!result.output.includes('ALL PROOFS CHECK'), `Proof mutation survived: ${args.join(' ')}`);
    assert.match(result.output, /Type mismatch|Invalid proof|PROOFS? (?:FAIL|REJECT)|Proof.*(?:failed|invalid)/i, `Proof did not reach a theorem failure:\n${result.output}`);
  }
}
try {
  // Copy tracked bytes, never mutate the working tree or share generated outputs.
  const paths = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  for (const path of paths) { mkdirSync(dirname(join(tree, path)), { recursive: true }); writeFileSync(join(tree, path), readFileSync(join(root, path))); }
  mkdirSync(join(tree, 'node_modules/@ai-wayfinding'), { recursive: true });
  for (const entry of readdirSync(join(root, 'node_modules'))) {
    if (entry === '@ai-wayfinding') continue;
    // Vite resolves the SQLite wasm URL against realpath and denies a URL
    // outside this disposable root. Copy this asset package; never relax Vite.
    if (entry === 'sql.js') cpSync(join(root, 'node_modules', entry), join(tree, 'node_modules', entry), { recursive: true });
    else symlinkSync(join(root, 'node_modules', entry), join(tree, 'node_modules', entry));
  }
  for (const pkg of ['rules', 'core', 'server', 'web', 'client']) symlinkSync(join(tree, 'packages', pkg), join(tree, 'node_modules/@ai-wayfinding', pkg));
  mkdirSync(join(tree, '.scratch'), { recursive: true });
  const buildRules = () => setup(process.execPath, ['../../scripts/bend.mjs', 'rules.bend', '-o', 'rules.mjs'], join(tree, 'packages/rules'));
  const buildCore = () => setup(process.execPath, [join(tree, 'node_modules/typescript/bin/tsc')], join(tree, 'packages/core'));
  buildRules(); buildCore();
  // One clean baseline for every named test proves that each mutation has a
  // runnable assertion, not a skipped/missing test or an already broken suite.
  const baselines = new Set();
  for (const c of cases) {
    const key = `${c.pkg}/${c.file}/${c.test}`;
    if (baselines.has(key)) continue;
    const outcome = testCase(c);
    assert.equal(outcome.result.status, 0, `Baseline failed: ${c.name}\n${outcome.result.output}`);
    assert.equal(outcome.test.status, 'passed', `Baseline did not pass: ${c.name}`);
    baselines.add(key);
  }
  for (const c of cases) {
    patch(c.path, c.old, c.replacement);
    if (c.path === rulesPath) buildRules();
    if (c.path.startsWith('packages/core/')) buildCore();
    assertionFailure(testCase(c), c.name);
    if (c.proof) proofFailure(c.name);
    console.log(`Rejected mutation: ${c.name}${c.proof ? ' (test + both proof modes)' : ' (assertion)'}`);
    restore();
    if (c.path === rulesPath) buildRules();
    if (c.path.startsWith('packages/core/')) buildCore();
  }
  // Exercise the real gate against a duplicate host decision, not a comment or
  // fixture marker. Replacing a required adapter with a stub must fail too.
  for (const [name, path, old, replacement] of [
    ['duplicate TypeScript project predecessor', 'packages/client/src/journey.ts', 'import { canWriteContent, canReadContent, effectiveScope }', "function duplicate(edit: any, project: any) { return edit.predecessor === project.revision; }\nimport { canWriteContent, canReadContent, effectiveScope }"],
    ['duplicate TypeScript participant filtering', 'packages/client/src/journey.ts', 'import { canWriteContent, canReadContent, effectiveScope }', "function duplicate(state: any) { return state.projects.participation.filter((pair: any) => pair.active); }\nimport { canWriteContent, canReadContent, effectiveScope }"],
    ['stubbed Bend project replay', 'packages/core/src/rules.ts', 'transition: rules.project_apply(model.members, model.id(actor), ruleVersion(state.minClientVersion), state.pendingRotation === true, index, reserved, revision(state.lastSeq + 1), action)', "transition: { $: 'ProjectAccepted', index }"],
  ]) {
    patch(path, old, replacement);
    const result = run(process.execPath, ['scripts/check-bend-boundary.mjs', '--rules']);
    assert.equal(result.status, 1, `Boundary mutation survived: ${name}`);
    assert.match(result.output, /AssertionError.*(?:Duplicate TypeScript decisions|must use|transition must come directly from Bend)/s, `Boundary did not reach assertion: ${result.output}`);
    console.log(`Rejected mutation: ${name} (boundary assertion exit=${result.status})`); restore();
  }
  // Harness controls: missing test, setup failure and a surviving no-op are not
  // accepted as proof. These deliberately call the same fail-closed validators.
  assert.throws(() => testCase({ ...cases[0], test: 'nonexistent Stage 2 test' }), /Must execute exactly/);
  patch('packages/core/test/stage2-projects.test.ts', "import { describe, expect, it } from 'vitest';", "import './missing-negative-control-module.js';\nimport { describe, expect, it } from 'vitest';");
  assert.throws(() => testCase(cases[0]), /Setup\/runtime failure|Must execute exactly/); restore();
  assert.throws(() => assertionFailure(testCase(cases[0]), 'surviving no-op'), /Mutation survived/);
  console.log(`Stage 2 negative controls passed: ${cases.length + 3} guard mutations; missing-test, setup-failure and survivor controls rejected`);
} finally {
  rmSync(tree, { recursive: true, force: true });
  assert(before.equals(trackedDiff()), 'Negative controls changed production tracked files');
}
