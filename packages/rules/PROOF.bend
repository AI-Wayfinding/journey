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
