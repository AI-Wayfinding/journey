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
