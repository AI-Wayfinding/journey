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
