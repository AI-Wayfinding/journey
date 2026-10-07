export type Role = { $: 'ReadOnly' | 'ReadWrite' };
export type Kind = { $: 'Person' | 'Agent' };
export type List<T> = { $: 'Nil' } | { $: 'Con'; head: T; tail: List<T> };
export type Maybe<T> = { $: 'None' } | { $: 'Some'; value: T };
export interface Member { $: 'Member'; id: bigint; kind: Kind; role: Role; guide: boolean; owner: bigint; support: boolean; live: boolean }
export type Control = { $: 'Add'; actor: bigint; member: Member } | { $: 'Remove'; actor: bigint; target: bigint } | { $: 'Guide'; actor: bigint; target: bigint; guide: boolean } | { $: 'RoleChange'; actor: bigint; target: bigint; role: Role } | { $: 'Settings' | 'Rotate'; actor: bigint } | { $: 'Profile' | 'Rename' | 'Renew'; actor: bigint; target: bigint };
export interface Holding { $: 'Holding'; principal: bigint; epoch: bigint }
export type Transition = { $: 'Accepted'; members: List<Member> } | { $: 'Denied' } | { $: 'Invalid' } | { $: 'LastGuide' };
export interface JourneySettings { $: 'JourneySettings'; name: string; description: string; defaultRole: Role; visibility: { $: 'Private' | 'Public' }; joining: { $: 'InvitationOnly' | 'GuideApproved' | 'Immediate' } }
export interface Version { $: 'Version'; major: bigint; minor: bigint; patch: bigint }
export interface JourneyState { $: 'JourneyState'; members: List<Member>; settings: JourneySettings; minimum: Version; pending: boolean }
export type JourneyControl = { $: 'LegacyControl' | 'NewControl'; control: Control } | { $: 'Configure'; actor: bigint; settings: JourneySettings } | { $: 'Minimum'; actor: bigint; version: Version };
export type JourneyTransition = { $: 'JourneyAccepted'; state: JourneyState } | { $: 'JourneyDenied' | 'JourneyInvalid' | 'JourneyLastGuide' | 'UpgradeRequired' };
export interface ArtifactVersion { $: 'ArtifactVersion'; id: bigint; writer: bigint; blobs: List<bigint> }
export interface Artifact { $: 'Artifact'; id: bigint; author: bigint; typeHash: bigint; head: bigint; deleted: boolean; versions: List<ArtifactVersion> }
export interface ArtifactIndex { $: 'ArtifactIndex'; items: List<Artifact>; used: List<bigint> }
export type ArtifactAction = { $: 'ArtifactCreate'; id: bigint; version: bigint; author: bigint; writer: bigint; typeHash: bigint; blobs: List<bigint> } | { $: 'ArtifactEdit'; id: bigint; version: bigint; predecessor: bigint; author: bigint; writer: bigint; typeHash: bigint; blobs: List<bigint> } | { $: 'ArtifactComment'; id: bigint; comment: bigint; onVersion: bigint; author: bigint; writer: bigint } | { $: 'ArtifactDelete'; id: bigint; author: bigint; writer: bigint };
export type ArtifactTransition = { $: 'ArtifactAccepted'; index: ArtifactIndex } | { $: 'ArtifactDenied' | 'ArtifactConflict' };
export type ProjectPhase = { $: 'GettingStarted' | 'Active' | 'LookingForOthers' | 'Archived' };
export interface ProjectInfo { $: 'ProjectInfo'; id: bigint; revision: bigint; phase: ProjectPhase }
export interface Participation { $: 'Participation'; project: bigint; person: bigint; revision: bigint; active: boolean }
export interface Placement { $: 'Placement'; artifact: bigint; project: bigint; revision: bigint }
export interface ProjectIndex { $: 'ProjectIndex'; items: List<ProjectInfo>; pairs: List<Participation>; placements: List<Placement> }
export type ProjectAction = { $: 'ProjectCreate'; id: bigint } | { $: 'ProjectPurpose'; id: bigint; predecessor: bigint } | { $: 'ProjectStateChange'; id: bigint; predecessor: bigint; phase: ProjectPhase } | { $: 'ProjectJoin' | 'ProjectLeave'; id: bigint; member: bigint; predecessor: bigint } | { $: 'ArtifactProject'; id: bigint; project: bigint; author: bigint; writer: bigint; predecessor: bigint };
export type ProjectTransition = { $: 'ProjectAccepted'; index: ProjectIndex } | { $: 'ProjectDenied' | 'ProjectConflict' };
export type PrivateBundleScope = { $: 'PrivateBackup' | 'PrivateHandoff' | 'PrivateReturn' };
export type PrivateCredential = { $: 'PrivatePersonCredential' | 'PrivateAuthenticatedAgent' | 'PrivateLinkCredential' | 'PrivateUnknownCredential' };
export interface PrivateCopy { $: 'PrivateCopy'; id: bigint; artifact: bigint; author: bigint; journey: bigint; head: bigint; record: bigint; seq: bigint; deleted: boolean; versions: List<ArtifactVersion>; used: List<bigint>; project: bigint; placement: bigint; typeHash: bigint }
export type PrivateAction = { $: 'PrivateCreate'; artifact: bigint; author: bigint; writer: bigint; journey: bigint; version: bigint; typeHash: bigint; blobs: List<bigint> } | { $: 'PrivateEdit'; artifact: bigint; author: bigint; writer: bigint; version: bigint; typeHash: bigint; predecessor: bigint; blobs: List<bigint> } | { $: 'PrivateComment'; artifact: bigint; author: bigint; writer: bigint; comment: bigint; context: bigint } | { $: 'PrivateDelete'; artifact: bigint; author: bigint; writer: bigint; predecessor: bigint } | { $: 'PrivateProject'; artifact: bigint; author: bigint; writer: bigint; project: bigint; predecessor: bigint };
export type PrivateTransition = { $: 'PrivateAccepted'; value: PrivateCopy } | { $: 'PrivateConflict' | 'PrivateDenied' };
export type PrivateHeaderDecision = { $: 'PrivateUnverifiedFreshness' | 'PrivateVerifiedFreshness' | 'PrivateMergeRequired' | 'PrivateHeaderConflict' | 'PrivateRollback' };
export type PrivateMergeChoice = { $: 'PrivateLeft' | 'PrivateRight' | 'PrivateBoth' | 'PrivateTombstone' };
declare const rules: {
  private_bundle_recipient(scope: PrivateBundleScope, kind: Kind, same: boolean): boolean;
  private_origin_version(current: bigint, observed: bigint): boolean;
  private_authority_snapshot(journey: bigint, head: bigint, otherJourney: bigint, otherHead: bigint): boolean;
  private_ready(version: Version): boolean;
  private_client(client: Version, minimum: Version, control: boolean, artifact: boolean, project: boolean, privateFormat: boolean): boolean;
  private_audience(members: List<Member>, author: bigint, actor: bigint, credential: PrivateCredential): boolean;
  private_link_read(members: List<Member>, actor: bigint): boolean;
  private_wrap_access(members: List<Member>, author: bigint, actor: bigint, target: bigint, credential: PrivateCredential, write: boolean): boolean;
  private_write(members: List<Member>, author: bigint, actor: bigint, credential: PrivateCredential, minimum: Version, pending: boolean, current: boolean): boolean;
  private_copy_access(source: boolean, destination: boolean, different: boolean, visibility: JourneySettings['visibility']): boolean;
  private_apply(allowed: boolean, value: Maybe<PrivateCopy>, id: bigint, actor: bigint, record: bigint, seq: bigint, previous: bigint, next: PrivateAction, projects: List<ProjectInfo>): PrivateTransition;
  private_copied(source: PrivateCopy, id: bigint, actor: bigint, record: bigint, journey: bigint, version: bigint, blobs: List<bigint>, observed: bigint, fresh: boolean, allowed: boolean): PrivateTransition;
  private_selected(value: PrivateCopy, selector: bigint, allowed: boolean): boolean;
  private_references(own: boolean, complete: boolean, digest: boolean, staged: boolean): boolean;
  private_header(retained: bigint, incoming: bigint, same: boolean, predecessor: boolean, paired: boolean): PrivateHeaderDecision;
  private_merge(left: bigint, right: bigint, leftDeleted: boolean, rightDeleted: boolean, same: boolean): PrivateMergeChoice;
  private_capacity(bytes: number): boolean;
  private_slots(dirty: List<bigint>, randomOrder: List<bigint>): List<bigint>;
  private_sync_due(open: boolean, elapsed: bigint): boolean;
  project_ready(version: Version): boolean;
  project_client(client: Version, minimum: Version, control: boolean, artifact: boolean, project: boolean): boolean;
  project_apply(members: List<Member>, actor: bigint, minimum: Version, pending: boolean, index: ProjectIndex, artifacts: ArtifactIndex, revision: bigint, action: ProjectAction): ProjectTransition;
  project_participant(members: List<Member>, pairs: List<Participation>, project: bigint, actor: bigint): boolean;
  project_remove(pairs: List<Participation>, person: bigint, revision: bigint): List<Participation>;
  project_selector(items: List<ProjectInfo>, selector: bigint): boolean;
  project_selected(target: Maybe<Artifact>, placements: List<Placement>, selector: bigint, id: bigint): boolean;

  blob_reuse(target: Maybe<Artifact>, blob: bigint): boolean;
  artifact_find(items: List<Artifact>, id: bigint): Maybe<Artifact>;
  blob_stage(access: Maybe<Role>, identity: boolean, version: boolean, pending: boolean, epoch: bigint, current: bigint): boolean;
  blob_upload(allowed: boolean, exists: boolean, owner: bigint, actor: bigint, unexpired: boolean, available: boolean): boolean;
  blob_reference(exists: boolean, matches: boolean, complete: boolean, committed: boolean, owner: bigint, actor: bigint, unexpired: boolean, epoch: bigint, current: bigint, sameArtifact: boolean): boolean;
  blob_read(allowed: boolean, live: boolean, complete: boolean): boolean;
  blob_collect(live: boolean, expired: boolean, committed: boolean): boolean;
  artifact_ready(version: Version): boolean;
  artifact_client(client: Version, minimum: Version, control: boolean, artifact: boolean): boolean;
  artifact_apply(members: List<Member>, actor: bigint, minimum: Version, pending: boolean, index: ArtifactIndex, action: ArtifactAction): ArtifactTransition;
  artifact_action(index: ArtifactIndex, actor: bigint, action: ArtifactAction): ArtifactTransition;
  artifact_live_blob(items: List<Artifact>, blob: bigint): boolean;
  artifact_blob_has(versions: List<ArtifactVersion>, blob: bigint): boolean;
  artifact_other_blob(items: List<Artifact>, target: bigint, blob: bigint): boolean;
  artifact_references(blobs: List<bigint>, items: List<Artifact>, target: bigint): boolean;

  server_version(client: Version, minimum: Version, format: boolean): boolean;
  server_read(access: Maybe<Role>, identity: boolean, version: boolean): boolean;
  server_content(access: Maybe<Role>, identity: boolean, version: boolean, pending: boolean): boolean;
  server_admission(kind: Kind, scope: Maybe<Role>, admitted: Maybe<Role>, owner: bigint, actor: bigint, support: boolean): boolean;
  legacy_settings(name: string, description: string): JourneySettings;
  active_settings(settings: JourneySettings): boolean;
  version_ge(a: Version, b: Version): boolean;
  stage_ready(version: Version): boolean;
  content_write(access: Maybe<Role>, pending: boolean): boolean;
  journey_apply(state: JourneyState, control: JourneyControl): JourneyTransition;
  journey_replay(controls: List<JourneyControl>, result: JourneyTransition): JourneyTransition;
  can_write(role: Role): boolean;
  person_guide(kind: Kind, guide: boolean): boolean;
  find(xs: List<Member>, id: bigint): Maybe<Member>;
  is_person(member: Maybe<Member>): boolean;
  is_guide(member: Maybe<Member>): boolean;
  has_guide(xs: List<Member>): boolean;
  member_access(member: Maybe<Member>, xs: List<Member>): Maybe<Role>;
  access_write(access: Maybe<Role>): boolean;
  access_read(access: Maybe<Role>): boolean;
  can_remove(xs: List<Member>, actor: bigint, target: bigint): boolean;
  remove(xs: List<Member>, target: bigint, person: boolean): List<Member>;
  apply(xs: List<Member>, control: Control): Transition;
  replay(controls: List<Control>, state: Transition): Transition;
  new_epoch_key(target: bigint, person: boolean, member: Member): boolean;
  all_survive(target: bigint, person: boolean, members: List<Member>): boolean;
  remove_and_rotate(members: List<Member>, target: bigint, person: boolean, epoch: bigint): List<Holding>;
  next_holding(target: bigint, person: boolean, member: Member, epoch: bigint): Maybe<Holding>;
  transport_remove(owned: boolean, kind: Kind): boolean;
  transport_renew(person: boolean, agent: boolean, owned: boolean, live: boolean): boolean;
  survives(target: bigint, person: boolean, member: Member): boolean;
  owned_agent(kind: Kind, owner: bigint, actor: bigint): boolean;
  own_agent(xs: List<Member>, actor: bigint, target: Maybe<Member>): boolean;
  rename_authority(xs: List<Member>, actor: bigint, target: Maybe<Member>): boolean;
  transport_access(live: boolean, identity: boolean, write: boolean, role: Role): boolean;
};
export default rules;
