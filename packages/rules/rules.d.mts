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
declare const rules: {
  server_version(client: Version, minimum: Version, format: boolean): boolean;
  server_read(access: Maybe<Role>, identity: boolean, version: boolean): boolean;
  server_content(access: Maybe<Role>, identity: boolean, version: boolean, pending: boolean): boolean;
  legacy_settings(name: string, description: string): JourneySettings;
  active_settings(settings: JourneySettings): boolean;
  version_ge(a: Version, b: Version): boolean;
  stage_ready(version: Version): boolean;
  content_write(access: Maybe<Role>, pending: boolean): boolean;
  journey_apply(state: JourneyState, control: JourneyControl): JourneyTransition;
  journey_replay(controls: List<JourneyControl>, result: JourneyTransition): JourneyTransition;
  agent_access(member: Role, setting: Role): Role;
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
