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
    if (name === 'core' || name === 'client') {
      assert.equal(consumer.dependencies[pkg.name], undefined, `${name} must not publish a private dependency`);
      assert.equal(consumer.scripts.build, name === 'core' ? 'node ../../scripts/copy-core-rules.mjs && tsc' : 'tsc');
    } else {
      assert(consumer.scripts.build.startsWith('npm run build -w @ai-wayfinding/rules &&'), `${name} build ordering`);
      assert.equal(consumer.dependencies[pkg.name], pkg.version, `${name} shared dependency`);
    }
  }
  assert.match(read('packages/core/src/rules.ts'), /import rules from '\.\/rules\/rules\.mjs'/);
  assert.match(read('packages/server/src/enclave.ts'), /import rules from '@ai-wayfinding\/rules'/);
  for (const name of ['web', 'client']) assert.match(read(`packages/${name}/src/journey.ts`), /canWriteContent/);
  const lock = JSON.parse(read('package-lock.json')).packages;
  const version = JSON.parse(read('packages/core/package.json')).version;
  for (const name of ['core', 'client']) {
    assert.equal(JSON.parse(read(`packages/${name}/package.json`)).version, version);
    assert.equal(lock[`packages/${name}`].version, version);
    assert.equal(lock[`packages/${name}`].dependencies[pkg.name], undefined);
  }
  for (const name of ['server', 'web', 'client']) {
    assert.equal(JSON.parse(read(`packages/${name}/package.json`)).dependencies['@ai-wayfinding/core'], version);
    assert.equal(lock[`packages/${name}`].dependencies['@ai-wayfinding/core'], version);
  }
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
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'includes' && node.arguments.some(arg => text(arg) === "'members.manage'")) {
      // addMember translates the verified signed grant into a boolean input.
      const adapter = path === 'packages/core/src/log.ts' && ["(body.grants as Grant[]).includes('members.manage')", "b.grants.includes('members.manage')"].includes(text(node));
      // liveGrantInput translates only the verified signed grant into replayControl's Bend input.
      const liveGrantInput = path === 'packages/server/src/enclave.ts' && text(node) === "(proof.body.grants as string[]).includes('members.manage')";
      const normalizedGrant = path === 'packages/core/src/rules.ts' && text(node) === "v.grants.includes('members.manage')";
      if (!adapter && !liveGrantInput && !normalizedGrant) findings.push('guide authority must call Bend');
    }
    if (ts.isBinaryExpression(node) && ['<', '<=', '>', '>=', '===', '!==', '==', '!='].includes(text(node.operatorToken))) {
      const expression = text(node);
      const projectField = /(?:\.(?:project|participation|participants|active|revision)\b|\[['"](?:project|participation|participants|active|revision)['"]\])|(?:project|placement|pair)\.state\b/i;
      const projectDecision = !ts.isStringLiteral(node.left) && projectField.test(text(node.left)) || !ts.isStringLiteral(node.right) && projectField.test(text(node.right));
      if (/minClientVersion|CLIENT_VERSION/.test(expression)) findings.push('version decision must call Bend');
      // Exact syntax/normalization/display adapters only; these cannot authorize an action.
      const projectAdapter = [
        ['packages/core/src/projects.ts', "body.project === null"],
        ['packages/client/src/mcp.ts', "args.project === null"],
        ['packages/web/src/projects.ts', 'p.project === project'],
        ['packages/client/src/journey.ts', 'pair.project === id'],
        ['packages/core/src/log.ts', 'Number(value.revision) - 1 === seq'],
        ['packages/core/src/log.ts', 'Number(p.revision) - 1 === seq'],
        ['packages/core/src/log.ts', 'p.project === 0n'],
        ['packages/web/src/main.ts', "project.state === 'archived'"],
        ['packages/web/src/main.ts', 's === project.state'],
      ].some(([owner, input]) => owner === path && input === expression);
      if (projectDecision && !projectAdapter) findings.push('project participation/state/placement decision must call Bend');
      const roleTest = /(?:\.(?:scope|role|contentRole|limit)|\[['"](?:scope|role|contentRole|limit)['"]\])\s*(?:===|!==|==|!=)\s*['"](?:read(?:write)?|read-only|read-write)['"]/.test(expression);
      const artifactDecision = /(?:\.(?:predecessor|head|typeHash)|\[['"](?:predecessor|head|typeHash)['"]\])\s*(?:===|!==|==|!=)/.test(expression) && !/\s(?:undefined|null)$/.test(expression);
      // Type/hash projection checks validate content, not permission or transitions.
      const artifactFormat = path === 'packages/core/src/artifacts.ts' && expression === 'await artifactTypeHash(payload.content.kind) !== body.typeHash';
      const ownerField = ['packages/core/src/rules.ts', 'packages/core/src/log.ts'].includes(path) && ['value.addedBy !== undefined', 'value.addedBy === undefined'].includes(expression);
      const ownedTest = /(?:\.addedBy|\[['"]addedBy['"]\])\s*(?:===|!==|==|!=)/.test(expression) && !ownerField;
      const artifactOwnership = /(?:\.(?:author|writer|owner)|\[['"](?:author|writer|owner)['"]\])\s*(?:===|!==|==|!=)/.test(expression);
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
      const memberFormat = path === 'packages/core/src/log.ts' && ["value.scope === 'read'", "value.scope === 'readwrite'"].includes(expression);
      const parser = scopeSchema || memberFormat || path === 'packages/server/src/index.ts' && ["change.scope !== 'read'", "b.scope !== 'read'", "row.scope !== 'read'"].includes(expression);
      const roleInput = ts.isConditionalExpression(node.parent) && [
        ['packages/core/src/log.ts', "body.role === 'read-only'"],
        ['packages/server/src/enclave.ts', "proof.body.role === 'read-only'"],
        ['packages/core/src/rules.ts', "settings.defaultRole === 'read-only'"],
      ].some(([file, input]) => path === file && expression === input);
      const roleSchema = path === 'packages/core/src/log.ts' && ts.isBinaryExpression(node.parent)
        && text(node.parent) === "b.role === 'read-only' || b.role === 'read-write'";
      if ((roleTest || ownedTest || artifactOwnership || artifactDecision && !artifactFormat) && !mapping && !bendInput && !parser && !roleInput && !roleSchema) findings.push('role/owner/artifact decision must call Bend');
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ['filter', 'some', 'find', 'includes', 'has'].includes(node.expression.name.text)) {
      const expression = text(node);
      const projectMembership = /particip(?:ation|ants)|(?:pairs|placements)\b/.test(expression)
        || ts.isVariableDeclaration(node.parent) && /participant/i.test(text(node.parent.name));
      const adapter = [
        ['packages/web/src/projects.ts', 'ctx.state.projects?.participation.find(p => p.project === project && p.member === ctx.principal)'],
        ['packages/client/src/journey.ts', '(verified.state.projects?.participation ?? []).filter(pair => pair.project === id)'],
        ['packages/core/src/rules.ts', 'Object.keys(state.members).filter(actor => rules.project_participant(model.members, index.pairs, projectId(project), model.id(actor)))'],
        ['packages/core/src/rules.ts', 'Object.keys(state.artifacts?.items ?? {}).filter(id => rules.project_selected(rules.artifact_find(artifacts.items, model.id(id)), index.placements, chosen, model.id(id)))'],
      ].some(([owner, input]) => owner === path && input === expression);
      if (projectMembership && !adapter) findings.push('derived project participants/placement filtering must call Bend');
      const ownerIds = path === 'packages/core/src/rules.ts' && expression === 'Object.values(state.members).map(v => v.member.addedBy).filter((id): id is string => id !== undefined)';
      if (['filter', 'some'].includes(node.expression.name.text) && /members\.manage|\.addedBy/.test(text(node)) && !ownerIds) findings.push('removal/last-guide decision must call Bend');
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
    'packages/core/src/log.ts': ['replayControl', 'projectMembers', 'replayArtifact', 'replayProject', 'invalidateProjectParticipation'],
    'packages/core/src/rules.ts': ['rules.artifact_apply', 'rules.artifact_live_blob', 'rules.project_apply', 'rules.project_participant', 'rules.project_remove', 'rules.project_selector', 'rules.project_selected'],
    'packages/core/src/versions.ts': ['rules.artifact_client', 'rules.project_client'],
    'packages/web/src/artifacts.ts': ['canWriteContent'],
    'packages/server/src/agentLink.ts': ['canReadContent', 'effectiveProjectParticipants', 'selectProjectArtifacts'],
    'packages/client/src/journey.ts': ['canWriteContent', 'effectiveScope', 'replayArtifact', 'replayProject', 'effectiveProjectParticipants', 'selectProjectArtifacts'],
    'packages/core/src/removal.ts': ['replayControl', 'projectMembers', 'canControl'],
    'packages/core/src/link.ts': ['ownsAgent'],
    'packages/web/src/main.ts': ['canWriteContent', 'isPersonGuide', 'canControl', 'canRenameAgent', 'canEditProject', 'effectiveProjectParticipants', 'selectProjectArtifacts'],
    'packages/web/src/projects.ts': ['replayProject'],
    'packages/web/src/journey.ts': ['canWriteContent', 'isPersonGuide'],
    'packages/server/src/enclave.ts': ['rules.server_version', 'rules.member_access', 'rules.server_content', 'rules.server_read', 'rules.server_admission', 'replayControl', 'normalizedMembers', 'rules.blob_stage', 'rules.blob_upload', 'rules.blob_reference', 'rules.blob_read', 'rules.blob_collect', 'rules.blob_reuse', 'replayArtifact', 'liveArtifactBlobIds', 'replayProject', 'rules.project_client', 'rules.project_ready'],
  };
  for (const [path, calls] of Object.entries(required)) {
    const file = ts.createSourceFile(path, read(path), ts.ScriptTarget.Latest, true);
    const invoked = new Set();
    const visit = node => { if (ts.isCallExpression(node)) invoked.add(node.expression.getText(file)); ts.forEachChild(node, visit); };
    visit(file);
    for (const call of calls) assert(invoked.has(call), `${path} must use ${call}`);
  }
  // The artifact adapter must return Bend's transition, not an independent decision
  // with a dead/commented Bend call added to satisfy the call-site check.
  const adapters = ts.createSourceFile('rules.ts', read('packages/core/src/rules.ts'), ts.ScriptTarget.Latest, true);
  const replay = adapters.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'replayArtifact');
  const returned = replay?.body?.statements.find(ts.isReturnStatement)?.expression;
  assert(returned && ts.isObjectLiteralExpression(returned) && returned.properties.some(p => ts.isPropertyAssignment(p) && p.name.getText(adapters) === 'transition' && ts.isCallExpression(p.initializer) && p.initializer.expression.getText(adapters) === 'rules.artifact_apply'), 'Artifact replay transition must come directly from Bend');
  const projectReplay = adapters.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === 'replayProject');
  const projectReturn = projectReplay?.body?.statements.find(ts.isReturnStatement)?.expression;
  assert(projectReturn && ts.isObjectLiteralExpression(projectReturn) && projectReturn.properties.some(p => ts.isPropertyAssignment(p) && p.name.getText(adapters) === 'transition' && ts.isCallExpression(p.initializer) && p.initializer.expression.getText(adapters) === 'rules.project_apply'), 'Project replay transition must come directly from Bend');
  const directProjectAdapters = {
    effectiveProjectParticipants: 'Object.keys(state.members).filter(actor => rules.project_participant(model.members, index.pairs, projectId(project), model.id(actor)))',
    canEditProject: 'rules.project_participant(model.members, index.pairs, projectId(project), model.id(actor))',
    selectProjectArtifacts: 'Object.keys(state.artifacts?.items ?? {}).filter(id => rules.project_selected(rules.artifact_find(artifacts.items, model.id(id)), index.placements, chosen, model.id(id)))',
  };
  for (const [name, expression] of Object.entries(directProjectAdapters)) {
    const adapter = adapters.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    const returned = adapter?.body?.statements.filter(ts.isReturnStatement);
    assert(returned?.length === 1 && returned[0].expression?.getText(adapters) === expression, `${name} must use the real Bend decision as its return value`);
  }
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
    "if (artifact.author !== actor) return false;",
    "if (row.owner === subject.principal) return true;",
    "if (version['writer'] == actor) return true;",
    "if (member.role === 'read-write') return true;",
    "if (agent.limit === 'readwrite') return true;",
    "if (edit.predecessor !== artifact.head) return false;",
    "if (edit['typeHash'] === artifact.typeHash) return true;",
    "function normalizedArtifacts() { return artifact.author === actor; }",
    "const projection = row.owner === actor;",
    "if (pair.project === project && pair.member === actor && pair.active) return true;",
    "if (pair['active'] === true) return true;",
    "if (actor === pair['member'] && project === pair['project']) return true;",
    "if (project.revision <= edit.predecessor) return true;",
    "if (client >= state.minClientVersion) return true;",
    "const participants = Object.values(state.members).filter(member => member.live);",
    "if (project.state !== 'archived') return true;",
    "if (edit.revision === project.revision) return true;",
    "if (placement.project !== project.id) return false;",
    "if (project.participants.includes(actor)) return true;",
    "const members = state.projects.participation.filter(pair => pair.active);",
    "const participants = Object.values(state.members).filter(member => pairs.has(member.id));",
    "function normalizedProjects() { return pairs.some(pair => pair.member === actor); }",
    "if (body.role === 'read-only') return false;",
  ]) for (const path of ['packages/core/src/removal.ts', 'packages/server/src/enclave.ts', 'packages/server/src/index.ts', 'packages/web/src/main.ts', 'packages/client/src/journey.ts']) {
    assert(violations(fixture, path).length > 0, `Boundary negative control: ${path}: ${fixture}`);
  }
  for (const fixture of [
    "function normalizedMembers() { return state.projects.participation.filter(pair => pair.active); }",
    "function projectMembers() { return edit.predecessor === project.revision; }",
    "function validMember() { return project.participants.includes(actor); }",
    "const logDefinitions = [{ apply: () => pairs.some(pair => pair.member === actor) }];",
  ]) for (const path of ['packages/core/src/rules.ts', 'packages/core/src/log.ts']) {
    assert(violations(fixture, path).length > 0, `Adapter names must not exempt decisions: ${path}: ${fixture}`);
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
