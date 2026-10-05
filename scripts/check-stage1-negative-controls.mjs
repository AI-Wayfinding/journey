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
const tree = mkdtempSync(join(root, '.scratch/stage1-negative-'));
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
const core = 'core', server = 'server', web = 'web';
const contract = 'test/stage1-artifacts.test.ts', storage = 'test/stage1-storage.test.ts', blobs = 'test/stage1-blobs.test.ts', viewer = 'src/stage1-viewer.test.ts';
const forged = 'rejects forged author or actor, stale predecessors, reused IDs, changed type and cross-artifact references';
const mutation = (name, path, old, replacement, pkg, file, test, proof = false) => ({ name, path, old, replacement, pkg, file, test, proof });
const cases = [
  mutation('authority: public proof signature', 'packages/core/src/controlProof.ts', "if (!await crypto.subtle.verify('Ed25519', key, asBuffer(decode(proof.sig)), asBuffer(utf8(canonical(unsigned(proof))))))", 'if (false)', core, contract, 'rejects tampered signatures, chain, journey, ciphertext and unexpected signed fields'),
  mutation('authority: exact ciphertext binding', 'packages/core/src/controlProof.ts', 'proof.envelopeHash !== await digest(envelope)', 'false', core, contract, 'rejects tampered signatures, chain, journey, ciphertext and unexpected signed fields'),
  mutation('authority: ciphertext is not a second action', 'packages/core/src/artifacts.ts', "!shape(value, ['title', 'tags', 'content', 'attachments'])", 'false', core, contract, 'never treats ciphertext as another action or grants and rejects cross-journey descriptors'),
  mutation('attribution: immutable creator', rulesPath, '&& Nat.is_eq(author, actor) && Nat.is_eq(writer, actor)', '&& True{} && Nat.is_eq(writer, actor)', core, contract, forged, true),
  mutation('attribution: actual version writer', rulesPath, '&& Nat.is_eq(writer, actor) && Nat.is_eq(typeHash, kind)', '&& True{} && Nat.is_eq(typeHash, kind)', core, contract, forged, true),
  mutation('predecessor: stale version conflict', rulesPath, '&& Nat.is_eq(predecessor, head)', '&& True{}', core, contract, forged, true),
  mutation('reference: cross-artifact blob', rulesPath, 'Bool.not(artifact_other_blob(xs, target, h)) && artifact_references(t, xs, target)', 'True{} && artifact_references(t, xs, target)', core, contract, forged, true),
  mutation('authority: inherited writes, guide separation and pending rotation', rulesPath, 'content_write(member_access(find(members, actor), members), pending) && artifact_ready(minimum)', 'True{} && artifact_ready(minimum)', core, contract, 'requires current inherited write access, never guide grants or an agent control privilege', true),
  mutation('authority: signed Stage 1 minimum', rulesPath, '&& artifact_ready(minimum), index, actor, action)', '&& True{}, index, actor, action)', core, contract, 'requires the signed Stage 1 minimum before any artifact', true),
  mutation('reference: upload owner', rulesPath, 'allowed && exists && Nat.is_eq(owner, actor) && unexpired && available', 'allowed && exists && True{} && unexpired && available', server, storage, 'rejects stolen stages, cross-journey references and dishonest descriptors without partial writes', true),
  mutation('reference: completed upload', rulesPath, 'exists && matches && complete && Bool.pick', 'exists && matches && True{} && Bool.pick', server, storage, 'requires the completion flag even when interrupted upload bytes and a descriptor exist', true),
  mutation('current-access: upload completion after downgrade', 'packages/server/src/enclave.ts', 'if (!this.uploadAccess(state, input, true))', 'if (false)', server, storage, 'rechecks downgrade during a streamed upload and blocks the prebuilt commit'),
  mutation('reference: tombstoned downloads', rulesPath, 'allowed && live && complete', 'allowed && True{} && complete', server, storage, 'serializes a read/delete race and denies requests after the tombstone commits', true),
  mutation('reference: retain historic live versions during collection', rulesPath, 'Bool.not(live) && (expired || committed)', 'True{} && (expired || committed)', server, storage, 'pins author and writer, conflicts concurrent/stale edits, retains every live version and denies resurrection', true),
  mutation('size: actual raw bytes', 'packages/core/src/blobs.ts', 'bytes.byteLength > MAX_BLOB_BYTES', 'false', core, blobs, 'rejects limit-plus-one actual raw bytes before encryption, even with a claimed size'),
  mutation('size: streamed bytes independent of Content-Length', 'packages/server/src/enclave.ts', 'if (count > MAX_BLOB_BYTES + 16 || count > bytes.length) return failure(\'too-large\', 413);', 'if (false) return failure(\'too-large\', 413);', server, storage, 'enforces actual streamed lengths and digest with zero and inclusive 25,000,000 byte limits'),
  mutation('digest: complete binary upload', 'packages/core/src/blobs.ts', "if (await digest(bytes) !== descriptor.digest) throw new Error('Invalid blob ciphertext digest');\n  return descriptor;", 'return descriptor;', core, blobs, 'rejects wrong digests, changed binary bytes, truncation and oversized ciphertext'),
  mutation('URL: non-web schemes', 'packages/core/src/artifacts.ts', "(u.protocol === 'https:' || u.protocol === 'http:')", 'true', core, contract, 'refuses unsafe URLs without fetching and requires both Stage 1 capabilities'),
  mutation('URL: credentials', 'packages/core/src/artifacts.ts', '&& !u.username && !u.password', '&& true', core, contract, 'refuses unsafe URLs without fetching and requires both Stage 1 capabilities'),
  mutation('rendering: Markdown HTML', 'packages/web/src/artifact-viewer.ts', 'default: parent.append(document.createTextNode(token.raw));', 'default: parent.insertAdjacentHTML(\'beforeend\', token.raw);', web, viewer, 'never creates active Markdown HTML, images or automatic destinations'),
  mutation('rendering: raster signature before decoding', 'packages/web/src/artifact-viewer.ts', 'values.every((v, i) => bytes[i] === v)', 'true', web, viewer, 'requires raster signatures and successful decoding, rejecting SVG and fake MIME bytes'),
  mutation('rendering: CSV row bound', 'packages/web/src/data-worker.ts', 'rows: 100, columns: 100', 'rows: 101, columns: 100', web, viewer, 'keeps formulas as text and truncates CSV to 100 rows and 100 columns'),
  mutation('rendering: worker termination', 'packages/web/src/artifact-viewer.ts', 'settled = true; worker.terminate();', 'settled = true;', web, viewer, 'terminates workers on success, errors, timeout and cancellation, and preserves the original bytes'),
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
  assert.doesNotMatch(messages, /Cannot find (?:module|package)|SyntaxError|Transform failed|No test files|did not start|beforeAll hook/i, `Setup failure is not a negative control: ${name}`);
}
function proofFailure() {
  for (const args of [['PROOF.bend'], ['PROOF.bend', '--verdict']]) {
    const result = run(process.execPath, ['../../scripts/bend.mjs', ...args], join(tree, 'packages/rules'));
    // Bend can report a rejected theorem with exit 0. The verdict, not its exit alone, is the contract.
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
  for (const pkg of ['rules', core, server, web, 'client']) symlinkSync(join(tree, 'packages', pkg), join(tree, 'node_modules/@ai-wayfinding', pkg));
  mkdirSync(join(tree, '.scratch'), { recursive: true });
  // Core ships a copy of the rules runtime, so a rules rebuild must refresh core too.
  const buildRules = () => { setup(process.execPath, ['../../scripts/bend.mjs', 'rules.bend', '-o', 'rules.mjs'], join(tree, 'packages/rules')); buildCore(); };
  const buildCore = () => { setup(process.execPath, [join(tree, 'scripts/copy-core-rules.mjs')], tree); return setup(process.execPath, [join(tree, 'node_modules/typescript/bin/tsc')], join(tree, 'packages/core')); };
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
    if (c.proof) proofFailure();
    console.log(`Rejected mutation: ${c.name}${c.proof ? ' (test + both proof modes)' : ' (assertion)'}`);
    restore();
    if (c.path === rulesPath) buildRules();
    if (c.path.startsWith('packages/core/')) buildCore();
  }
  // Exercise the real gate against a duplicate host decision, not a comment or
  // fixture marker. Replacing a required adapter with a stub must fail too.
  for (const [name, path, old, replacement] of [
    ['duplicate TypeScript artifact predecessor', 'packages/client/src/journey.ts', 'import { canWriteContent, canReadContent, effectiveScope }', "function duplicate(edit: any, artifact: any) { return edit.predecessor === artifact.head; }\nimport { canWriteContent, canReadContent, effectiveScope }"],
    ['stubbed Bend artifact replay', 'packages/core/src/rules.ts', 'transition: rules.artifact_apply(model.members, model.id(actor), ruleVersion(state.minClientVersion), state.pendingRotation === true, index, action)', "transition: { $: 'ArtifactAccepted', index }"],
  ]) {
    patch(path, old, replacement);
    const result = run(process.execPath, ['scripts/check-bend-boundary.mjs', '--rules']);
    assert.equal(result.status, 1, `Boundary mutation survived: ${name}`);
    assert.match(result.output, /AssertionError.*(?:Duplicate TypeScript decisions|must use|transition must come directly from Bend)/s, `Boundary did not reach assertion: ${result.output}`);
    console.log(`Rejected mutation: ${name} (boundary assertion)`); restore();
  }
  // Harness controls: missing test, setup failure and a surviving no-op are not
  // accepted as proof. These deliberately call the same fail-closed validators.
  assert.throws(() => testCase({ ...cases[0], test: 'nonexistent Stage 1 test' }), /Must execute exactly/);
  patch('packages/core/test/stage1-artifacts.test.ts', "import { describe, expect, it } from 'vitest';", "import './missing-negative-control-module.js';\nimport { describe, expect, it } from 'vitest';");
  assert.throws(() => testCase(cases[0]), /Setup\/runtime failure|Must execute exactly/); restore();
  assert.throws(() => assertionFailure(testCase(cases[0]), 'surviving no-op'), /Mutation survived/);
  console.log(`Stage 1 negative controls passed: ${cases.length + 2} guard mutations; missing-test, setup-failure and survivor controls rejected`);
} finally {
  rmSync(tree, { recursive: true, force: true });
  assert(before.equals(trackedDiff()), 'Negative controls changed production tracked files');
}
