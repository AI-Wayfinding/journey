import Base

# Pure Stage 0 decisions. IDs and liveness are normalized by the verifying host.
type Role is Data:
  ReadOnly{}
  ReadWrite{}

type MemberKind is Data:
  Person{}
  Agent{}

def agent_access(member: Role, setting: Role) -> Role:
  match member:
    case ReadOnly{}:
      ReadOnly{}
    case ReadWrite{}:
      setting

def can_write(role: Role) -> Bool:
  match role:
    case ReadOnly{}:
      False{}
    case ReadWrite{}:
      True{}

def person_guide(kind: MemberKind, guide: Bool) -> Bool:
  match kind:
    case Person{}:
      guide
    case Agent{}:
      False{}

type Member is Data:
  Member{id: Nat, kind: MemberKind, role: Role, guide: Bool, owner: Nat, support: Bool, live: Bool}

def find(xs: +List<Member>, +id: Nat) -> Maybe<&2, Member>:
  match xs:
    case Nil{}:
      None{}
    case Con{+h, t}:
      Member{key, _, _, _, _, _, _} = h
      Bool.pick(Maybe<&2, Member>, Nat.is_eq(key, id), Some{h}, find(t, id))

def is_person(m: Maybe<&2, Member>) -> Bool:
  match m:
    case None{}:
      False{}
    case Some{Member{_, kind, _, _, _, _, live}}:
      match kind:
        case Person{}:
          live
        case Agent{}:
          False{}

def is_guide(m: Maybe<&2, Member>) -> Bool:
  match m:
    case None{}:
      False{}
    case Some{Member{_, kind, _, guide, _, _, live}}:
      person_guide(kind, guide) && live

def has_guide(xs: +List<Member>) -> Bool:
  match xs:
    case Nil{}:
      False{}
    case Con{h, t}:
      is_guide(Some{h}) || has_guide(t)

def agent_live_access(m: Maybe<&2, Member>, setting: Role, live: Bool) -> Maybe<&2, Role>:
  match m:
    case None{}:
      None{}
    case Some{Member{_, kind, role, _, _, _, parent_live}}:
      match kind:
        case Person{}:
          Bool.pick(Maybe<&2, Role>, live && parent_live, Some{agent_access(role, setting)}, None{})
        case Agent{}:
          None{}

def member_access(m: Maybe<&2, Member>, +xs: +List<Member>) -> Maybe<&2, Role>:
  match m:
    case None{}:
      None{}
    case Some{Member{_, kind, role, _, owner, _, live}}:
      match kind:
        case Person{}:
          Bool.pick(Maybe<&2, Role>, live, Some{role}, None{})
        case Agent{}:
          agent_live_access(find(xs, owner), role, live)


def access_write(a: Maybe<&2, Role>) -> Bool:
  match a:
    case None{}:
      False{}
    case Some{role}:
      can_write(role)

def access_read(a: Maybe<&2, Role>) -> Bool:
  match a:
    case None{}:
      False{}
    case Some{_}:
      True{}

# Exactly the target and, for a person, their agents are removed.
def owned_agent(kind: MemberKind, owner: Nat, actor: Nat) -> Bool:
  match kind:
    case Person{}:
      False{}
    case Agent{}:
      Nat.is_eq(owner, actor)

def survives(+target: Nat, person: Bool, m: Member) -> Bool:
  Member{id, kind, _, _, owner, _, _} = m
  Bool.not(Nat.is_eq(id, target) || (person && owned_agent(kind, owner, target)))


def remove(xs: +List<Member>, +target: Nat, +person: Bool) -> +List<Member>:
  match xs:
    case Nil{}:
      Nil{}
    case Con{+h, t}:
      +rest = remove(t, target, person)
      Bool.pick(+List<Member>, survives(target, person, h), h <> rest, rest)

def removal_authority(guide: Bool, self: Bool, target: Maybe<&2, Member>, actor: Nat) -> Bool:
  match target:
    case None{}:
      False{}
    case Some{Member{_, kind, _, _, owner, _, _}}:
      guide || self || owned_agent(kind, owner, actor)

def can_remove(+xs: +List<Member>, +actor: Nat, +target: Nat) -> Bool:
  is_person(find(xs, actor)) && removal_authority(is_guide(find(xs, actor)), Nat.is_eq(actor, target), find(xs, target), actor)


def set_guide(xs: +List<Member>, +id: Nat, +guide: Bool) -> +List<Member>:
  match xs:
    case Nil{}:
      Nil{}
    case Con{Member{+key, +kind, role, old, owner, support, live}, t}:
      next = Bool.pick(Bool, Nat.is_eq(key, id), person_guide(kind, guide), old)
      Member{key, kind, role, next, owner, support, live} <> set_guide(t, id, guide)

def set_role(xs: +List<Member>, +id: Nat, +role: Role) -> +List<Member>:
  match xs:
    case Nil{}:
      Nil{}
    case Con{Member{+key, kind, old, guide, owner, support, live}, t}:
      next = Bool.pick(Role, Nat.is_eq(key, id), role, old)
      Member{key, kind, next, guide, owner, support, live} <> set_role(t, id, role)

type Control is Data:
  Add{actor: Nat, member: Member}
  Remove{actor: Nat, target: Nat}
  Guide{actor: Nat, target: Nat, guide: Bool}
  RoleChange{actor: Nat, target: Nat, role: Role}
  Settings{actor: Nat}
  Profile{actor: Nat, target: Nat}
  Rename{actor: Nat, target: Nat}
  Rotate{actor: Nat}
  Renew{actor: Nat, target: Nat}

type Transition is Data:
  Accepted{members: +List<Member>}
  Denied{}
  Invalid{}
  LastGuide{}

def guarded_members(safe: Bool, members: +List<Member>) -> Transition:
  match safe:
    case False{}:
      LastGuide{}
    case True{}:
      Accepted{members}

def guard(allowed: Bool, +members: +List<Member>) -> Transition:
  match allowed:
    case False{}:
      Denied{}
    case True{}:
      guarded_members(has_guide(members), members)


def addition_authority(+xs: +List<Member>, +actor: Nat, m: Member) -> Bool:
  Member{_, kind, _, guide, owner, support, _} = m
  match kind:
    case Person{}:
      is_guide(find(xs, actor)) && Bool.not(support && guide)
    case Agent{}:
      is_person(find(xs, actor)) && Nat.is_eq(owner, actor) && Bool.not(guide)

def missing(m: Maybe<&2, Member>) -> Bool:
  match m:
    case None{}:
      True{}
    case Some{_}:
      False{}

def guide_target(m: Maybe<&2, Member>) -> Bool:
  match m:
    case None{}:
      False{}
    case Some{Member{_, kind, _, _, _, support, _}}:
      is_person(Some{Member{0n, kind, ReadOnly{}, False{}, 0n, False{}, True{}}}) && Bool.not(support)

def own_profile(+xs: +List<Member>, +actor: Nat, target: Nat) -> Bool:
  is_person(find(xs, actor)) && Nat.is_eq(actor, target)

def rename_authority(+xs: +List<Member>, +actor: Nat, target: Maybe<&2, Member>) -> Bool:
  match target:
    case None{}:
      False{}
    case Some{Member{_, kind, _, _, owner, _, _}}:
      match kind:
        case Person{}:
          False{}
        case Agent{}:
          is_person(find(xs, actor)) && (is_guide(find(xs, actor)) || Nat.is_eq(owner, actor))

def add_checked(fresh: Bool, allowed: Bool, member: Member, xs: +List<Member>) -> Transition:
  match fresh:
    case False{}:
      Invalid{}
    case True{}:
      guard(allowed, member <> xs)

# Legacy rename shape distinguishes a person target from an authority denial.
def rename_checked(person: Bool, allowed: Bool, xs: +List<Member>) -> Transition:
  match person:
    case True{}:
      Invalid{}
    case False{}:
      guard(allowed, xs)

def own_agent(+xs: +List<Member>, +actor: Nat, target: Maybe<&2, Member>) -> Bool:
  match target:
    case None{}:
      False{}
    case Some{Member{_, kind, _, _, owner, _, _}}:
      is_person(find(xs, actor)) && owned_agent(kind, owner, actor)

# Replay accepts only normalized, already signature/chain-verified controls.
def apply(+xs: +List<Member>, control: Control) -> Transition:
  match control:
    case Add{+actor, +member}:
      Member{+id, _, _, _, _, _, _} = member
      add_checked(missing(find(xs, id)), addition_authority(xs, actor, member), member, xs)
    case Remove{+actor, +target}:
      guard(can_remove(xs, actor, target), remove(xs, target, is_person(find(xs, target))))
    case Guide{+actor, +target, guide}:
      guard(is_guide(find(xs, actor)) && guide_target(find(xs, target)), set_guide(xs, target, guide))
    case RoleChange{+actor, +target, role}:
      guard(is_guide(find(xs, actor)) && guide_target(find(xs, target)), set_role(xs, target, role))
    case Settings{actor}:
      guard(is_guide(find(xs, actor)), xs)
    case Profile{+actor, target}:
      guard(own_profile(xs, actor, target), xs)
    case Rename{+actor, +target}:
      rename_checked(is_person(find(xs, target)), rename_authority(xs, actor, find(xs, target)), xs)
    case Rotate{actor}:
      guard(is_guide(find(xs, actor)), xs)
    case Renew{+actor, target}:
      guard(own_agent(xs, actor, find(xs, target)), xs)


def replay_step(state: Transition, control: Control) -> Transition:
  match state:
    case Accepted{xs}:
      apply(xs, control)
    case Denied{}:
      Denied{}
    case Invalid{}:
      Invalid{}
    case LastGuide{}:
      LastGuide{}

# Symbolic new-epoch holdings are delivered only to survivors. Old holdings
# are unchanged: this is neither a cryptographic proof nor recall of old keys.
def replay(controls: +List<Control>, state: Transition) -> Transition:
  match controls:
    case Nil{}:
      state
    case Con{h, t}:
      replay(t, replay_step(state, h))


def new_epoch_key(target: Nat, person: Bool, member: Member) -> Bool:
  survives(target, person, member)

# An executable population invariant used by the symbolic rotation proofs.
def all_survive(+target: Nat, +person: Bool, xs: +List<Member>) -> Bool:
  match xs:
    case Nil{}:
      True{}
    case Con{h, t}:
      survives(target, person, h) && all_survive(target, person, t)

# Storage effects and identity/expiry parsing belong to the host. This preserves
# the legacy transport scope gate until signed projections are wired downstream.
def transport_access(live: Bool, identity: Bool, write: Bool, role: Role) -> Bool:
  live && identity && (Bool.not(write) || can_write(role))

# The legacy encrypted server has no verified guide projection yet. These
# gates retain its existing transport behavior; they are not control replay.
def transport_remove(owned: Bool, kind: MemberKind) -> Bool:
  match kind:
    case Person{}:
      True{}
    case Agent{}:
      owned

def transport_renew(person: Bool, agent: Bool, owned: Bool, live: Bool) -> Bool:
  person && agent && owned && live

# Key holdings are symbolic (principal and epoch), not ciphertext or keys.
# Rotation delivers the next epoch to the same filtered population as removal.
type Holding is Data:
  Holding{principal: Nat, epoch: Nat}

def rotation_holdings(xs: +List<Member>, +epoch: Nat) -> +List<Holding>:
  match xs:
    case Nil{}:
      Nil{}
    case Con{Member{id, _, _, _, _, _, _}, tail}:
      Holding{id, epoch} <> rotation_holdings(tail, epoch)

def remove_and_rotate(xs: +List<Member>, target: Nat, person: Bool, epoch: Nat) -> +List<Holding>:
  rotation_holdings(remove(xs, target, person), epoch)

# Query a candidate's symbolic delivery in the next epoch. Old holdings are
# deliberately unchanged; a removal cannot revoke an earlier downloaded key.
def next_holding(+target: Nat, person: Bool, +member: Member, epoch: Nat) -> Maybe<&2, Holding>:
  Member{+id, _, _, _, _, _, _} = member
  Bool.pick(Maybe<&2, Holding>, new_epoch_key(target, person, member), Some{Holding{id, epoch}}, None{})

# Durable journey settings are independent of encrypted transport. All D41
# policies are representable; only invitation-only is active in Stage 0.
type Visibility is Data:
  Private{}
  Public{}

type Joining is Data:
  InvitationOnly{}
  GuideApproved{}
  Immediate{}

type JourneySettings is Data:
  JourneySettings{name: String, description: String, defaultRole: Role, visibility: Visibility, joining: Joining}

def active_settings(s: JourneySettings) -> Bool:
  match s:
    case JourneySettings{_, _, _, Private{}, InvitationOnly{}}:
      True{}
    case JourneySettings{_, _, _, _, _}:
      False{}

def legacy_settings(name: String, description: String) -> JourneySettings:
  JourneySettings{name, description, ReadWrite{}, Private{}, InvitationOnly{}}

def admission_role(support: Bool, defaultRole: Role) -> Role:
  match support:
    case True{}:
      ReadOnly{}
    case False{}:
      defaultRole

def admitted_member(member: Member, defaultRole: Role) -> Member:
  match member:
    case Member{id, Person{}, _, guide, owner, +support, live}:
      Member{id, Person{}, admission_role(support, defaultRole), guide, owner, support, live}
    case Member{id, Agent{}, role, guide, owner, support, live}:
      Member{id, Agent{}, role, guide, owner, support, live}

type Version is Data:
  Version{major: Nat, minor: Nat, patch: Nat}

def version_ge(a: Version, b: Version) -> Bool:
  Version{+am, +an, ap} = a
  Version{+bm, +bn, bp} = b
  Nat.is_gt(am, bm) || (Nat.is_eq(am, bm) && (Nat.is_gt(an, bn) || (Nat.is_eq(an, bn) && Nat.is_ge(ap, bp))))

def stage_ready(v: Version) -> Bool:
  version_ge(v, Version{0n, 1n, 4n})

# The old minimum entry is the migration barrier. Unknown or incompatible
# controls may never be replayed first, even when signed by a guide.
type JourneyState is Data:
  JourneyState{members: +List<Member>, settings: JourneySettings, minimum: Version, pending: Bool}

type JourneyControl is Data:
  LegacyControl{control: Control}
  NewControl{control: Control}
  Configure{actor: Nat, settings: JourneySettings}
  Minimum{actor: Nat, version: Version}

type JourneyTransition is Data:
  JourneyAccepted{state: JourneyState}
  JourneyDenied{}
  JourneyInvalid{}
  JourneyLastGuide{}
  UpgradeRequired{}

def journey_guard(allowed: Bool, state: JourneyState) -> JourneyTransition:
  match allowed:
    case False{}:
      JourneyDenied{}
    case True{}:
      JourneyAccepted{state}

def configure(+xs: +List<Member>, actor: Nat, +settings: JourneySettings, +minimum: Version, pending: Bool) -> JourneyTransition:
  journey_guard(stage_ready(minimum) && is_guide(find(xs, actor)) && active_settings(settings), JourneyState{xs, settings, minimum, pending})

def minimum_change(+xs: +List<Member>, actor: Nat, settings: JourneySettings, +old: Version, +next: Version, pending: Bool) -> JourneyTransition:
  journey_guard(is_guide(find(xs, actor)) && version_ge(next, old), JourneyState{xs, settings, next, pending})

def content_write(access: Maybe<&2, Role>, pending: Bool) -> Bool:
  access_write(access) && Bool.not(pending)

def control_pending(control: Control, pending: Bool) -> Bool:
  match control:
    case Remove{_, _}:
      True{}
    case Rotate{_}:
      False{}
    case _:
      pending

def admission_control(control: Control, settings: JourneySettings, upgraded: Bool) -> Control:
  match control:
    case Add{actor, +member}:
      JourneySettings{_, _, defaultRole, _, _} = settings
      Add{actor, Bool.pick(Member, upgraded, admitted_member(member, defaultRole), member)}
    case other:
      other

def journey_result(result: Transition, settings: JourneySettings, minimum: Version, pending: Bool) -> JourneyTransition:
  match result:
    case Accepted{members}:
      JourneyAccepted{JourneyState{members, settings, minimum, pending}}
    case Denied{}:
      JourneyDenied{}
    case Invalid{}:
      JourneyInvalid{}
    case LastGuide{}:
      JourneyLastGuide{}

def journey_control(xs: +List<Member>, +settings: JourneySettings, +minimum: Version, +pending: Bool, +control: Control) -> JourneyTransition:
  journey_result(apply(xs, admission_control(control, settings, stage_ready(minimum))), settings, minimum, Bool.pick(Bool, stage_ready(minimum), control_pending(control, pending), pending))

def upgrade_control(ready: Bool, xs: +List<Member>, settings: JourneySettings, minimum: Version, pending: Bool, control: Control) -> JourneyTransition:
  match ready:
    case False{}:
      UpgradeRequired{}
    case True{}:
      journey_control(xs, settings, minimum, pending, control)

def journey_apply(state: JourneyState, control: JourneyControl) -> JourneyTransition:
  JourneyState{xs, settings, +minimum, pending} = state
  match control:
    case LegacyControl{control}:
      journey_control(xs, settings, minimum, pending, control)
    case NewControl{control}:
      upgrade_control(stage_ready(minimum), xs, settings, minimum, pending, control)
    case Configure{actor, settings}:
      configure(xs, actor, settings, minimum, pending)
    case Minimum{actor, version}:
      minimum_change(xs, actor, settings, minimum, version, pending)

def journey_replay_step(result: JourneyTransition, control: JourneyControl) -> JourneyTransition:
  match result:
    case JourneyAccepted{state}:
      journey_apply(state, control)
    case other:
      other

def journey_replay(controls: +List<JourneyControl>, result: JourneyTransition) -> JourneyTransition:
  match controls:
    case Nil{}:
      result
    case Con{head, tail}:
      journey_replay(tail, journey_replay_step(result, head))

# Server transport gates consume verified current access, never caller access rows.
def server_version(+client: Version, +minimum: Version, format: Bool) -> Bool:
  format && stage_ready(client) && version_ge(client, minimum)

def server_read(access: Maybe<&2, Role>, identity: Bool, version: Bool) -> Bool:
  access_read(access) && identity && version

def server_content(access: Maybe<&2, Role>, identity: Bool, version: Bool, pending: Bool) -> Bool:
  content_write(access, pending) && identity && version

# Match the signed admission limit and adding person, not caller access rows.
def admission_scope(member: Maybe<&2, Role>, admitted: Maybe<&2, Role>) -> Bool:
  match member admitted:
    case None{} None{}:
      True{}
    case Some{ReadOnly{}} Some{ReadOnly{}}:
      True{}
    case Some{ReadWrite{}} Some{ReadWrite{}}:
      True{}
    case _ _:
      False{}

def server_admission(kind: MemberKind, scope: Maybe<&2, Role>, admitted: Maybe<&2, Role>, owner: Nat, actor: Nat, support: Bool) -> Bool:
  match kind:
    case Person{}:
      Bool.not(support) || admission_scope(scope, Some{ReadOnly{}})
    case Agent{}:
      Nat.is_eq(owner, actor) && admission_scope(scope, admitted)

# Stage 1 authority. Hosts normalize signed IDs and type commitments, never roles.
def artifact_ready(v: Version) -> Bool:
  version_ge(v, Version{0n, 1n, 5n})

def artifact_client(+client: Version, minimum: Version, control: Bool, artifact: Bool) -> Bool:
  control && artifact && artifact_ready(client) && version_ge(client, minimum)

type ArtifactVersion is Data:
  ArtifactVersion{id: Nat, writer: Nat, blobs: +List<Nat>}

type Artifact is Data:
  Artifact{id: Nat, author: Nat, typeHash: Nat, head: Nat, deleted: Bool, versions: +List<ArtifactVersion>}

type ArtifactIndex is Data:
  ArtifactIndex{items: +List<Artifact>, used: +List<Nat>}

type ArtifactAction is Data:
  ArtifactCreate{id: Nat, version: Nat, author: Nat, writer: Nat, typeHash: Nat, blobs: +List<Nat>}
  ArtifactEdit{id: Nat, version: Nat, predecessor: Nat, author: Nat, writer: Nat, typeHash: Nat, blobs: +List<Nat>}
  ArtifactComment{id: Nat, comment: Nat, onVersion: Nat, author: Nat, writer: Nat}
  ArtifactDelete{id: Nat, author: Nat, writer: Nat}

type ArtifactTransition is Data:
  ArtifactAccepted{index: ArtifactIndex}
  ArtifactDenied{}
  ArtifactConflict{}

def nat_has(xs: +List<Nat>, +id: Nat) -> Bool:
  match xs:
    case Nil{}:
      False{}
    case Con{h, t}:
      Nat.is_eq(h, id) || nat_has(t, id)

def artifact_find(xs: +List<Artifact>, +id: Nat) -> Maybe<&2, Artifact>:
  match xs:
    case Nil{}:
      None{}
    case Con{+h, t}:
      Artifact{key, _, _, _, _, _} = h
      Bool.pick(Maybe<&2, Artifact>, Nat.is_eq(key, id), Some{h}, artifact_find(t, id))

def artifact_put(xs: +List<Artifact>, +value: Artifact) -> +List<Artifact>:
  match xs:
    case Nil{}:
      value <> Nil{}
    case Con{+h, +t}:
      Artifact{+key, _, _, _, _, _} = h
      Artifact{id, _, _, _, _, _} = value
      Bool.pick(+List<Artifact>, Nat.is_eq(key, id), value <> t, h <> artifact_put(t, value))

def artifact_version_has(xs: +List<ArtifactVersion>, +id: Nat) -> Bool:
  match xs:
    case Nil{}:
      False{}
    case Con{ArtifactVersion{key, _, _}, t}:
      Nat.is_eq(key, id) || artifact_version_has(t, id)

def artifact_blob_has(xs: +List<ArtifactVersion>, +id: Nat) -> Bool:
  match xs:
    case Nil{}:
      False{}
    case Con{ArtifactVersion{_, _, blobs}, t}:
      nat_has(blobs, id) || artifact_blob_has(t, id)

def artifact_other_blob(xs: +List<Artifact>, +target: Nat, +blob: Nat) -> Bool:
  match xs:
    case Nil{}:
      False{}
    case Con{Artifact{id, _, _, _, _, versions}, t}:
      (Bool.not(Nat.is_eq(id, target)) && artifact_blob_has(versions, blob)) || artifact_other_blob(t, target, blob)

def artifact_references(blobs: +List<Nat>, +xs: +List<Artifact>, +target: Nat) -> Bool:
  match blobs:
    case Nil{}:
      True{}
    case Con{h, t}:
      Bool.not(artifact_other_blob(xs, target, h)) && artifact_references(t, xs, target)

def artifact_live_blob(xs: +List<Artifact>, +blob: Nat) -> Bool:
  match xs:
    case Nil{}:
      False{}
    case Con{Artifact{_, _, _, _, deleted, versions}, t}:
      (Bool.not(deleted) && artifact_blob_has(versions, blob)) || artifact_live_blob(t, blob)

def artifact_guard(valid: Bool, index: ArtifactIndex) -> ArtifactTransition:
  match valid:
    case False{}:
      ArtifactConflict{}
    case True{}:
      ArtifactAccepted{index}

def artifact_create(+xs: +List<Artifact>, +used: +List<Nat>, +actor: Nat, +id: Nat, +version: Nat, author: Nat, writer: Nat, typeHash: Nat, +blobs: +List<Nat>) -> ArtifactTransition:
  artifact_guard(Bool.not(nat_has(used, id) || nat_has(used, version) || Nat.is_eq(id, version)) && Nat.is_eq(author, actor) && Nat.is_eq(writer, actor) && artifact_references(blobs, xs, id), ArtifactIndex{Artifact{id, actor, typeHash, version, False{}, ArtifactVersion{version, actor, blobs} <> Nil{}} <> xs, id <> version <> used})

def artifact_edit(target: Maybe<&2, Artifact>, +xs: +List<Artifact>, +used: +List<Nat>, +actor: Nat, +id: Nat, +version: Nat, predecessor: Nat, author: Nat, writer: Nat, typeHash: Nat, +blobs: +List<Nat>) -> ArtifactTransition:
  match target:
    case None{}:
      ArtifactConflict{}
    case Some{Artifact{_, +creator, +kind, head, deleted, +versions}}:
      artifact_guard(Bool.not(deleted || nat_has(used, version)) && Nat.is_eq(predecessor, head) && Nat.is_eq(author, creator) && Nat.is_eq(writer, actor) && Nat.is_eq(typeHash, kind) && artifact_references(blobs, xs, id), ArtifactIndex{artifact_put(xs, Artifact{id, creator, kind, version, False{}, ArtifactVersion{version, actor, blobs} <> versions}), version <> used})

def artifact_comment(target: Maybe<&2, Artifact>, xs: +List<Artifact>, +used: +List<Nat>, actor: Nat, +comment: Nat, +onVersion: Nat, author: Nat, writer: Nat) -> ArtifactTransition:
  match target:
    case None{}:
      ArtifactConflict{}
    case Some{Artifact{_, creator, _, _, deleted, versions}}:
      artifact_guard(Bool.not(deleted || nat_has(used, comment)) && Nat.is_eq(author, creator) && Nat.is_eq(writer, actor) && (Nat.is_eq(onVersion, 0n) || artifact_version_has(versions, onVersion)), ArtifactIndex{xs, comment <> used})

def artifact_delete(target: Maybe<&2, Artifact>, +xs: +List<Artifact>, used: +List<Nat>, +id: Nat, author: Nat, writer: Nat, actor: Nat) -> ArtifactTransition:
  match target:
    case None{}:
      ArtifactConflict{}
    case Some{Artifact{_, +creator, kind, head, deleted, versions}}:
      artifact_guard(Bool.not(deleted) && Nat.is_eq(author, creator) && Nat.is_eq(writer, actor), ArtifactIndex{artifact_put(xs, Artifact{id, creator, kind, head, True{}, versions}), used})

def artifact_action(index: ArtifactIndex, +actor: Nat, action: ArtifactAction) -> ArtifactTransition:
  ArtifactIndex{+xs, used} = index
  match action:
    case ArtifactCreate{id, version, author, writer, typeHash, blobs}:
      artifact_create(xs, used, actor, id, version, author, writer, typeHash, blobs)
    case ArtifactEdit{+id, version, predecessor, author, writer, typeHash, blobs}:
      artifact_edit(artifact_find(xs, id), xs, used, actor, id, version, predecessor, author, writer, typeHash, blobs)
    case ArtifactComment{id, comment, onVersion, author, writer}:
      artifact_comment(artifact_find(xs, id), xs, used, actor, comment, onVersion, author, writer)
    case ArtifactDelete{+id, author, writer}:
      artifact_delete(artifact_find(xs, id), xs, used, id, author, writer, actor)

def artifact_authorized(allowed: Bool, index: ArtifactIndex, actor: Nat, action: ArtifactAction) -> ArtifactTransition:
  match allowed:
    case False{}:
      ArtifactDenied{}
    case True{}:
      artifact_action(index, actor, action)

def artifact_apply(+members: +List<Member>, +actor: Nat, minimum: Version, pending: Bool, index: ArtifactIndex, action: ArtifactAction) -> ArtifactTransition:
  artifact_authorized(content_write(member_access(find(members, actor), members), pending) && artifact_ready(minimum), index, actor, action)
