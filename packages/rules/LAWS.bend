import Base
import ./rules.bend as R

# D34: no role widening. These laws apply to the production access function.
law agent_never_exceeds_member:
  for setting: R.Role
  {R.can_write(R.agent_access(R.ReadOnly{}, setting)) == False{} : Bool}

law agent_limit_survives_promotion:
  for member: R.Role
  {R.can_write(R.agent_access(member, R.ReadOnly{})) == False{} : Bool}

law agents_never_guides:
  for guide: Bool
  {R.person_guide(R.Agent{}, guide) == False{} : Bool}

# Authority is a person-guide test, independent of the content role.
law only_guides_manage:
  for +xs: +List<R.Member>
  for +actor: Nat
  for e: {R.is_guide(R.find(xs, actor)) == False{} : Bool}
  {R.apply(xs, R.Settings{actor}) == R.Denied{} : R.Transition}

# Every removal, leave and guide change passes this production guard. A
# proposed state with no person guide cannot be accepted, whatever the actor.
law last_person_guide_survives:
  for +allowed: Bool
  for +xs: +List<R.Member>
  for e: {R.has_guide(xs) == False{} : Bool}
  {R.guard(allowed, xs) == Bool.pick(R.Transition, allowed, R.LastGuide{}, R.Denied{}) : R.Transition}

# Symbolic recipients at the new epoch: the removed person and their agents
# have no new key. This does not recall old keys or prove encryption.
law removed_person_has_no_new_key:
  for +id: Nat
  for kind: R.MemberKind
  for role: R.Role
  for guide: Bool
  for owner: Nat
  for support: Bool
  for live: Bool
  {R.new_epoch_key(id, True{}, R.Member{id, kind, role, guide, owner, support, live}) == False{} : Bool}

law removed_person_agents_have_no_new_key:
  for target: Nat
  for +owner: Nat
  for role: R.Role
  for guide: Bool
  for support: Bool
  for live: Bool
  {R.new_epoch_key(owner, True{}, R.Member{target, R.Agent{}, role, guide, owner, support, live}) == False{} : Bool}

# Person removal uses exactly the same recipient predicate as rotation, for
# every member and arbitrary tail, not a fixed sample population.
law person_removal_cascades:
  for +target: Nat
  for +member: R.Member
  for tail: +List<R.Member>
  {R.remove(member <> tail, target, True{}) == Bool.pick(+List<R.Member>, R.new_epoch_key(target, True{}, member), member <> R.remove(tail, target, True{}), R.remove(tail, target, True{})) : +List<R.Member>}

law verified_replay_step:
  for xs: +List<R.Member>
  for control: R.Control
  {R.replay(control <> Nil{}, R.Accepted{xs}) == R.apply(xs, control) : R.Transition}

law replay_stops_at_denial:
  for controls: +List<R.Control>
  {R.replay(controls, R.Denied{}) == R.Denied{} : R.Transition}

law only_guides_change_roles:
  for +xs: +List<R.Member>
  for +actor: Nat
  for +target: Nat
  for +role: R.Role
  for e: {R.is_guide(R.find(xs, actor)) == False{} : Bool}
  {R.apply(xs, R.RoleChange{actor, target, role}) == R.Denied{} : R.Transition}

law last_guide_removal_or_leave:
  for +xs: +List<R.Member>
  for +actor: Nat
  for +target: Nat
  for e: {R.has_guide(R.remove(xs, target, R.is_person(R.find(xs, target)))) == False{} : Bool}
  {R.apply(xs, R.Remove{actor, target}) == Bool.pick(R.Transition, R.can_remove(xs, actor, target), R.LastGuide{}, R.Denied{}) : R.Transition}

law last_guide_demotion:
  for +xs: +List<R.Member>
  for +actor: Nat
  for +target: Nat
  for +guide: Bool
  for e: {R.has_guide(R.set_guide(xs, target, guide)) == False{} : Bool}
  {R.apply(xs, R.Guide{actor, target, guide}) == Bool.pick(R.Transition, R.is_guide(R.find(xs, actor)) && R.guide_target(R.find(xs, target)), R.LastGuide{}, R.Denied{}) : R.Transition}

law removed_candidate_has_no_next_holding:
  for +target: Nat
  for +member: R.Member
  for +epoch: Nat
  for e: {R.new_epoch_key(target, True{}, member) == False{} : Bool}
  {R.next_holding(target, True{}, member, epoch) == None{} : Maybe<&2, R.Holding>}

law rotation_uses_removed_population:
  for xs: +List<R.Member>
  for target: Nat
  for epoch: Nat
  {R.remove_and_rotate(xs, target, True{}, epoch) == R.rotation_holdings(R.remove(xs, target, True{}), epoch) : +List<R.Holding>}

# Induction over any population: no removed person or owned agent remains in
# the population that receives the next epoch (not only the first list item).
law removed_population_contains_only_survivors:
  for +xs: +List<R.Member>
  for +target: Nat
  for +person: Bool
  {R.all_survive(target, person, R.remove(xs, target, person)) == True{} : Bool}

law support_admission_stays_readonly:
  for role: R.Role
  {R.admission_role(True{}, role) == R.ReadOnly{} : R.Role}

law normal_admission_uses_default:
  for role: R.Role
  {R.admission_role(False{}, role) == role : R.Role}

law legacy_settings_are_private_invitation_only:
  for name: String
  for description: String
  {R.active_settings(R.legacy_settings(name, description)) == True{} : Bool}

law public_settings_are_inactive:
  for name: String
  for description: String
  for role: R.Role
  for joining: R.Joining
  {R.active_settings(R.JourneySettings{name, description, role, R.Public{}, joining}) == False{} : Bool}

law guide_approved_is_not_activated:
  for name: String
  for description: String
  for role: R.Role
  {R.active_settings(R.JourneySettings{name, description, role, R.Private{}, R.GuideApproved{}}) == False{} : Bool}

law immediate_is_not_activated:
  for name: String
  for description: String
  for role: R.Role
  {R.active_settings(R.JourneySettings{name, description, role, R.Private{}, R.Immediate{}}) == False{} : Bool}

law incompatible_controls_need_barrier:
  for +xs: +List<R.Member>
  for +settings: R.JourneySettings
  for +minimum: R.Version
  for +pending: Bool
  for control: R.Control
  for e: {R.stage_ready(minimum) == False{} : Bool}
  {R.journey_apply(R.JourneyState{xs, settings, minimum, pending}, R.NewControl{control}) == R.UpgradeRequired{} : R.JourneyTransition}

law minimum_cannot_decrease:
  for +xs: +List<R.Member>
  for +actor: Nat
  for +settings: R.JourneySettings
  for +old: R.Version
  for +next: R.Version
  for +pending: Bool
  for e: {R.version_ge(next, old) == False{} : Bool}
  {R.minimum_change(xs, actor, settings, old, next, pending) == R.JourneyDenied{} : R.JourneyTransition}

law pending_rotation_blocks_content:
  for access: Maybe<&2, R.Role>
  {R.content_write(access, True{}) == False{} : Bool}

law journey_replay_is_production_transition:
  for state: R.JourneyState
  for control: R.JourneyControl
  {R.journey_replay(control <> Nil{}, R.JourneyAccepted{state}) == R.journey_apply(state, control) : R.JourneyTransition}

law settings_require_guide:
  for +xs: +List<R.Member>
  for +actor: Nat
  for +settings: R.JourneySettings
  for +minimum: R.Version
  for +pending: Bool
  for e: {R.is_guide(R.find(xs, actor)) == False{} : Bool}
  {R.configure(xs, actor, settings, minimum, pending) == R.JourneyDenied{} : R.JourneyTransition}

law server_requires_current_read_access:
  for access: Maybe<&2, R.Role>
  for identity: Bool
  for version: Bool
  for e: {R.access_read(access) == False{} : Bool}
  {R.server_read(access, identity, version) == False{} : Bool}

law server_pending_blocks_content:
  for access: Maybe<&2, R.Role>
  for identity: Bool
  for version: Bool
  {R.server_content(access, identity, version, True{}) == False{} : Bool}

law server_old_client_refused:
  for +client: R.Version
  for minimum: R.Version
  for format: Bool
  for e: {R.stage_ready(client) == False{} : Bool}
  {R.server_version(client, minimum, format) == False{} : Bool}

law server_missing_format_refused:
  for client: R.Version
  for minimum: R.Version
  {R.server_version(client, minimum, False{}) == False{} : Bool}

# A signed support admission cannot widen its read-only limit.
law server_support_scope_matches:
  for scope: Maybe<&2, R.Role>
  for admitted: Maybe<&2, R.Role>
  for owner: Nat
  for actor: Nat
  {R.server_admission(R.Person{}, scope, admitted, owner, actor, True{}) == R.admission_scope(scope, Some{R.ReadOnly{}}) : Bool}

# An agent cannot be admitted under another adding person or a different limit.
law server_agent_admission_requires_owner:
  for scope: Maybe<&2, R.Role>
  for admitted: Maybe<&2, R.Role>
  for +owner: Nat
  for +actor: Nat
  for support: Bool
  for e: {Nat.is_eq(owner, actor) == False{} : Bool}
  {R.server_admission(R.Agent{}, scope, admitted, owner, actor, support) == False{} : Bool}

law server_agent_admission_requires_scope:
  for +scope: Maybe<&2, R.Role>
  for +admitted: Maybe<&2, R.Role>
  for owner: Nat
  for actor: Nat
  for support: Bool
  for e: {R.admission_scope(scope, admitted) == False{} : Bool}
  {R.server_admission(R.Agent{}, scope, admitted, owner, actor, support) == False{} : Bool}

# Stage 1: content access is current inherited access, never guide authority.
law artifacts_require_current_write:
  for +members: +List<R.Member>
  for +actor: Nat
  for +minimum: R.Version
  for +pending: Bool
  for index: R.ArtifactIndex
  for action: R.ArtifactAction
  for e: {R.content_write(R.member_access(R.find(members, actor), members), pending) == False{} : Bool}
  {R.artifact_apply(members, actor, minimum, pending, index, action) == R.ArtifactDenied{} : R.ArtifactTransition}

law artifact_pending_denies:
  for +members: +List<R.Member>
  for +actor: Nat
  for minimum: R.Version
  for index: R.ArtifactIndex
  for action: R.ArtifactAction
  {R.artifact_apply(members, actor, minimum, True{}, index, action) == R.ArtifactDenied{} : R.ArtifactTransition}

# This exact production output states immutable creator/type, actual signer and
# retention of ALL earlier version references (even attachments no longer at head).
law artifact_edit_preserves_creator_actor_and_history:
  for +xs: +List<R.Artifact>
  for +used: +List<Nat>
  for +actor: Nat
  for +id: Nat
  for +version: Nat
  for +creator: Nat
  for +kind: Nat
  for +head: Nat
  for +deleted: Bool
  for +versions: +List<R.ArtifactVersion>
  for +author: Nat
  for +writer: Nat
  for +typeHash: Nat
  for +predecessor: Nat
  for +blobs: +List<Nat>
  {R.artifact_edit(Some{R.Artifact{id, creator, kind, head, deleted, versions}}, xs, used, actor, id, version, predecessor, author, writer, typeHash, blobs) == R.artifact_guard(Bool.not(deleted || R.nat_has(used, version)) && Nat.is_eq(predecessor, head) && Nat.is_eq(author, creator) && Nat.is_eq(writer, actor) && Nat.is_eq(typeHash, kind) && R.artifact_references(blobs, xs, id), R.ArtifactIndex{R.artifact_put(xs, R.Artifact{id, creator, kind, version, False{}, R.ArtifactVersion{version, actor, blobs} <> versions}), version <> used}) : R.ArtifactTransition}

law artifact_create_pins_real_creator:
  for +xs: +List<R.Artifact>
  for +used: +List<Nat>
  for +actor: Nat
  for +id: Nat
  for +version: Nat
  for +author: Nat
  for +writer: Nat
  for +kind: Nat
  for +blobs: +List<Nat>
  {R.artifact_create(xs, used, actor, id, version, author, writer, kind, blobs) == R.artifact_guard(Bool.not(R.nat_has(used, id) || R.nat_has(used, version) || Nat.is_eq(id, version)) && Nat.is_eq(author, actor) && Nat.is_eq(writer, actor) && R.artifact_references(blobs, xs, id), R.ArtifactIndex{R.Artifact{id, actor, kind, version, False{}, R.ArtifactVersion{version, actor, blobs} <> Nil{}} <> xs, id <> version <> used}) : R.ArtifactTransition}

law artifact_deleted_never_resurrects:
  for +xs: +List<R.Artifact>
  for +used: +List<Nat>
  for +actor: Nat
  for +id: Nat
  for +version: Nat
  for +creator: Nat
  for +kind: Nat
  for +head: Nat
  for +versions: +List<R.ArtifactVersion>
  for predecessor: Nat
  for author: Nat
  for writer: Nat
  for typeHash: Nat
  for blobs: +List<Nat>
  {R.artifact_edit(Some{R.Artifact{id, creator, kind, head, True{}, versions}}, xs, used, actor, id, version, predecessor, author, writer, typeHash, blobs) == R.ArtifactConflict{} : R.ArtifactTransition}

law artifact_stale_predecessor_conflicts:
  for +xs: +List<R.Artifact>
  for +used: +List<Nat>
  for +actor: Nat
  for +id: Nat
  for +version: Nat
  for +creator: Nat
  for +kind: Nat
  for +head: Nat
  for +deleted: Bool
  for +versions: +List<R.ArtifactVersion>
  for +predecessor: Nat
  for +author: Nat
  for +writer: Nat
  for +typeHash: Nat
  for +blobs: +List<Nat>
  for e: {Nat.is_eq(predecessor, head) == False{} : Bool}
  {R.artifact_edit(Some{R.Artifact{id, creator, kind, head, deleted, versions}}, xs, used, actor, id, version, predecessor, author, writer, typeHash, blobs) == R.ArtifactConflict{} : R.ArtifactTransition}

law artifact_cross_reference_denied:
  for +xs: +List<R.Artifact>
  for +id: Nat
  for +blob: Nat
  for tail: +List<Nat>
  for e: {R.artifact_other_blob(xs, id, blob) == True{} : Bool}
  {R.artifact_references(blob <> tail, xs, id) == False{} : Bool}

law artifact_invalid_reference_conflicts:
  for +index: R.ArtifactIndex
  {R.artifact_guard(False{}, index) == R.ArtifactConflict{} : R.ArtifactTransition}

law artifact_comment_references_same_artifact:
  for +xs: +List<R.Artifact>
  for +used: +List<Nat>
  for +actor: Nat
  for +comment: Nat
  for +context: Nat
  for +creator: Nat
  for +author: Nat
  for +writer: Nat
  for +deleted: Bool
  for +versions: +List<R.ArtifactVersion>
  for id: Nat
  for kind: Nat
  for head: Nat
  {R.artifact_comment(Some{R.Artifact{id, creator, kind, head, deleted, versions}}, xs, used, actor, comment, context, author, writer) == R.artifact_guard(Bool.not(deleted || R.nat_has(used, comment)) && Nat.is_eq(author, creator) && Nat.is_eq(writer, actor) && (Nat.is_eq(context, 0n) || R.artifact_version_has(versions, context)), R.ArtifactIndex{xs, comment <> used}) : R.ArtifactTransition}

law artifact_deleted_references_not_live:
  for id: Nat
  for author: Nat
  for kind: Nat
  for head: Nat
  for versions: +List<R.ArtifactVersion>
  for +tail: +List<R.Artifact>
  for +blob: Nat
  {R.artifact_live_blob(R.Artifact{id, author, kind, head, True{}, versions} <> tail, blob) == R.artifact_live_blob(tail, blob) : Bool}

law artifact_legacy_client_denied:
  for client: R.Version
  for minimum: R.Version
  for control: Bool
  {R.artifact_client(client, minimum, control, False{}) == False{} : Bool}

# Real storage gates: no authority, unfinished upload or live-reference deletion.
law blob_stage_pending_denied:
  for access: Maybe<&2, R.Role>
  for identity: Bool
  for version: Bool
  for epoch: Nat
  for current: Nat
  {R.blob_stage(access, identity, version, True{}, epoch, current) == False{} : Bool}

law blob_upload_requires_live_stage:
  for allowed: Bool
  for exists: Bool
  for owner: Nat
  for actor: Nat
  for available: Bool
  {R.blob_upload(allowed, exists, owner, actor, False{}, available) == False{} : Bool}

law blob_reference_requires_completion:
  for exists: Bool
  for matches: Bool
  for committed: Bool
  for owner: Nat
  for actor: Nat
  for unexpired: Bool
  for epoch: Nat
  for current: Nat
  for sameArtifact: Bool
  {R.blob_reference(exists, matches, False{}, committed, owner, actor, unexpired, epoch, current, sameArtifact) == False{} : Bool}

law blob_reference_requires_uploader_or_same_artifact:
  for exists: Bool
  for matches: Bool
  for complete: Bool
  for +committed: Bool
  for +owner: Nat
  for +actor: Nat
  for +unexpired: Bool
  for +epoch: Nat
  for +current: Nat
  for +sameArtifact: Bool
  {R.blob_reference(exists, matches, complete, committed, owner, actor, unexpired, epoch, current, sameArtifact) == (exists && matches && complete && Bool.pick(Bool, committed, sameArtifact, Nat.is_eq(owner, actor) && unexpired && Nat.is_eq(epoch, current))) : Bool}

law blob_unreferenced_not_readable:
  for allowed: Bool
  for complete: Bool
  {R.blob_read(allowed, False{}, complete) == False{} : Bool}

law blob_live_never_collected:
  for expired: Bool
  for committed: Bool
  {R.blob_collect(True{}, expired, committed) == False{} : Bool}

law blob_deleted_not_reusable:
  for id: Nat
  for author: Nat
  for kind: Nat
  for head: Nat
  for versions: +List<R.ArtifactVersion>
  for blob: Nat
  {R.blob_reuse(Some{R.Artifact{id, author, kind, head, True{}, versions}}, blob) == False{} : Bool}

# Stage 2: the production entry points and their metadata/content split.
law project_self_only:
  for +members: +List<R.Member>
  for +actor: Nat
  for +member: Nat
  {R.project_self(members, actor, member) == (Nat.is_eq(actor, member) && R.is_person(R.find(members, actor)) && R.access_read(R.member_access(R.find(members, actor), members))) : Bool}

law project_agents_follow_live_people:
  for +members: +List<R.Member>
  for +pairs: +List<R.Participation>
  for +project: Nat
  for id: Nat
  for role: R.Role
  for guide: Bool
  for +owner: Nat
  for support: Bool
  for +live: Bool
  {R.project_follower(Some{R.Member{id, R.Agent{}, role, guide, owner, support, live}}, members, pairs, project) == (live && R.project_person(R.find(members, owner), pairs, project)) : Bool}

law project_agent_cannot_be_person_participant:
  for id: Nat
  for role: R.Role
  for guide: Bool
  for owner: Nat
  for support: Bool
  for live: Bool
  for pairs: +List<R.Participation>
  for project: Nat
  {R.project_person(Some{R.Member{id, R.Agent{}, role, guide, owner, support, live}}, pairs, project) == False{} : Bool}

law project_removed_pair_does_not_resurrect:
  {R.project_remove(R.Participation{2n, 3n, 4n, True{}} <> Nil{}, 3n, 5n) == R.Participation{2n, 3n, 5n, False{}} <> Nil{} : +List<R.Participation>}

law project_readonly_metadata_not_content:
  {R.project_participant(R.Member{3n, R.Person{}, R.ReadOnly{}, True{}, 0n, False{}, True{}} <> Nil{}, R.Participation{2n, 3n, 4n, True{}} <> Nil{}, 2n, 3n) == True{} : Bool}

law project_readonly_creation_denied:
  {R.project_authority(R.Member{3n, R.Person{}, R.ReadOnly{}, True{}, 0n, False{}, True{}} <> Nil{}, 3n, Nil{}, False{}, R.ProjectCreate{2n}) == False{} : Bool}

law project_readonly_placement_denied:
  {R.project_authority(R.Member{3n, R.Person{}, R.ReadOnly{}, True{}, 0n, False{}, True{}} <> Nil{}, 3n, Nil{}, False{}, R.ArtifactProject{4n, 2n, 3n, 3n, 0n}) == False{} : Bool}

law project_content_still_blocked_by_rotation:
  for +members: +List<R.Member>
  for +actor: Nat
  for pairs: +List<R.Participation>
  for id: Nat
  {R.project_authority(members, actor, pairs, True{}, R.ProjectCreate{id}) == False{} : Bool}

law project_initial_state_and_no_auto_join:
  {R.project_action(R.ProjectIndex{Nil{}, Nil{}, Nil{}}, R.ArtifactIndex{Nil{}, Nil{}}, 3n, 4n, R.ProjectCreate{2n}) == R.ProjectAccepted{R.ProjectIndex{R.ProjectInfo{2n, 4n, R.GettingStarted{}} <> Nil{}, Nil{}, Nil{}}} : R.ProjectTransition}

law project_state_allows_archive:
  {R.project_metadata(Some{R.ProjectInfo{2n, 4n, R.Active{}}}, R.ProjectInfo{2n, 4n, R.Active{}} <> Nil{}, Nil{}, Nil{}, 4n, 5n, Some{R.Archived{}}) == R.ProjectAccepted{R.ProjectIndex{R.ProjectInfo{2n, 5n, R.Archived{}} <> Nil{}, Nil{}, Nil{}}} : R.ProjectTransition}

law project_archive_reopens:
  {R.project_metadata(Some{R.ProjectInfo{2n, 4n, R.Archived{}}}, R.ProjectInfo{2n, 4n, R.Archived{}} <> Nil{}, Nil{}, Nil{}, 4n, 5n, Some{R.LookingForOthers{}}) == R.ProjectAccepted{R.ProjectIndex{R.ProjectInfo{2n, 5n, R.LookingForOthers{}} <> Nil{}, Nil{}, Nil{}}} : R.ProjectTransition}

law project_archive_remains_selectable:
  {R.project_selector(R.ProjectInfo{2n, 4n, R.Archived{}} <> Nil{}, 2n) == True{} : Bool}

law project_stale_metadata_conflicts:
  {R.project_metadata(Some{R.ProjectInfo{2n, 4n, R.Active{}}}, Nil{}, Nil{}, Nil{}, 3n, 5n, None{}) == R.ProjectConflict{} : R.ProjectTransition}

law project_repeated_participation_conflicts:
  {R.project_membership(R.ProjectInfo{2n, 4n, R.Active{}} <> Nil{}, R.Participation{2n, 3n, 5n, True{}} <> Nil{}, Nil{}, 2n, 3n, 5n, 6n, True{}) == R.ProjectConflict{} : R.ProjectTransition}

law project_placement_preserves_artifact_identity:
  for +items: +List<R.ProjectInfo>
  for +pairs: +List<R.Participation>
  for +placements: +List<R.Placement>
  for +id: Nat
  for +project: Nat
  for +author: Nat
  for +writer: Nat
  for +actor: Nat
  for +predecessor: Nat
  for +revision: Nat
  for +previous: Nat
  for +old: Nat
  for +creator: Nat
  for +deleted: Bool
  for kind: Nat
  for head: Nat
  for versions: +List<R.ArtifactVersion>
  {R.project_placement_value(R.Placement{id, previous, old}, Some{R.Artifact{id, creator, kind, head, deleted, versions}}, items, pairs, placements, id, project, author, writer, actor, predecessor, revision) == R.project_guard(Bool.not(deleted) && Nat.is_eq(author, creator) && Nat.is_eq(writer, actor) && Nat.is_eq(old, predecessor) && Bool.not(Nat.is_eq(previous, project)) && (Nat.is_eq(project, 0n) || R.project_exists(R.project_find(items, project))), R.ProjectIndex{items, pairs, R.placement_put(placements, R.Placement{id, project, revision})}) : R.ProjectTransition}

law project_deleted_placement_conflicts:
  for +items: +List<R.ProjectInfo>
  for pairs: +List<R.Participation>
  for +placements: +List<R.Placement>
  for +id: Nat
  for +project: Nat
  for author: Nat
  for writer: Nat
  for actor: Nat
  for predecessor: Nat
  for revision: Nat
  for creator: Nat
  for kind: Nat
  for head: Nat
  for versions: +List<R.ArtifactVersion>
  {R.project_placement(Some{R.Artifact{id, creator, kind, head, True{}, versions}}, items, pairs, placements, id, project, author, writer, actor, predecessor, revision) == R.ProjectConflict{} : R.ProjectTransition}

law project_lists_do_not_elevate_read_scope:
  for +placements: +List<R.Placement>
  for selector: Nat
  for +id: Nat
  {R.project_selected(None{}, placements, selector, id) == False{} : Bool}

law project_client_requires_capability:
  for client: R.Version
  for minimum: R.Version
  for control: Bool
  for artifact: Bool
  {R.project_client(client, minimum, control, artifact, False{}) == False{} : Bool}

law project_replay_uses_authority_version_and_revision:
  for +members: +List<R.Member>
  for +actor: Nat
  for +minimum: R.Version
  for +pending: Bool
  for +index: R.ProjectIndex
  for +artifacts: R.ArtifactIndex
  for +revision: Nat
  for +action: R.ProjectAction
  for +pairs: +List<R.Participation>
  for items: +List<R.ProjectInfo>
  for placements: +List<R.Placement>
  {R.project_apply(members, actor, minimum, pending, R.ProjectIndex{items, pairs, placements}, artifacts, revision, action) == R.project_authorized(R.project_ready(minimum) && R.project_previous(action, revision) && R.project_authority(members, actor, pairs, pending, action), R.ProjectIndex{items, pairs, placements}, artifacts, actor, revision, action) : R.ProjectTransition}
