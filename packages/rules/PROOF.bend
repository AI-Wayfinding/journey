import Base
import ./rules.bend as R
import ./LAWS.bend as Laws

def Laws.agent_never_exceeds_member(setting):
  {==}

def Laws.agent_limit_survives_promotion(member):
  match member:
    case R.ReadOnly{}:
      {==}
    case R.ReadWrite{}:
      {==}

def Laws.agents_never_guides(guide):
  {==}

def Laws.only_guides_manage(xs, actor, e):
  Equal.cong(Bool, R.Transition, b => R.guard(b, xs), R.is_guide(R.find(xs, actor)), False{}, e)

def Laws.last_person_guide_survives(allowed, xs, e):
  match allowed:
    case False{}:
      {==}
    case True{}:
      Equal.cong(Bool, R.Transition, b => R.guarded_members(b, xs), R.has_guide(xs), False{}, e)

def eq_refl(+n: Nat) -> {Nat.is_eq(n, n) == True{} : Bool}:
  match n:
    case 0n:
      {==}
    case 1n+p:
      eq_refl(p)

def Laws.removed_person_has_no_new_key(id, kind, role, guide, owner, support, live):
  Equal.cong(Bool, Bool, b => Bool.not(b || R.owned_agent(kind, owner, id)), Nat.is_eq(id, id), True{}, eq_refl(id))

def or_true(b: Bool) -> {Bool.not(b || True{}) == False{} : Bool}:
  match b:
    case False{}:
      {==}
    case True{}:
      {==}

def Laws.removed_person_agents_have_no_new_key(target, owner, role, guide, support, live):
  Equal.trans(Bool, Bool.not(Nat.is_eq(target, owner) || Nat.is_eq(owner, owner)), Bool.not(Nat.is_eq(target, owner) || True{}), False{}, Equal.cong(Bool, Bool, b => Bool.not(Nat.is_eq(target, owner) || b), Nat.is_eq(owner, owner), True{}, eq_refl(owner)), or_true(Nat.is_eq(target, owner)))

def Laws.person_removal_cascades(target, member, tail):
  {==}

def Laws.verified_replay_step(xs, control):
  {==}

def Laws.replay_stops_at_denial(controls):
  match controls:
    case Nil{}:
      {==}
    case Con{_, t}:
      Laws.replay_stops_at_denial(t)

def Laws.only_guides_change_roles(xs, actor, target, role, e):
  Equal.cong(Bool, R.Transition, b => R.guard(b && R.guide_target(R.find(xs, target)), R.set_role(xs, target, role)), R.is_guide(R.find(xs, actor)), False{}, e)

def Laws.last_guide_removal_or_leave(xs, actor, target, e):
  Laws.last_person_guide_survives(R.can_remove(xs, actor, target), R.remove(xs, target, R.is_person(R.find(xs, target))), e)

def Laws.last_guide_demotion(xs, actor, target, guide, e):
  Laws.last_person_guide_survives(R.is_guide(R.find(xs, actor)) && R.guide_target(R.find(xs, target)), R.set_guide(xs, target, guide), e)

def Laws.removed_candidate_has_no_next_holding(target, member, epoch, e):
  R.Member{+id, kind, role, guide, owner, support, live} = member
  Equal.cong(Bool, Maybe<&2, R.Holding>, b => Bool.pick(Maybe<&2, R.Holding>, b, Some{R.Holding{id, epoch}}, None{}), R.new_epoch_key(target, True{}, R.Member{id, kind, role, guide, owner, support, live}), False{}, e)

def Laws.rotation_uses_removed_population(xs, target, epoch):
  {==}

def kept_population(+target: Nat, +person: Bool, +h: R.Member, +rest: +List<R.Member>, b: Bool, e: {R.survives(target, person, h) == b : Bool}, ih: {R.all_survive(target, person, rest) == True{} : Bool}) -> {R.all_survive(target, person, Bool.pick(+List<R.Member>, b, h <> rest, rest)) == True{} : Bool}:
  match b:
    case False{}:
      ih
    case True{}:
      Equal.trans(Bool, R.survives(target, person, h) && R.all_survive(target, person, rest), R.survives(target, person, h) && True{}, True{}, Equal.cong(Bool, Bool, b => R.survives(target, person, h) && b, R.all_survive(target, person, rest), True{}, ih), Equal.cong(Bool, Bool, b => b && True{}, R.survives(target, person, h), True{}, e))

def Laws.removed_population_contains_only_survivors(xs, target, person):
  match xs:
    case Nil{}:
      {==}
    case Con{+h, +t}:
      kept_population(target, person, h, R.remove(t, target, person), R.survives(target, person, h), {==}, Laws.removed_population_contains_only_survivors(t, target, person))

def Laws.support_admission_stays_readonly(role):
  {==}

def Laws.normal_admission_uses_default(role):
  {==}

def Laws.legacy_settings_are_private_invitation_only(name, description):
  {==}

def Laws.public_settings_are_inactive(name, description, role, joining):
  {==}

def Laws.guide_approved_is_not_activated(name, description, role):
  {==}

def Laws.immediate_is_not_activated(name, description, role):
  {==}

def Laws.incompatible_controls_need_barrier(xs, settings, minimum, pending, control, e):
  Equal.cong(Bool, R.JourneyTransition, b => R.upgrade_control(b, xs, settings, minimum, pending, control), R.stage_ready(minimum), False{}, e)

def and_false(b: Bool) -> {b && False{} == False{} : Bool}:
  match b:
    case False{}:
      {==}
    case True{}:
      {==}

def Laws.minimum_cannot_decrease(xs, actor, settings, old, next, pending, e):
  Equal.cong(Bool, R.JourneyTransition, b => R.journey_guard(b, R.JourneyState{xs, settings, next, pending}), R.is_guide(R.find(xs, actor)) && R.version_ge(next, old), False{}, Equal.trans(Bool, R.is_guide(R.find(xs, actor)) && R.version_ge(next, old), R.is_guide(R.find(xs, actor)) && False{}, False{}, Equal.cong(Bool, Bool, b => R.is_guide(R.find(xs, actor)) && b, R.version_ge(next, old), False{}, e), and_false(R.is_guide(R.find(xs, actor)))))

def Laws.pending_rotation_blocks_content(access):
  and_false(R.access_write(access))

def Laws.journey_replay_is_production_transition(state, control):
  {==}

def Laws.settings_require_guide(xs, actor, settings, minimum, pending, e):
  Equal.trans(R.JourneyTransition, R.configure(xs, actor, settings, minimum, pending), R.journey_guard((R.stage_ready(minimum) && False{}) && R.active_settings(settings), R.JourneyState{xs, settings, minimum, pending}), R.JourneyDenied{}, Equal.cong(Bool, R.JourneyTransition, b => R.journey_guard((R.stage_ready(minimum) && b) && R.active_settings(settings), R.JourneyState{xs, settings, minimum, pending}), R.is_guide(R.find(xs, actor)), False{}, e), Equal.cong(Bool, R.JourneyTransition, b => R.journey_guard(b && R.active_settings(settings), R.JourneyState{xs, settings, minimum, pending}), R.stage_ready(minimum) && False{}, False{}, and_false(R.stage_ready(minimum))))

def Laws.server_requires_current_read_access(access, identity, version, e):
  Equal.cong(Bool, Bool, b => b && identity && version, R.access_read(access), False{}, e)

def Laws.server_pending_blocks_content(access, identity, version):
  Equal.cong(Bool, Bool, b => b && identity && version, R.content_write(access, True{}), False{}, Laws.pending_rotation_blocks_content(access))

def Laws.server_old_client_refused(client, minimum, format, e):
  match format:
    case False{}:
      {==}
    case True{}:
      Equal.cong(Bool, Bool, b => b && R.version_ge(client, minimum), R.stage_ready(client), False{}, e)

def Laws.server_missing_format_refused(client, minimum):
  {==}

def Laws.server_support_scope_matches(scope, admitted, owner, actor):
  {==}

def Laws.server_agent_admission_requires_owner(scope, admitted, owner, actor, support, e):
  Equal.cong(Bool, Bool, b => b && R.admission_scope(scope, admitted), Nat.is_eq(owner, actor), False{}, e)

def Laws.server_agent_admission_requires_scope(scope, admitted, owner, actor, support, e):
  Equal.trans(Bool, Nat.is_eq(owner, actor) && R.admission_scope(scope, admitted), Nat.is_eq(owner, actor) && False{}, False{}, Equal.cong(Bool, Bool, b => Nat.is_eq(owner, actor) && b, R.admission_scope(scope, admitted), False{}, e), and_false(Nat.is_eq(owner, actor)))

def Laws.artifacts_require_current_write(members, actor, minimum, pending, index, action, e):
  Equal.cong(Bool, R.ArtifactTransition, b => R.artifact_authorized(b && R.artifact_ready(minimum), index, actor, action), R.content_write(R.member_access(R.find(members, actor), members), pending), False{}, e)

def Laws.artifact_pending_denies(members, actor, minimum, index, action):
  Laws.artifacts_require_current_write(members, actor, minimum, True{}, index, action, Laws.pending_rotation_blocks_content(R.member_access(R.find(members, actor), members)))

def Laws.artifact_edit_preserves_creator_actor_and_history(xs, used, actor, id, version, creator, kind, head, deleted, versions, author, writer, typeHash, predecessor, blobs):
  {==}

def Laws.artifact_create_pins_real_creator(xs, used, actor, id, version, author, writer, kind, blobs):
  {==}

def Laws.artifact_deleted_never_resurrects(xs, used, actor, id, version, creator, kind, head, versions, predecessor, author, writer, typeHash, blobs):
  {==}

def Laws.artifact_stale_predecessor_conflicts(xs, used, actor, id, version, creator, kind, head, deleted, versions, predecessor, author, writer, typeHash, blobs, e):
  +fresh = Bool.not(deleted || R.nat_has(used, version))
  +next = {R.ArtifactIndex{R.artifact_put(xs, R.Artifact{id, creator, kind, version, False{}, R.ArtifactVersion{version, actor, blobs} <> versions}), version <> used} : R.ArtifactIndex}
  Equal.trans(R.ArtifactTransition, R.artifact_guard(fresh && Nat.is_eq(predecessor, head) && Nat.is_eq(author, creator) && Nat.is_eq(writer, actor) && Nat.is_eq(typeHash, kind) && R.artifact_references(blobs, xs, id), next), R.artifact_guard(fresh && False{} && Nat.is_eq(author, creator) && Nat.is_eq(writer, actor) && Nat.is_eq(typeHash, kind) && R.artifact_references(blobs, xs, id), next), R.ArtifactConflict{}, Equal.cong(Bool, R.ArtifactTransition, b => R.artifact_guard(fresh && b && Nat.is_eq(author, creator) && Nat.is_eq(writer, actor) && Nat.is_eq(typeHash, kind) && R.artifact_references(blobs, xs, id), next), Nat.is_eq(predecessor, head), False{}, e), Equal.cong(Bool, R.ArtifactTransition, b => R.artifact_guard(b && Nat.is_eq(author, creator) && Nat.is_eq(writer, actor) && Nat.is_eq(typeHash, kind) && R.artifact_references(blobs, xs, id), next), fresh && False{}, False{}, and_false(fresh)))

def Laws.artifact_cross_reference_denied(xs, id, blob, tail, e):
  Equal.cong(Bool, Bool, b => Bool.not(b) && R.artifact_references(tail, xs, id), R.artifact_other_blob(xs, id, blob), True{}, e)

def Laws.artifact_invalid_reference_conflicts(index):
  {==}

def Laws.artifact_comment_references_same_artifact(xs, used, actor, comment, context, creator, author, writer, deleted, versions, id, kind, head):
  {==}

def Laws.artifact_deleted_references_not_live(id, author, kind, head, versions, tail, blob):
  {==}

def Laws.artifact_legacy_client_denied(client, minimum, control):
  match control:
    case False{}:
      {==}
    case True{}:
      {==}

def Laws.blob_stage_pending_denied(access, identity, version, epoch, current):
  Equal.cong(Bool, Bool, b => b && Nat.is_eq(epoch, current), R.server_content(access, identity, version, True{}), False{}, Laws.server_pending_blocks_content(access, identity, version))

def Laws.blob_upload_requires_live_stage(allowed, exists, owner, actor, available):
  match allowed exists:
    case False{} _:
      {==}
    case True{} False{}:
      {==}
    case True{} True{}:
      Equal.cong(Bool, Bool, b => b && available, Nat.is_eq(owner, actor) && False{}, False{}, and_false(Nat.is_eq(owner, actor)))

def Laws.blob_reference_requires_completion(exists, matches, committed, owner, actor, unexpired, epoch, current, sameArtifact):
  match exists matches:
    case False{} _:
      {==}
    case True{} False{}:
      {==}
    case True{} True{}:
      {==}

def Laws.blob_reference_requires_uploader_or_same_artifact(exists, matches, complete, committed, owner, actor, unexpired, epoch, current, sameArtifact):
  {==}

def Laws.blob_unreferenced_not_readable(allowed, complete):
  match allowed:
    case False{}:
      {==}
    case True{}:
      {==}

def Laws.blob_live_never_collected(expired, committed):
  {==}

def Laws.blob_deleted_not_reusable(id, author, kind, head, versions, blob):
  {==}

def Laws.project_self_only(members, actor, member):
  {==}
def Laws.project_agents_follow_live_people(members, pairs, project, id, role, guide, owner, support, live):
  {==}
def Laws.project_agent_cannot_be_person_participant(id, role, guide, owner, support, live, pairs, project):
  {==}
def Laws.project_removed_pair_does_not_resurrect():
  {==}
def Laws.project_readonly_metadata_not_content():
  {==}
def Laws.project_readonly_creation_denied():
  {==}
def Laws.project_readonly_placement_denied():
  {==}
def Laws.project_content_still_blocked_by_rotation(members, actor, pairs, id):
  and_false(R.access_write(R.member_access(R.find(members, actor), members)))
def Laws.project_initial_state_and_no_auto_join():
  {==}
def Laws.project_state_allows_archive():
  {==}
def Laws.project_archive_reopens():
  {==}
def Laws.project_archive_remains_selectable():
  {==}
def Laws.project_stale_metadata_conflicts():
  {==}
def Laws.project_repeated_participation_conflicts():
  {==}
def Laws.project_placement_preserves_artifact_identity(items, pairs, placements, id, project, author, writer, actor, predecessor, revision, previous, old, creator, deleted, kind, head, versions):
  {==}
def project_deleted_value(value: R.Placement, items: +List<R.ProjectInfo>, pairs: +List<R.Participation>, placements: +List<R.Placement>, id: Nat, project: Nat, author: Nat, writer: Nat, actor: Nat, predecessor: Nat, revision: Nat, creator: Nat, kind: Nat, head: Nat, versions: +List<R.ArtifactVersion>) -> {R.project_placement_value(value, Some{R.Artifact{id, creator, kind, head, True{}, versions}}, items, pairs, placements, id, project, author, writer, actor, predecessor, revision) == R.ProjectConflict{} : R.ProjectTransition}:
  match value:
    case R.Placement{_, _, _}:
      {==}

def Laws.project_deleted_placement_conflicts(items, pairs, placements, id, project, author, writer, actor, predecessor, revision, creator, kind, head, versions):
  project_deleted_value(R.placement_find(placements, id), items, pairs, placements, id, project, author, writer, actor, predecessor, revision, creator, kind, head, versions)


def project_absent_value(value: R.Placement, placements: +List<R.Placement>, selector: Nat, id: Nat) -> {R.project_selected_value(value, None{}, placements, selector, id) == False{} : Bool}:
  match value:
    case R.Placement{_, _, _}:
      {==}

def Laws.project_lists_do_not_elevate_read_scope(placements, selector, id):
  project_absent_value(R.placement_find(placements, id), placements, selector, id)


def Laws.project_client_requires_capability(client, minimum, control, artifact):
  Equal.cong(Bool, Bool, b => b && R.project_ready(client) && R.version_ge(client, minimum), (control && artifact) && False{}, False{}, and_false(control && artifact))
def Laws.project_replay_uses_authority_version_and_revision(members, actor, minimum, pending, index, artifacts, revision, action, pairs, items, placements):
  {==}
