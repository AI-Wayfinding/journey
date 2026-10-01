import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => readFileSync(root + path, 'utf8');
const packages = ['core', 'server', 'web', 'client'];
const guidance = [
  '- Run `bend guide` before writing Bend code.',
  '- `packages/rules/LAWS.bend` holds the rules; preserve their approved meaning.',
  '- Run `bend PROOF.bend` from `packages/rules/` before committing.',
  '- Parallelize independent work where possible.',
];
function build() {
  assert(existsSync(root + 'packages/rules/rules.mjs'), 'Missing compiled rules.mjs');
  const pkg = JSON.parse(read('packages/rules/package.json'));
  assert.equal(pkg.exports['.'].default, './rules.mjs');
  assert.equal(pkg.scripts.build, 'node ../../scripts/bend.mjs rules.bend -o rules.mjs');
  const main = JSON.parse(read('package.json'));
  assert(main.scripts.build.startsWith('npm run build:rules &&'), 'Rules must build first');
  for (const name of packages) {
    const consumer = JSON.parse(read(`packages/${name}/package.json`));
    assert(consumer.scripts.build.startsWith('npm run build -w @ai-wayfinding/rules &&'), `${name} build ordering`);
    assert.equal(consumer.dependencies[pkg.name], pkg.version, `${name} shared dependency`);
  }
  assert.match(read('packages/core/src/rules.ts'), /import rules from '@ai-wayfinding\/rules'/);
  assert.match(read('packages/server/src/enclave.ts'), /import rules from '@ai-wayfinding\/rules'/);
  for (const name of ['web', 'client']) assert.match(read(`packages/${name}/src/journey.ts`), /canWriteContent/);
  console.log('Bend clean build ordering and shared consumer imports passed');
}

// Parse expressions, not comments/string snippets. Parsing of legacy formats,
// identity binding, named-field normalization and display labels are allowed;
// effective scope, guide counting and ownership authority are not host rules.
function violations(source, path) {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const findings = [];
  const text = node => node.getText(file);
  function visit(node) {
    // Exempt only known format validators and named-field adapters in their
    // owning files, never a whole consumer or an arbitrary same-named function.
    if (path === 'packages/core/src/log.ts') {
      if (ts.isFunctionDeclaration(node) && ['validMember', 'copyMember'].includes(node.name?.text)) return;
      if (ts.isVariableDeclaration(node) && ['grants', 'memberBody', 'logDefinitions'].includes(node.name.getText(file))) return;
    }
    if (path === 'packages/core/src/rules.ts' && ts.isFunctionDeclaration(node) && ['normalizedMembers', 'projectMembers'].includes(node.name?.text)) return;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'includes' && node.arguments.some(arg => text(arg) === "'members.manage'")) {
      // addMember translates the verified signed grant into a boolean input.
      const adapter = path === 'packages/core/src/log.ts' && text(node.expression.expression) === '(body.grants as Grant[])';
      // liveGrantInput translates only the verified signed grant into replayControl's Bend input.
      const liveGrantInput = path === 'packages/server/src/enclave.ts' && text(node) === "(proof.body.grants as string[]).includes('members.manage')";
      if (!adapter && !liveGrantInput) findings.push('guide authority must call Bend');
    }
    if (ts.isBinaryExpression(node) && ['===', '!==', '==', '!='].includes(text(node.operatorToken))) {
      const expression = text(node);
      const roleTest = /(?:\.scope|\[['"]scope['"]\])\s*(?:===|!==|==|!=)\s*['"]read(?:write)?['"]/.test(expression);
      const ownedTest = /(?:\.addedBy|\[['"]addedBy['"]\])\s*(?:===|!==|==|!=)/.test(expression);
      // Stored transport inputs are intentionally not verified replay; server
      // identity matching and kind/scope constructor mapping stay host-owned.
      const mapping = ts.isConditionalExpression(node.parent)
        && (path === 'packages/core/src/rules.ts' && expression === "scope === 'read'"
          || path === 'packages/server/src/enclave.ts' && expression === "row.scope === 'readwrite'");
      const bendInput = path === 'packages/server/src/enclave.ts' && ts.isCallExpression(node.parent)
        && /^rules\.transport_(?:remove|renew)$/.test(text(node.parent.expression));
      // Server format checks: link credentials must be read-only; support
      // admission must match the pending invitation's scope and expiry.
      const scopeSchema = /packages\/client\/src\/(?:connection|state|storage)\.ts$/.test(path)
        && ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
        && /^(approved|row|session)\.scope !== 'read' && \1\.scope !== 'readwrite'$/.test(text(node.parent));
      const parser = scopeSchema || path === 'packages/server/src/index.ts' && ["change.scope !== 'read'", "b.scope !== 'read'", "row.scope !== 'read'"].includes(expression);
      if ((roleTest || ownedTest) && !mapping && !bendInput && !parser) findings.push('role/owner decision must call Bend');
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['filter', 'some'].includes(node.expression.name.text)) {
      if (/members\.manage|\.addedBy/.test(text(node))) findings.push('removal/last-guide decision must call Bend');
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return findings;
}
function sources(dir) {
  return readdirSync(root + dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? sources(`${dir}/${entry.name}`) : entry.name.endsWith('.ts') ? [`${dir}/${entry.name}`] : []);
}
async function rules() {
  for (const name of packages) {
    for (const path of sources(`packages/${name}/src`)) {
      assert.deepEqual(violations(read(path), path), [], `Duplicate TypeScript decisions: ${path}`);
    }
  }
  const required = {
    'packages/core/src/log.ts': ['replayControl', 'projectMembers'],
    'packages/core/src/removal.ts': ['replayControl', 'projectMembers', 'canControl'],
    'packages/core/src/link.ts': ['ownsAgent'],
    'packages/web/src/main.ts': ['canWriteContent', 'isPersonGuide', 'canControl', 'canRenameAgent'],
    'packages/web/src/journey.ts': ['canWriteContent', 'isPersonGuide'],
    'packages/client/src/journey.ts': ['canWriteContent', 'effectiveScope'],
    'packages/server/src/enclave.ts': ['rules.server_version', 'rules.member_access', 'rules.server_content', 'rules.server_read', 'rules.server_admission', 'replayControl', 'normalizedMembers'],
  };
  for (const [path, calls] of Object.entries(required)) for (const call of calls) assert(read(path).includes(`${call}(`), `${path} must use ${call}`);
  // Negative controls: deleting a guard or restoring representative legacy
  // implementations makes this executable check fail, rather than a marker.
  for (const fixture of [
    "if (state.grants[actor]?.includes('members.manage')) return true;",
    "if (state.members[id]?.member.scope === 'read') throw Error();",
    "if (member.addedBy !== actor) throw Error();",
    "Object.values(state.members).some(v => v.grants.includes('members.manage'));",
    "if (member['scope'] !== 'readwrite') return false;",
    "if (member['addedBy'] === actor) return true;",
    "function normalizedMembers() { return member.scope === 'read'; }",
    "const grants = state.grants[actor].includes('members.manage');",
  ]) for (const path of ['packages/core/src/removal.ts', 'packages/server/src/enclave.ts', 'packages/server/src/index.ts', 'packages/web/src/main.ts', 'packages/client/src/journey.ts']) {
    assert(violations(fixture, path).length > 0, `Boundary negative control: ${path}: ${fixture}`);
  }
  const grantInput = "(proof.body.grants as string[]).includes('members.manage')";
  assert.deepEqual(violations(grantInput, 'packages/server/src/enclave.ts'), []);
  assert(violations(grantInput, 'packages/server/src/index.ts').length > 0, 'Grant adapter exemption must be file-scoped');
  assert(violations("(proof.body.grants as string[]).includes('members.manage', 1)", 'packages/server/src/enclave.ts').length > 0, 'Grant adapter exemption must be expression-scoped');
  const { default: bend } = await import('../packages/rules/rules.mjs');
  const absent = { $: 'None' };
  const readonly = { $: 'Some', value: { $: 'ReadOnly' } };
  const writable = { $: 'Some', value: { $: 'ReadWrite' } };
  for (const scope of [absent, readonly, writable]) {
    assert.equal(bend.server_admission({ $: 'Person' }, scope, absent, 0n, 1n, true), scope === readonly, 'Support admission must remain explicitly read-only');
    assert.equal(bend.server_admission({ $: 'Person' }, scope, absent, 0n, 1n, false), true, 'Normal admission role comes from signed replay settings');
    for (const admitted of [absent, readonly, writable]) {
      assert.equal(bend.server_admission({ $: 'Agent' }, scope, admitted, 1n, 1n, false), scope === admitted, 'Agent scope must match the signed admission limit');
      assert.equal(bend.server_admission({ $: 'Agent' }, scope, admitted, 2n, 1n, false), false, 'Agent admission cannot use another adding person');
    }
  }
  assert(!/UPDATE principals SET removedAt=.*WHERE kind=/.test(read('packages/server/src/enclave.ts')), 'SQL must not duplicate the cascade');
  console.log('Bend-only decision source checks passed');
}
function agentGuidance() {
  const text = read('AGENTS.md');
  for (const line of guidance) assert(text.split('\n').includes(line), `Missing instruction: ${line}`);
  console.log('Four Bend guide instructions present in AGENTS.md');
}
const mode = process.argv[2];
assert(['--build', '--rules', '--guidance'].includes(mode), 'Use --build, --rules or --guidance');
if (mode === '--build') build();
if (mode === '--rules') await rules();
if (mode === '--guidance') agentGuidance();
