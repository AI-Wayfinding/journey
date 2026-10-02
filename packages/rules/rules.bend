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

# Storage lifecycle inputs are verified facts; these predicates own every decision.
def blob_stage(access: Maybe<&2, Role>, identity: Bool, version: Bool, pending: Bool, epoch: Nat, current: Nat) -> Bool:
  server_content(access, identity, version, pending) && Nat.is_eq(epoch, current)

def blob_upload(allowed: Bool, exists: Bool, owner: Nat, actor: Nat, unexpired: Bool, available: Bool) -> Bool:
  allowed && exists && Nat.is_eq(owner, actor) && unexpired && available

def blob_reference(exists: Bool, matches: Bool, complete: Bool, committed: Bool, owner: Nat, actor: Nat, unexpired: Bool, epoch: Nat, current: Nat, sameArtifact: Bool) -> Bool:
  exists && matches && complete && Bool.pick(Bool, committed, sameArtifact, Nat.is_eq(owner, actor) && unexpired && Nat.is_eq(epoch, current))

def blob_read(allowed: Bool, live: Bool, complete: Bool) -> Bool:
  allowed && live && complete

def blob_collect(live: Bool, expired: Bool, committed: Bool) -> Bool:
  Bool.not(live) && (expired || committed)

def blob_reuse(target: Maybe<&2, Artifact>, blob: Nat) -> Bool:
  match target:
    case None{}:
      False{}
    case Some{Artifact{_, _, _, _, deleted, versions}}:
      Bool.not(deleted) && artifact_blob_has(versions, blob)

# Stage 2 grouping never changes journey read access or artifact content.
def project_ready(v: Version) -> Bool:
  version_ge(v, Version{0n, 1n, 6n})

def project_client(+client: Version, minimum: Version, control: Bool, artifact: Bool, project: Bool) -> Bool:
  control && artifact && project && project_ready(client) && version_ge(client, minimum)

type ProjectPhase is Data:
  GettingStarted{}
  Active{}
  LookingForOthers{}
  Archived{}

def phase_eq(a: ProjectPhase, b: ProjectPhase) -> Bool:
  match a:
    case GettingStarted{}:
      match b:
        case GettingStarted{}: True{}
        case _: False{}
    case Active{}:
      match b:
        case Active{}: True{}
        case _: False{}
    case LookingForOthers{}:
      match b:
        case LookingForOthers{}: True{}
        case _: False{}
    case Archived{}:
      match b:
        case Archived{}: True{}
        case _: False{}

type ProjectInfo is Data:
  ProjectInfo{id: Nat, revision: Nat, phase: ProjectPhase}
type Participation is Data:
  Participation{project: Nat, person: Nat, revision: Nat, active: Bool}
type Placement is Data:
  Placement{artifact: Nat, project: Nat, revision: Nat}
type ProjectIndex is Data:
  ProjectIndex{items: +List<ProjectInfo>, pairs: +List<Participation>, placements: +List<Placement>}
type ProjectAction is Data:
  ProjectCreate{id: Nat}
  ProjectPurpose{id: Nat, predecessor: Nat}
  ProjectStateChange{id: Nat, predecessor: Nat, phase: ProjectPhase}
  ProjectJoin{id: Nat, member: Nat, predecessor: Nat}
  ProjectLeave{id: Nat, member: Nat, predecessor: Nat}
  ArtifactProject{id: Nat, project: Nat, author: Nat, writer: Nat, predecessor: Nat}
type ProjectTransition is Data:
  ProjectAccepted{index: ProjectIndex}
  ProjectDenied{}
  ProjectConflict{}

def project_find(xs: +List<ProjectInfo>, +id: Nat) -> Maybe<&2, ProjectInfo>:
  match xs:
    case Nil{}: None{}
    case Con{+h, +t}:
      ProjectInfo{key, _, _} = h
      Bool.pick(Maybe<&2, ProjectInfo>, Nat.is_eq(key, id), Some{h}, project_find(t, id))

def project_put(xs: +List<ProjectInfo>, +value: ProjectInfo) -> +List<ProjectInfo>:
  match xs:
    case Nil{}: value <> Nil{}
    case Con{+h, +t}:
      ProjectInfo{key, _, _} = h
      ProjectInfo{id, _, _} = value
      Bool.pick(+List<ProjectInfo>, Nat.is_eq(key, id), value <> t, h <> project_put(t, value))

def pair_find(xs: +List<Participation>, +project: Nat, +person: Nat) -> Participation:
  match xs:
    case Nil{}: Participation{project, person, 0n, False{}}
    case Con{+h, +t}:
      Participation{key, member, _, _} = h
      Bool.pick(Participation, Nat.is_eq(key, project) && Nat.is_eq(member, person), h, pair_find(t, project, person))

def pair_put(xs: +List<Participation>, +value: Participation) -> +List<Participation>:
  match xs:
    case Nil{}: value <> Nil{}
    case Con{+h, +t}:
      Participation{key, member, _, _} = h
      Participation{project, person, _, _} = value
      Bool.pick(+List<Participation>, Nat.is_eq(key, project) && Nat.is_eq(member, person), value <> t, h <> pair_put(t, value))

def placement_find(xs: +List<Placement>, +id: Nat) -> Placement:
  match xs:
    case Nil{}: Placement{id, 0n, 0n}
    case Con{+h, +t}:
      Placement{key, _, _} = h
      Bool.pick(Placement, Nat.is_eq(key, id), h, placement_find(t, id))

def placement_put(xs: +List<Placement>, +value: Placement) -> +List<Placement>:
  match xs:
    case Nil{}: value <> Nil{}
    case Con{+h, +t}:
      Placement{key, _, _} = h
      Placement{id, _, _} = value
      Bool.pick(+List<Placement>, Nat.is_eq(key, id), value <> t, h <> placement_put(t, value))

def project_exists(target: Maybe<&2, ProjectInfo>) -> Bool:
  match target:
    case None{}: False{}
    case Some{_}: True{}

def pair_active(p: Participation) -> Bool:
  Participation{_, _, _, active} = p
  active

def project_person(target: Maybe<&2, Member>, pairs: +List<Participation>, project: Nat) -> Bool:
  match target:
    case None{}: False{}
    case Some{Member{id, kind, _, _, _, _, live}}:
      match kind:
        case Agent{}: False{}
        case Person{}: live && pair_active(pair_find(pairs, project, id))

def project_follower(target: Maybe<&2, Member>, +members: +List<Member>, pairs: +List<Participation>, +project: Nat) -> Bool:
  match target:
    case None{}: False{}
    case Some{Member{+id, kind, _, _, owner, _, live}}:
      match kind:
        case Person{}: live && pair_active(pair_find(pairs, project, id))
        case Agent{}: live && project_person(find(members, owner), pairs, project)

def project_participant(+members: +List<Member>, pairs: +List<Participation>, +project: Nat, actor: Nat) -> Bool:
  project_follower(find(members, actor), members, pairs, project)

# Called on accepted removal, before a later admission can re-use the identity.
def project_remove(xs: +List<Participation>, +person: Nat, +revision: Nat) -> +List<Participation>:
  match xs:
    case Nil{}: Nil{}
    case Con{Participation{project, +member, old, +active}, t}:
      Participation{project, member, Bool.pick(Nat, active && Nat.is_eq(member, person), revision, old), active && Bool.not(Nat.is_eq(member, person))} <> project_remove(t, person, revision)

def project_guard(valid: Bool, index: ProjectIndex) -> ProjectTransition:
  match valid:
    case False{}: ProjectConflict{}
    case True{}: ProjectAccepted{index}

def project_metadata(target: Maybe<&2, ProjectInfo>, +items: +List<ProjectInfo>, pairs: +List<Participation>, placements: +List<Placement>, predecessor: Nat, +revision: Nat, phase: Maybe<&2, ProjectPhase>) -> ProjectTransition:
  match target:
    case None{}: ProjectConflict{}
    case Some{ProjectInfo{+id, old, +previous}}:
      match phase:
        case None{}:
          project_guard(Nat.is_eq(old, predecessor), ProjectIndex{project_put(items, ProjectInfo{id, revision, previous}), pairs, placements})
        case Some{+next}:
          project_guard(Nat.is_eq(old, predecessor) && Bool.not(phase_eq(previous, next)), ProjectIndex{project_put(items, ProjectInfo{id, revision, next}), pairs, placements})

def project_membership_pair(pair: Participation, +items: +List<ProjectInfo>, +pairs: +List<Participation>, placements: +List<Placement>, +id: Nat, +member: Nat, predecessor: Nat, revision: Nat, +active: Bool) -> ProjectTransition:
  Participation{_, _, old, +before} = pair
  project_guard(project_exists(project_find(items, id)) && Nat.is_eq(old, predecessor) && Bool.pick(Bool, active, Bool.not(before), before), ProjectIndex{items, pair_put(pairs, Participation{id, member, revision, active}), placements})

def project_membership(+items: +List<ProjectInfo>, +pairs: +List<Participation>, placements: +List<Placement>, +id: Nat, +member: Nat, predecessor: Nat, revision: Nat, active: Bool) -> ProjectTransition:
  project_membership_pair(pair_find(pairs, id, member), items, pairs, placements, id, member, predecessor, revision, active)

def project_placement_value(value: Placement, target: Maybe<&2, Artifact>, +items: +List<ProjectInfo>, pairs: +List<Participation>, +placements: +List<Placement>, +id: Nat, +project: Nat, author: Nat, writer: Nat, actor: Nat, predecessor: Nat, revision: Nat) -> ProjectTransition:
  Placement{_, previous, old} = value
  match target:
    case None{}: ProjectConflict{}
    case Some{Artifact{_, creator, _, _, deleted, _}}:
      project_guard(Bool.not(deleted) && Nat.is_eq(author, creator) && Nat.is_eq(writer, actor) && Nat.is_eq(old, predecessor) && Bool.not(Nat.is_eq(previous, project)) && (Nat.is_eq(project, 0n) || project_exists(project_find(items, project))), ProjectIndex{items, pairs, placement_put(placements, Placement{id, project, revision})})

def project_placement(target: Maybe<&2, Artifact>, items: +List<ProjectInfo>, pairs: +List<Participation>, +placements: +List<Placement>, +id: Nat, project: Nat, author: Nat, writer: Nat, actor: Nat, predecessor: Nat, revision: Nat) -> ProjectTransition:
  project_placement_value(placement_find(placements, id), target, items, pairs, placements, id, project, author, writer, actor, predecessor, revision)

def project_self(+members: +List<Member>, +actor: Nat, member: Nat) -> Bool:
  Nat.is_eq(actor, member) && is_person(find(members, actor)) && access_read(member_access(find(members, actor), members))

def project_authority(+members: +List<Member>, +actor: Nat, +pairs: +List<Participation>, pending: Bool, action: ProjectAction) -> Bool:
  match action:
    case ProjectCreate{_}: content_write(member_access(find(members, actor), members), pending)
    case ArtifactProject{_, _, _, _, _}: content_write(member_access(find(members, actor), members), pending)
    case ProjectJoin{_, member, _}: project_self(members, actor, member)
    case ProjectLeave{_, member, _}: project_self(members, actor, member)
    case ProjectPurpose{id, _}: project_participant(members, pairs, id, actor)
    case ProjectStateChange{id, _, _}: project_participant(members, pairs, id, actor)

def project_action(index: ProjectIndex, artifacts: ArtifactIndex, +actor: Nat, +revision: Nat, action: ProjectAction) -> ProjectTransition:
  ProjectIndex{+items, +pairs, +placements} = index
  ArtifactIndex{+content, used} = artifacts
  match action:
    case ProjectCreate{+id}:
      project_guard(Bool.not(project_exists(project_find(items, id)) || nat_has(used, id)), ProjectIndex{ProjectInfo{id, revision, GettingStarted{}} <> items, pairs, placements})
    case ProjectPurpose{+id, predecessor}:
      project_metadata(project_find(items, id), items, pairs, placements, predecessor, revision, None{})
    case ProjectStateChange{+id, predecessor, phase}:
      project_metadata(project_find(items, id), items, pairs, placements, predecessor, revision, Some{phase})
    case ProjectJoin{id, member, predecessor}:
      project_membership(items, pairs, placements, id, member, predecessor, revision, True{})
    case ProjectLeave{id, member, predecessor}:
      project_membership(items, pairs, placements, id, member, predecessor, revision, False{})
    case ArtifactProject{+id, project, author, writer, predecessor}:
      project_placement(artifact_find(content, id), items, pairs, placements, id, project, author, writer, actor, predecessor, revision)

def project_previous(action: ProjectAction, revision: Nat) -> Bool:
  match action:
    case ProjectCreate{_}: True{}
    case ProjectPurpose{_, predecessor}: Nat.is_lt(predecessor, revision)
    case ProjectStateChange{_, predecessor, _}: Nat.is_lt(predecessor, revision)
    case ProjectJoin{_, _, predecessor}: Nat.is_lt(predecessor, revision)
    case ProjectLeave{_, _, predecessor}: Nat.is_lt(predecessor, revision)
    case ArtifactProject{_, _, _, _, predecessor}: Nat.is_lt(predecessor, revision)

def project_authorized(allowed: Bool, index: ProjectIndex, artifacts: ArtifactIndex, actor: Nat, revision: Nat, action: ProjectAction) -> ProjectTransition:
  match allowed:
    case False{}: ProjectDenied{}
    case True{}: project_action(index, artifacts, actor, revision, action)

def project_apply(+members: +List<Member>, +actor: Nat, minimum: Version, pending: Bool, +index: ProjectIndex, artifacts: ArtifactIndex, +revision: Nat, +action: ProjectAction) -> ProjectTransition:
  ProjectIndex{_, pairs, _} = index
  project_authorized(project_ready(minimum) && project_previous(action, revision) && project_authority(members, actor, pairs, pending, action), index, artifacts, actor, revision, action)

# -1 is not a Nat: selectors use 0=main, 1=all, 2+ normalized project id.
def project_selector(items: +List<ProjectInfo>, +selector: Nat) -> Bool:
  Nat.is_eq(selector, 0n) || Nat.is_eq(selector, 1n) || project_exists(project_find(items, selector))

def project_selected_value(value: Placement, target: Maybe<&2, Artifact>, placements: +List<Placement>, +selector: Nat, id: Nat) -> Bool:
  Placement{_, project, _} = value
  match target:
    case None{}: False{}
    case Some{Artifact{_, _, _, _, deleted, _}}:
      Bool.not(deleted) && (Nat.is_eq(selector, 1n) || Nat.is_eq(selector, project))

def project_selected(target: Maybe<&2, Artifact>, +placements: +List<Placement>, selector: Nat, +id: Nat) -> Bool:
  project_selected_value(placement_find(placements, id), target, placements, selector, id)

# Private authority consumes verified admission/key bindings, never account names.
def private_ready(v: Version) -> Bool:
  version_ge(v, Version{0n, 1n, 7n})

def private_client(+version: Version, minimum: Version, control: Bool, artifact: Bool, project: Bool, private: Bool) -> Bool:
  control && artifact && project && private && private_ready(version) && version_ge(version, minimum)

type PrivateCredential is Data:
  PrivatePersonCredential{}
  PrivateAuthenticatedAgent{}
  PrivateLinkCredential{}
  PrivateUnknownCredential{}

def private_credential(kind: MemberKind, value: PrivateCredential) -> Bool:
  match kind:
    case Person{}:
      match value:
        case PrivatePersonCredential{}: True{}
        case _: False{}
    case Agent{}:
      match value:
        case PrivateAuthenticatedAgent{}: True{}
        case _: False{}

def private_related_kind(kind: MemberKind, +id: Nat, key: Nat, actorKind: MemberKind, owner: Nat) -> Bool:
  match kind:
    case Agent{}: Nat.is_eq(id, key)
    case Person{}: Nat.is_eq(id, key) || owned_agent(actorKind, owner, id)

def private_related_actor(kind: MemberKind, id: Nat, live: Bool, actor: Maybe<&2, Member>) -> Bool:
  match actor:
    case None{}: False{}
    case Some{Member{key, actorKind, _, _, owner, _, actorLive}}:
      live && actorLive && private_related_kind(kind, id, key, actorKind, owner)

def private_relation(author: Maybe<&2, Member>, actor: Maybe<&2, Member>) -> Bool:
  match author:
    case None{}: False{}
    case Some{Member{id, kind, _, _, _, _, live}}: private_related_actor(kind, id, live, actor)

def private_audience_value(+members: +List<Member>, +author: Maybe<&2, Member>, +actor: Maybe<&2, Member>, value: PrivateCredential) -> Bool:
  match actor:
    case None{}: False{}
    case Some{Member{_, kind, _, _, _, _, _}}:
      private_credential(kind, value) && private_relation(author, actor) && access_read(member_access(actor, members))

def private_audience(+members: +List<Member>, author: Nat, actor: Nat, value: PrivateCredential) -> Bool:
  private_audience_value(members, find(members, author), find(members, actor), value)

def private_write(+members: +List<Member>, author: Nat, +actor: Nat, value: PrivateCredential, minimum: Version, pending: Bool, current: Bool) -> Bool:
  current && private_ready(minimum) && private_audience(members, author, actor, value) && content_write(member_access(find(members, actor), members), pending)

# Destination visibility deliberately grants no authority.
def private_copy_access(source: Bool, destination: Bool, different: Bool, visibility: Visibility) -> Bool:
  source && destination && different

type PrivateCopy is Data:
  PrivateCopy{id: Nat, artifact: Nat, author: Nat, journey: Nat, head: Nat, record: Nat, seq: Nat, deleted: Bool, versions: +List<ArtifactVersion>, used: +List<Nat>, project: Nat, placement: Nat, typeHash: Nat}
type PrivateAction is Data:
  PrivateCreate{artifact: Nat, author: Nat, writer: Nat, journey: Nat, version: Nat, typeHash: Nat, blobs: +List<Nat>}
  PrivateEdit{artifact: Nat, author: Nat, writer: Nat, version: Nat, typeHash: Nat, predecessor: Nat, blobs: +List<Nat>}
  PrivateComment{artifact: Nat, author: Nat, writer: Nat, comment: Nat, context: Nat}
  PrivateDelete{artifact: Nat, author: Nat, writer: Nat, predecessor: Nat}
  PrivateProject{artifact: Nat, author: Nat, writer: Nat, project: Nat, predecessor: Nat}
type PrivateTransition is Data:
  PrivateAccepted{value: PrivateCopy}
  PrivateConflict{}
  PrivateDenied{}

def private_guard(valid: Bool, value: PrivateCopy) -> PrivateTransition:
  match valid:
    case True{}: PrivateAccepted{value}
    case False{}: PrivateConflict{}

def private_same(artifact: Nat, author: Nat, writer: Nat, id: Nat, creator: Nat, actor: Nat) -> Bool:
  Nat.is_eq(artifact, id) && Nat.is_eq(author, creator) && Nat.is_eq(writer, actor)

def private_action(value: PrivateCopy, +actor: Nat, +record: Nat, next: PrivateAction, projects: +List<ProjectInfo>) -> PrivateTransition:
  PrivateCopy{+id, +artifact, +author, +journey, +head, _, +seq, +deleted, +versions, +used, +project, +placement, +kind} = value
  match next:
    case PrivateCreate{_, _, _, _, _, _, _}: PrivateConflict{}
    case PrivateEdit{target, creator, writer, +version, typeHash, predecessor, +blobs}:
      private_guard(Bool.not(deleted || nat_has(used, version)) && private_same(target, creator, writer, artifact, author, actor) && Nat.is_eq(kind, typeHash) && Nat.is_eq(head, predecessor), PrivateCopy{id, artifact, author, journey, version, record, (seq + 1n : Nat), False{}, ArtifactVersion{version, actor, blobs} <> versions, version <> used, project, placement, kind})
    case PrivateComment{target, creator, writer, +comment, +context}:
      private_guard(Bool.not(deleted || nat_has(used, comment)) && private_same(target, creator, writer, artifact, author, actor) && (Nat.is_eq(context, 0n) || artifact_version_has(versions, context)), PrivateCopy{id, artifact, author, journey, head, record, (seq + 1n : Nat), False{}, versions, comment <> used, project, placement, kind})
    case PrivateDelete{target, creator, writer, predecessor}:
      private_guard(Bool.not(deleted) && private_same(target, creator, writer, artifact, author, actor) && Nat.is_eq(head, predecessor), PrivateCopy{id, artifact, author, journey, head, record, (seq + 1n : Nat), True{}, versions, used, project, placement, kind})
    case PrivateProject{target, creator, writer, +destination, predecessor}:
      private_guard(Bool.not(deleted) && private_same(target, creator, writer, artifact, author, actor) && Nat.is_eq(placement, predecessor) && Bool.not(Nat.is_eq(project, destination)) && (Nat.is_eq(destination, 0n) || project_exists(project_find(projects, destination))), PrivateCopy{id, artifact, author, journey, head, record, (seq + 1n : Nat), False{}, versions, used, destination, record, kind})

def private_first(id: Nat, +actor: Nat, record: Nat, next: PrivateAction) -> PrivateTransition:
  match next:
    case PrivateCreate{artifact, +author, writer, journey, +version, typeHash, blobs}:
      private_guard(Nat.is_eq(author, actor) && Nat.is_eq(writer, actor), PrivateCopy{id, artifact, author, journey, version, record, 0n, False{}, ArtifactVersion{version, actor, blobs} <> Nil{}, version <> Nil{}, 0n, 0n, typeHash})
    case _: PrivateConflict{}

def private_position(value: Maybe<&2, PrivateCopy>, seq: Nat, previous: Nat) -> Bool:
  match value:
    case None{}: Nat.is_eq(seq, 0n) && Nat.is_eq(previous, 0n)
    case Some{PrivateCopy{_, _, _, _, _, head, old, _, _, _, _, _, _}}: Nat.is_eq(seq, (old + 1n : Nat)) && Nat.is_eq(previous, head)

def private_step(value: Maybe<&2, PrivateCopy>, id: Nat, actor: Nat, record: Nat, next: PrivateAction, projects: +List<ProjectInfo>) -> PrivateTransition:
  match value:
    case None{}: private_first(id, actor, record, next)
    case Some{old}: private_action(old, actor, record, next, projects)

def private_checked(allowed: Bool, positioned: Bool, value: Maybe<&2, PrivateCopy>, id: Nat, actor: Nat, record: Nat, next: PrivateAction, projects: +List<ProjectInfo>) -> PrivateTransition:
  match allowed:
    case False{}: PrivateDenied{}
    case True{}:
      match positioned:
        case False{}: PrivateConflict{}
        case True{}: private_step(value, id, actor, record, next, projects)

def private_apply(allowed: Bool, +value: Maybe<&2, PrivateCopy>, id: Nat, actor: Nat, record: Nat, seq: Nat, previous: Nat, next: PrivateAction, projects: +List<ProjectInfo>) -> PrivateTransition:
  private_checked(allowed, private_position(value, seq, previous), value, id, actor, record, next, projects)

# Bundle scopes derive a single recipient; there is no arbitrary grant list.
type PrivateBundleScope is Data:
  PrivateBackup{}
  PrivateHandoff{}
  PrivateReturn{}

def private_bundle_recipient(scope: PrivateBundleScope, kind: MemberKind, same: Bool) -> Bool:
  match scope:
    case PrivateBackup{}: same
    case PrivateReturn{}: same
    case PrivateHandoff{}:
      match kind:
        case Person{}: False{}
        case Agent{}: True{}

def private_origin_version(current: Nat, observed: Nat) -> Bool:
  Nat.is_eq(current, observed)

def private_authority_snapshot(journey: Nat, head: Nat, otherJourney: Nat, otherHead: Nat) -> Bool:
  Nat.is_eq(journey, otherJourney) && Nat.is_eq(head, otherHead)

# A cross-journey copy is a fresh snapshot, not creation by a new author.
def private_copied(source: PrivateCopy, +id: Nat, +actor: Nat, record: Nat, +journey: Nat, +version: Nat, +blobs: +List<Nat>, observed: Nat, fresh: Bool, allowed: Bool) -> PrivateTransition:
  PrivateCopy{sourceId, artifact, +author, sourceJourney, _, head, _, deleted, _, _, _, _, kind} = source
  private_guard(allowed && fresh && Bool.not(Nat.is_eq(sourceId, id)) && Bool.not(deleted || Nat.is_eq(sourceJourney, journey)) && Nat.is_eq(head, observed), PrivateCopy{id, artifact, author, journey, version, record, 0n, False{}, ArtifactVersion{version, actor, blobs} <> Nil{}, version <> Nil{}, 0n, 0n, kind})

def private_selected(value: PrivateCopy, +selector: Nat, allowed: Bool) -> Bool:
  PrivateCopy{_, _, _, _, _, _, _, deleted, _, _, project, _, _} = value
  allowed && Bool.not(deleted) && (Nat.is_eq(selector, 1n) || Nat.is_eq(selector, project))

def private_references(own: Bool, complete: Bool, digest: Bool, staged: Bool) -> Bool:
  own && complete && digest && staged

# Checkpoints are retained independently of replaceable cache bytes.
type PrivateHeaderDecision is Data:
  PrivateUnverifiedFreshness{}
  PrivateVerifiedFreshness{}
  PrivateMergeRequired{}
  PrivateHeaderConflict{}
  PrivateRollback{}

def private_header(+retained: Nat, +incoming: Nat, private_same: Bool, +predecessor: Bool, +paired: Bool) -> PrivateHeaderDecision:
  match retained:
    case 0n:
      Bool.pick(PrivateHeaderDecision, predecessor, Bool.pick(PrivateHeaderDecision, paired, PrivateVerifiedFreshness{}, PrivateUnverifiedFreshness{}), PrivateHeaderConflict{})
    case _:
      Bool.pick(PrivateHeaderDecision, Nat.is_lt(incoming, retained), PrivateRollback{}, Bool.pick(PrivateHeaderDecision, predecessor, Bool.pick(PrivateHeaderDecision, Nat.is_eq(incoming, retained) && Bool.not(private_same), PrivateMergeRequired{}, Bool.pick(PrivateHeaderDecision, paired, PrivateVerifiedFreshness{}, PrivateUnverifiedFreshness{})), PrivateHeaderConflict{}))

type PrivateMergeChoice is Data:
  PrivateLeft{}
  PrivateRight{}
  PrivateBoth{}
  PrivateTombstone{}

def private_merge(+left: Nat, +right: Nat, leftDeleted: Bool, rightDeleted: Bool, private_same: Bool) -> PrivateMergeChoice:
  Bool.pick(PrivateMergeChoice, leftDeleted || rightDeleted, PrivateTombstone{}, Bool.pick(PrivateMergeChoice, Nat.is_lt(left, right), PrivateRight{}, Bool.pick(PrivateMergeChoice, Nat.is_lt(right, left) || private_same, PrivateLeft{}, PrivateBoth{})))

def private_capacity(bytes: U32) -> Bool:
  Bool.not(U32.is_lt(67108864, bytes))

def private_sync_due(open: Bool, elapsed: Nat) -> Bool:
  open || Bool.not(Nat.is_lt(elapsed, 300000n))

# Candidate order is sampled outside Bend. Invalid/duplicate slots never count.
def private_slot_take(xs: +List<Nat>, fuel: Nat, +selected: +List<Nat>) -> +List<Nat>:
  match xs:
    case Nil{}: selected
    case Con{+slot, rest}:
      match fuel:
        case 0n: selected
        case 1n+ +n:
          private_slot_take(rest, Bool.pick(Nat, Nat.is_lt(slot, 64n) && Bool.not(nat_has(selected, slot)), n, (1n+n : Nat)), Bool.pick(+List<Nat>, Nat.is_lt(slot, 64n) && Bool.not(nat_has(selected, slot)), slot <> selected, selected))

def private_slots(dirty: +List<Nat>, randomOrder: +List<Nat>) -> +List<Nat>:
  private_slot_take(List.append(&2, Nat, dirty, randomOrder), 2n, Nil{})
