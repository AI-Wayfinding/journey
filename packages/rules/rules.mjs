function word_to_u32(w) {
  let x = 0;
  for (let i = 0; w.$ === "WCon"; i++) {
    x |= Number(w.head) << i;
    w = w.tail;
  }
  return x >>> 0;
}

function u32_to_word(x) {
  let w = {$: "WNil"};
  for (let i = 31; i >= 0; i--) {
    w = {$: "WCon", head: ((x >>> i) & 1) === 1, tail: w};
  }
  return w;
}

function cmp_new(a, b) {
  return {$: a < b ? "LT"
    : a === b ? "EQ" : "GT"};
}

function nat_divmod(a, b) {
  return b === 0 ? {$: "Tuple", fst: 0, snd: a}
    : {$: "Tuple", fst: Math.trunc(a / b), snd: a % b};
}

function nat_chk(n) {
  if (n > 281474976710655) {
    throw "bend: a Nat past the largest immediate 2^48-1";
  }
  return n;
}

function nat_host(n) {
  const int = typeof n === "bigint" || Number.isInteger(n);
  if (int && n >= 0 && n <= 2 ** 53) {
    return Number(n);
  }
  return { [Symbol.toPrimitive]() { throw "bend: a Nat past the largest immediate 2^48-1"; } };
}

function f32_show(x) {
  if (x !== x) {
    return "nan";
  }
  if (!Number.isFinite(x) || Object.is(x, -0)) {
    return x < 0 ? "-inf"
      : x === 0 ? "-0" : "inf";
  }
  let s = "x";
  for (let p = 1; p <= 9 && f32_round(s) !== x; p += 1) {
    s = String(Number(x.toExponential(p - 1)));
  }
  return s;
}

function f32_bits(x) {
  return new Uint32Array(new Float32Array([x]).buffer)[0];
}

function f32_from_bits(u) {
  return new Float32Array(new Uint32Array([u]).buffer)[0];
}

function f32_read(s) {
  const re = /^\s*[+-]?((\d+\.?\d*|\.\d+)(e[+-]?\d+)?|inf(inity)?|nan)$/i;
  const v = f32_round(s.replace(/inf\w*/i, "Infinity"));
  return re.test(s) ? {$: "Some", value: v} : {$: "None"};
}

const f32_round = function f32_round(s) {
  const d = Number(s);
  const a = Math.abs(d);
  const f = Math.fround(a);
  const g = 2 * a - Math.min(f, 2 ** 128);
  if (g === f || Math.fround(g) !== g || g === Infinity) {
    return Math.sign(d) * f;
  }
  let k = 0;
  while (a * 2 ** k % 1 !== 0) {
    k += 1;
  }
  const [, i, r, e] = /(\d*)\.?(\d*)(?:e([+-]?\d+))?$/i.exec(s);
  const n = Number(e ?? 0) - r.length;
  const x = BigInt(i + r) * 2n ** BigInt(k) * 10n ** BigInt(Math.max(n, 0));
  const y = BigInt(a * 2 ** k) * 10n ** BigInt(Math.max(-n, 0));
  return Math.sign(d) * (x === y || x > y !== g > f ? f : g);
};

function char_new(code) {
  if (code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF)) {
    throw "bend: " + code + " is not a Unicode scalar value";
  }
  return String.fromCodePoint(code);
}

// Array
// =====

function array_new(d, v) {
  if (d > 31) {
    throw "bend: an array past the deepest block class 31";
  }
  return Array(2 ** d).fill(v);
}

function array_node(a, b) {
  if (a.length !== b.length) {
    throw "bend: runtime fail-stop";
  }
  return a.concat(b);
}

function array_rmw(a, i, f) {
  const at = i % a.length;
  const old = a[at];
  a[at] = f(old);
  return {$: "Tuple", fst: a, snd: old};
}

// Run
// ===

function run_tail(f, x) {
  return {$: "$JMP", f: f.j?.f === f ? f.j : f, x: [x]};
}

function run_clo(j) {
  const f = (x) => run_loop(j(x));
  f.j = j;
  j.f = f;
  return f;
}

function run_loop(r) {
  while (r !== null && typeof r === "object" && r.$ === "$JMP") {
    r = r.f(...r.x);
  }
  return r;
}

function run_lib(f, n) {
  return (...a) => a.length < n ? run_lib((...b) => f(...a, ...b), n - a.length)
    : f(...a);
}

// Effect
// ======

const $0eff = Object.create(null);

function io_eff(k, run, need) {
  if (k in $0eff) {
    throw new Error("bend: two effects register " + k);
  }
  $0eff[k] = { run, need };
}
// Program
// =======

function $agent_access$(_member_0, _setting_0) {
  return _member_0;
}

function $can_write$(_role_0) {
  if (_role_0.$ === "ReadOnly") {
    return false;
  } else {
    return true;
  }
}

function $person_guide$(_kind_0, _guide_0) {
  if (_kind_0.$ === "Person") {
    return _guide_0;
  } else {
    return false;
  }
}

function $find$(_xs_0, _id_0) {
  if (_xs_0.$ === "Nil") {
    return {$: "None"};
  } else {
    const _t_0 = _xs_0["head"];
    const _key_0 = _t_0["id"];
    const __0 = _t_0["kind"];
    const __1 = _t_0["role"];
    const __2 = _t_0["guide"];
    const __3 = _t_0["owner"];
    const __4 = _t_0["support"];
    const __5 = _t_0["live"];
    const _t_1 = _xs_0["tail"];
    return $Bool$pick$(($Nat$is_eq$(_key_0, _id_0)), {$: "Some", "value": {$: "Member", "id": _key_0, "kind": __0, "role": __1, "guide": __2, "owner": __3, "support": __4, "live": __5}}, ($find$(_t_1, _id_0)));
  }
}

function $is_person$(_m_0) {
  if (_m_0.$ === "None") {
    return false;
  } else {
    const _t_0 = _m_0["value"];
    const _t_1 = _t_0["kind"];
    if (_t_1.$ === "Person") {
      const _live_0 = _t_0["live"];
      return _live_0;
    } else {
      return false;
    }
  }
}

function $is_guide$(_m_0) {
  if (_m_0.$ === "None") {
    return false;
  } else {
    const _t_0 = _m_0["value"];
    const _kind_0 = _t_0["kind"];
    const _guide_0 = _t_0["guide"];
    const _live_0 = _t_0["live"];
    return $Bool$and$(($person_guide$(_kind_0, _guide_0)), _live_0);
  }
}

function $has_guide$(_xs_0) {
  if (_xs_0.$ === "Nil") {
    return false;
  } else {
    const _h_0 = _xs_0["head"];
    const _t_0 = _xs_0["tail"];
    const _x_0 = ($is_guide$({$: "Some", "value": _h_0}));
    const _x_1 = ($has_guide$(_t_0));
    return (_x_0 || _x_1);
  }
}

function $agent_live_access$(_m_0, _setting_0, _live_0) {
  if (_m_0.$ === "None") {
    return {$: "None"};
  } else {
    const _t_0 = _m_0["value"];
    const _t_1 = _t_0["kind"];
    if (_t_1.$ === "Person") {
      const _role_0 = _t_0["role"];
      const _parent_live_0 = _t_0["live"];
      return $Bool$pick$(($Bool$and$(_live_0, _parent_live_0)), {$: "Some", "value": ($agent_access$(_role_0, _setting_0))}, {$: "None"});
    } else {
      return {$: "None"};
    }
  }
}

function $live_person$(_m_0, _live_0) {
  if (_m_0.$ === "None") {
    return {$: "None"};
  } else {
    const _person_0 = _m_0["value"];
    return $Bool$pick$(($Bool$and$(_live_0, ($is_person$({$: "Some", "value": _person_0})))), {$: "Some", "value": _person_0}, {$: "None"});
  }
}

function $authority_person$(_m_0, _xs_0) {
  if (_m_0.$ === "None") {
    return {$: "None"};
  } else {
    const _t_0 = _m_0["value"];
    const __0 = _t_0["id"];
    const _t_1 = _t_0["kind"];
    if (_t_1.$ === "Person") {
      const __1 = _t_0["role"];
      const __2 = _t_0["guide"];
      const _owner_0 = _t_0["owner"];
      const __3 = _t_0["support"];
      const _live_0 = _t_0["live"];
      return $live_person$({$: "Some", "value": {$: "Member", "id": __0, "kind": {$: "Person"}, "role": __1, "guide": __2, "owner": _owner_0, "support": __3, "live": _live_0}}, _live_0);
    } else {
      const _owner_1 = _t_0["owner"];
      const _live_1 = _t_0["live"];
      return $live_person$(($find$(_xs_0, _owner_1)), _live_1);
    }
  }
}

function $member_access$(_m_0, _xs_0) {
  if (_m_0.$ === "None") {
    return {$: "None"};
  } else {
    const _t_0 = _m_0["value"];
    const _t_1 = _t_0["kind"];
    if (_t_1.$ === "Person") {
      const _role_0 = _t_0["role"];
      const _live_0 = _t_0["live"];
      return $Bool$pick$(_live_0, {$: "Some", "value": _role_0}, {$: "None"});
    } else {
      const _role_1 = _t_0["role"];
      const _owner_1 = _t_0["owner"];
      const _live_1 = _t_0["live"];
      return $agent_live_access$(($find$(_xs_0, _owner_1)), _role_1, _live_1);
    }
  }
}

function $access_write$(_a_0) {
  if (_a_0.$ === "None") {
    return false;
  } else {
    const _role_0 = _a_0["value"];
    return $can_write$(_role_0);
  }
}

function $access_read$(_a_0) {
  if (_a_0.$ === "None") {
    return false;
  } else {
    return true;
  }
}

function $owned_agent$(_kind_0, _owner_0, _actor_0) {
  if (_kind_0.$ === "Person") {
    return false;
  } else {
    return $Nat$is_eq$(_owner_0, _actor_0);
  }
}

function $survives$(_target_0, _person_0, _m_0) {
  const _id_0 = _m_0["id"];
  const _kind_0 = _m_0["kind"];
  const _owner_0 = _m_0["owner"];
  const _x_0 = ($Nat$is_eq$(_id_0, _target_0));
  const _x_1 = ($Bool$and$(_person_0, ($owned_agent$(_kind_0, _owner_0, _target_0))));
  return $Bool$not$((_x_0 || _x_1));
}

function $remove$(_xs_0, _target_0, _person_0) {
  if (_xs_0.$ === "Nil") {
    return {$: "Nil"};
  } else {
    const _h_0 = _xs_0["head"];
    const _t_0 = _xs_0["tail"];
    const _rest_0 = ($remove$(_t_0, _target_0, _person_0));
    return $Bool$pick$(($survives$(_target_0, _person_0, _h_0)), {$: "Con", "head": _h_0, "tail": _rest_0}, _rest_0);
  }
}

function $removal_authority$(_guide_0, _self_0, _target_0, _actor_0) {
  if (_target_0.$ === "None") {
    return false;
  } else {
    const _t_0 = _target_0["value"];
    const _kind_0 = _t_0["kind"];
    const _owner_0 = _t_0["owner"];
    const _x_0 = (_guide_0 || _self_0);
    const _x_1 = ($owned_agent$(_kind_0, _owner_0, _actor_0));
    return (_x_0 || _x_1);
  }
}

function $can_remove$(_xs_0, _actor_0, _target_0) {
  return $Bool$and$(($is_person$(($find$(_xs_0, _actor_0)))), ($removal_authority$(($is_guide$(($find$(_xs_0, _actor_0)))), ($Nat$is_eq$(_actor_0, _target_0)), ($find$(_xs_0, _target_0)), _actor_0)));
}

function $set_guide$(_xs_0, _id_0, _guide_0) {
  if (_xs_0.$ === "Nil") {
    return {$: "Nil"};
  } else {
    const _t_0 = _xs_0["head"];
    const _key_0 = _t_0["id"];
    const _kind_0 = _t_0["kind"];
    const _role_0 = _t_0["role"];
    const _old_0 = _t_0["guide"];
    const _owner_0 = _t_0["owner"];
    const _support_0 = _t_0["support"];
    const _live_0 = _t_0["live"];
    const _t_1 = _xs_0["tail"];
    const _next_0 = ($Bool$pick$(($Nat$is_eq$(_key_0, _id_0)), ($person_guide$(_kind_0, _guide_0)), _old_0));
    return {$: "Con", "head": {$: "Member", "id": _key_0, "kind": _kind_0, "role": _role_0, "guide": _next_0, "owner": _owner_0, "support": _support_0, "live": _live_0}, "tail": ($set_guide$(_t_1, _id_0, _guide_0))};
  }
}

function $set_role$(_xs_0, _id_0, _role_0) {
  if (_xs_0.$ === "Nil") {
    return {$: "Nil"};
  } else {
    const _t_0 = _xs_0["head"];
    const _key_0 = _t_0["id"];
    const _kind_0 = _t_0["kind"];
    const _old_0 = _t_0["role"];
    const _guide_0 = _t_0["guide"];
    const _owner_0 = _t_0["owner"];
    const _support_0 = _t_0["support"];
    const _live_0 = _t_0["live"];
    const _t_1 = _xs_0["tail"];
    const _next_0 = ($Bool$pick$(($Nat$is_eq$(_key_0, _id_0)), _role_0, _old_0));
    return {$: "Con", "head": {$: "Member", "id": _key_0, "kind": _kind_0, "role": _next_0, "guide": _guide_0, "owner": _owner_0, "support": _support_0, "live": _live_0}, "tail": ($set_role$(_t_1, _id_0, _role_0))};
  }
}

function $guarded_members$(_safe_0, _members_0) {
  if (!_safe_0) {
    return {$: "LastGuide"};
  } else {
    return {$: "Accepted", "members": _members_0};
  }
}

function $guard$(_allowed_0, _members_0) {
  if (!_allowed_0) {
    return {$: "Denied"};
  } else {
    return $guarded_members$(($has_guide$(_members_0)), _members_0);
  }
}

function $addition_authority$(_xs_0, _actor_0, _m_0) {
  const _t_0 = _m_0["kind"];
  if (_t_0.$ === "Person") {
    const _guide_0 = _m_0["guide"];
    const _support_0 = _m_0["support"];
    return $Bool$and$(($is_guide$(($find$(_xs_0, _actor_0)))), ($Bool$not$(($Bool$and$(_support_0, _guide_0)))));
  } else {
    const _guide_1 = _m_0["guide"];
    const _owner_1 = _m_0["owner"];
    return $Bool$and$(($Bool$and$(($is_person$(($find$(_xs_0, _actor_0)))), ($Nat$is_eq$(_owner_1, _actor_0)))), ($Bool$not$(_guide_1)));
  }
}

function $missing$(_m_0) {
  if (_m_0.$ === "None") {
    return true;
  } else {
    return false;
  }
}

function $guide_target$(_m_0) {
  if (_m_0.$ === "None") {
    return false;
  } else {
    const _t_0 = _m_0["value"];
    const _kind_0 = _t_0["kind"];
    const _support_0 = _t_0["support"];
    return $Bool$and$(($is_person$({$: "Some", "value": {$: "Member", "id": 0, "kind": _kind_0, "role": {$: "ReadOnly"}, "guide": false, "owner": 0, "support": false, "live": true}})), ($Bool$not$(_support_0)));
  }
}

function $own_profile$(_xs_0, _actor_0, _target_0) {
  return $Bool$and$(($is_person$(($find$(_xs_0, _actor_0)))), ($Nat$is_eq$(_actor_0, _target_0)));
}

function $rename_authority$(_xs_0, _actor_0, _target_0) {
  if (_target_0.$ === "None") {
    return false;
  } else {
    const _t_0 = _target_0["value"];
    const _t_1 = _t_0["kind"];
    if (_t_1.$ === "Person") {
      return false;
    } else {
      const _owner_1 = _t_0["owner"];
      const _x_0 = ($is_guide$(($find$(_xs_0, _actor_0))));
      const _x_1 = ($Nat$is_eq$(_owner_1, _actor_0));
      return $Bool$and$(($is_person$(($find$(_xs_0, _actor_0)))), (_x_0 || _x_1));
    }
  }
}

function $add_checked$(_fresh_0, _allowed_0, _member_0, _xs_0) {
  if (!_fresh_0) {
    return {$: "Invalid"};
  } else {
    return $guard$(_allowed_0, {$: "Con", "head": _member_0, "tail": _xs_0});
  }
}

function $rename_checked$(_person_0, _allowed_0, _xs_0) {
  if (_person_0) {
    return {$: "Invalid"};
  } else {
    return $guard$(_allowed_0, _xs_0);
  }
}

function $own_agent$(_xs_0, _actor_0, _target_0) {
  if (_target_0.$ === "None") {
    return false;
  } else {
    const _t_0 = _target_0["value"];
    const _kind_0 = _t_0["kind"];
    const _owner_0 = _t_0["owner"];
    return $Bool$and$(($is_person$(($find$(_xs_0, _actor_0)))), ($owned_agent$(_kind_0, _owner_0, _actor_0)));
  }
}

function $apply$(_xs_0, _control_0) {
  if (_control_0.$ === "Add") {
    const _actor_0 = _control_0["actor"];
    const _t_0 = _control_0["member"];
    const _id_0 = _t_0["id"];
    const __0 = _t_0["kind"];
    const __1 = _t_0["role"];
    const __2 = _t_0["guide"];
    const __3 = _t_0["owner"];
    const __4 = _t_0["support"];
    const __5 = _t_0["live"];
    return $add_checked$(($missing$(($find$(_xs_0, _id_0)))), ($addition_authority$(_xs_0, _actor_0, {$: "Member", "id": _id_0, "kind": __0, "role": __1, "guide": __2, "owner": __3, "support": __4, "live": __5})), {$: "Member", "id": _id_0, "kind": __0, "role": __1, "guide": __2, "owner": __3, "support": __4, "live": __5}, _xs_0);
  } else if (_control_0.$ === "Remove") {
    const _actor_1 = _control_0["actor"];
    const _target_0 = _control_0["target"];
    return $guard$(($can_remove$(_xs_0, _actor_1, _target_0)), ($remove$(_xs_0, _target_0, ($is_person$(($find$(_xs_0, _target_0)))))));
  } else if (_control_0.$ === "Guide") {
    const _actor_2 = _control_0["actor"];
    const _target_1 = _control_0["target"];
    const _guide_0 = _control_0["guide"];
    return $guard$(($Bool$and$(($is_guide$(($find$(_xs_0, _actor_2)))), ($guide_target$(($find$(_xs_0, _target_1)))))), ($set_guide$(_xs_0, _target_1, _guide_0)));
  } else if (_control_0.$ === "RoleChange") {
    const _actor_3 = _control_0["actor"];
    const _target_2 = _control_0["target"];
    const _role_0 = _control_0["role"];
    return $guard$(($Bool$and$(($is_guide$(($find$(_xs_0, _actor_3)))), ($guide_target$(($find$(_xs_0, _target_2)))))), ($set_role$(_xs_0, _target_2, _role_0)));
  } else if (_control_0.$ === "Settings") {
    const _actor_4 = _control_0["actor"];
    return $guard$(($is_guide$(($find$(_xs_0, _actor_4)))), _xs_0);
  } else if (_control_0.$ === "Profile") {
    const _actor_5 = _control_0["actor"];
    const _target_3 = _control_0["target"];
    return $guard$(($own_profile$(_xs_0, _actor_5, _target_3)), _xs_0);
  } else if (_control_0.$ === "Rename") {
    const _actor_6 = _control_0["actor"];
    const _target_4 = _control_0["target"];
    return $rename_checked$(($is_person$(($find$(_xs_0, _target_4)))), ($rename_authority$(_xs_0, _actor_6, ($find$(_xs_0, _target_4)))), _xs_0);
  } else if (_control_0.$ === "Rotate") {
    const _actor_7 = _control_0["actor"];
    return $guard$(($is_guide$(($find$(_xs_0, _actor_7)))), _xs_0);
  } else {
    const _actor_8 = _control_0["actor"];
    const _target_5 = _control_0["target"];
    return $guard$(($own_agent$(_xs_0, _actor_8, ($find$(_xs_0, _target_5)))), _xs_0);
  }
}

function $replay_step$(_state_0, _control_0) {
  if (_state_0.$ === "Accepted") {
    const _xs_0 = _state_0["members"];
    return $apply$(_xs_0, _control_0);
  } else if (_state_0.$ === "Denied") {
    return {$: "Denied"};
  } else if (_state_0.$ === "Invalid") {
    return {$: "Invalid"};
  } else {
    return {$: "LastGuide"};
  }
}

function $replay$($0, $1) {
  for (;;) {
    {
      const _controls_0 = $0;
      const _state_0 = $1;
      if (_controls_0.$ === "Nil") {
        return _state_0;
      } else {
        const _h_0 = _controls_0["head"];
        const _t_0 = _controls_0["tail"];
        $0 = _t_0;
        $1 = ($replay_step$(_state_0, _h_0));
        continue;
      }
    }
  }
}

function $new_epoch_key$(_target_0, _person_0, _member_0) {
  return $survives$(_target_0, _person_0, _member_0);
}

function $all_survive$(_target_0, _person_0, _xs_0) {
  if (_xs_0.$ === "Nil") {
    return true;
  } else {
    const _h_0 = _xs_0["head"];
    const _t_0 = _xs_0["tail"];
    return $Bool$and$(($survives$(_target_0, _person_0, _h_0)), ($all_survive$(_target_0, _person_0, _t_0)));
  }
}

function $transport_access$(_live_0, _identity_0, _write_0, _role_0) {
  const _x_0 = ($Bool$not$(_write_0));
  const _x_1 = ($can_write$(_role_0));
  return $Bool$and$(($Bool$and$(_live_0, _identity_0)), (_x_0 || _x_1));
}

function $transport_remove$(_owned_0, _kind_0) {
  if (_kind_0.$ === "Person") {
    return true;
  } else {
    return _owned_0;
  }
}

function $transport_renew$(_person_0, _agent_0, _owned_0, _live_0) {
  return $Bool$and$(($Bool$and$(($Bool$and$(_person_0, _agent_0)), _owned_0)), _live_0);
}

function $rotation_holdings$(_xs_0, _epoch_0) {
  if (_xs_0.$ === "Nil") {
    return {$: "Nil"};
  } else {
    const _t_0 = _xs_0["head"];
    const _id_0 = _t_0["id"];
    const _tail_0 = _xs_0["tail"];
    return {$: "Con", "head": {$: "Holding", "principal": _id_0, "epoch": _epoch_0}, "tail": ($rotation_holdings$(_tail_0, _epoch_0))};
  }
}

function $remove_and_rotate$(_xs_0, _target_0, _person_0, _epoch_0) {
  return $rotation_holdings$(($remove$(_xs_0, _target_0, _person_0)), _epoch_0);
}

function $next_holding$(_target_0, _person_0, _member_0, _epoch_0) {
  const _id_0 = _member_0["id"];
  const __0 = _member_0["kind"];
  const __1 = _member_0["role"];
  const __2 = _member_0["guide"];
  const __3 = _member_0["owner"];
  const __4 = _member_0["support"];
  const __5 = _member_0["live"];
  return $Bool$pick$(($new_epoch_key$(_target_0, _person_0, {$: "Member", "id": _id_0, "kind": __0, "role": __1, "guide": __2, "owner": __3, "support": __4, "live": __5})), {$: "Some", "value": {$: "Holding", "principal": _id_0, "epoch": _epoch_0}}, {$: "None"});
}

function $active_settings$(_s_0) {
  const _t_0 = _s_0["visibility"];
  if (_t_0.$ === "Private") {
    const _t_1 = _s_0["joining"];
    if (_t_1.$ === "InvitationOnly") {
      return true;
    } else {
      return false;
    }
  } else {
    return false;
  }
}

function $legacy_settings$(_name_0, _description_0) {
  return {$: "JourneySettings", "name": _name_0, "description": _description_0, "defaultRole": {$: "ReadWrite"}, "visibility": {$: "Private"}, "joining": {$: "InvitationOnly"}};
}

function $admission_role$(_support_0, _defaultRole_0) {
  if (_support_0) {
    return {$: "ReadOnly"};
  } else {
    return _defaultRole_0;
  }
}

function $admitted_member$(_member_0, _defaultRole_0) {
  const _id_0 = _member_0["id"];
  const _t_0 = _member_0["kind"];
  if (_t_0.$ === "Person") {
    const _guide_0 = _member_0["guide"];
    const _owner_0 = _member_0["owner"];
    const _support_0 = _member_0["support"];
    const _live_0 = _member_0["live"];
    return {$: "Member", "id": _id_0, "kind": {$: "Person"}, "role": ($admission_role$(_support_0, _defaultRole_0)), "guide": _guide_0, "owner": _owner_0, "support": _support_0, "live": _live_0};
  } else {
    const __1 = _member_0["role"];
    const _guide_1 = _member_0["guide"];
    const _owner_1 = _member_0["owner"];
    const _support_1 = _member_0["support"];
    const _live_1 = _member_0["live"];
    return {$: "Member", "id": _id_0, "kind": {$: "Agent"}, "role": __1, "guide": _guide_1, "owner": _owner_1, "support": _support_1, "live": _live_1};
  }
}

function $version_ge$(_a_0, _b_0) {
  const _am_0 = _a_0["major"];
  const _an_0 = _a_0["minor"];
  const _ap_0 = _a_0["patch"];
  const _bm_0 = _b_0["major"];
  const _bn_0 = _b_0["minor"];
  const _bp_0 = _b_0["patch"];
  const _x_0 = ($Nat$is_gt$(_an_0, _bn_0));
  const _x_1 = ($Bool$and$(($Nat$is_eq$(_an_0, _bn_0)), ($Nat$is_ge$(_ap_0, _bp_0))));
  const _x_2 = ($Nat$is_gt$(_am_0, _bm_0));
  const _x_3 = ($Bool$and$(($Nat$is_eq$(_am_0, _bm_0)), (_x_0 || _x_1)));
  return (_x_2 || _x_3);
}

function $stage_ready$(_v_0) {
  return $version_ge$(_v_0, {$: "Version", "major": 0, "minor": 1, "patch": 4});
}

function $journey_guard$(_allowed_0, _state_0) {
  if (!_allowed_0) {
    return {$: "JourneyDenied"};
  } else {
    return {$: "JourneyAccepted", "state": _state_0};
  }
}

function $configure$(_xs_0, _actor_0, _settings_0, _minimum_0, _pending_0) {
  return $journey_guard$(($Bool$and$(($Bool$and$(($stage_ready$(_minimum_0)), ($is_guide$(($find$(_xs_0, _actor_0)))))), ($active_settings$(_settings_0)))), {$: "JourneyState", "members": _xs_0, "settings": _settings_0, "minimum": _minimum_0, "pending": _pending_0});
}

function $minimum_change$(_xs_0, _actor_0, _settings_0, _old_0, _next_0, _pending_0) {
  return $journey_guard$(($Bool$and$(($is_guide$(($find$(_xs_0, _actor_0)))), ($version_ge$(_next_0, _old_0)))), {$: "JourneyState", "members": _xs_0, "settings": _settings_0, "minimum": _next_0, "pending": _pending_0});
}

function $content_write$(_access_0, _pending_0) {
  return $Bool$and$(($access_write$(_access_0)), ($Bool$not$(_pending_0)));
}

function $control_pending$(_control_0, _pending_0) {
  if (_control_0.$ === "Remove") {
    return true;
  } else if (_control_0.$ === "Rotate") {
    return false;
  } else {
    return _pending_0;
  }
}

function $admission_control$(_control_0, _settings_0, _upgraded_0) {
  if (_control_0.$ === "Add") {
    const _actor_0 = _control_0["actor"];
    const _member_0 = _control_0["member"];
    const _defaultRole_0 = _settings_0["defaultRole"];
    return {$: "Add", "actor": _actor_0, "member": ($Bool$pick$(_upgraded_0, ($admitted_member$(_member_0, _defaultRole_0)), _member_0))};
  } else {
    return _control_0;
  }
}

function $journey_result$(_result_0, _settings_0, _minimum_0, _pending_0) {
  if (_result_0.$ === "Accepted") {
    const _members_0 = _result_0["members"];
    return {$: "JourneyAccepted", "state": {$: "JourneyState", "members": _members_0, "settings": _settings_0, "minimum": _minimum_0, "pending": _pending_0}};
  } else if (_result_0.$ === "Denied") {
    return {$: "JourneyDenied"};
  } else if (_result_0.$ === "Invalid") {
    return {$: "JourneyInvalid"};
  } else {
    return {$: "JourneyLastGuide"};
  }
}

function $journey_control$(_xs_0, _settings_0, _minimum_0, _pending_0, _control_0) {
  return $journey_result$(($apply$(_xs_0, ($admission_control$(_control_0, _settings_0, ($stage_ready$(_minimum_0)))))), _settings_0, _minimum_0, ($Bool$pick$(($stage_ready$(_minimum_0)), ($control_pending$(_control_0, _pending_0)), _pending_0)));
}

function $upgrade_control$(_ready_0, _xs_0, _settings_0, _minimum_0, _pending_0, _control_0) {
  if (!_ready_0) {
    return {$: "UpgradeRequired"};
  } else {
    return $journey_control$(_xs_0, _settings_0, _minimum_0, _pending_0, _control_0);
  }
}

function $journey_apply$(_state_0, _control_0) {
  const _xs_0 = _state_0["members"];
  const _settings_0 = _state_0["settings"];
  const _minimum_0 = _state_0["minimum"];
  const _pending_0 = _state_0["pending"];
  if (_control_0.$ === "LegacyControl") {
    const _control_1 = _control_0["control"];
    return $journey_control$(_xs_0, _settings_0, _minimum_0, _pending_0, _control_1);
  } else if (_control_0.$ === "NewControl") {
    const _control_2 = _control_0["control"];
    return $upgrade_control$(($stage_ready$(_minimum_0)), _xs_0, _settings_0, _minimum_0, _pending_0, _control_2);
  } else if (_control_0.$ === "Configure") {
    const _actor_0 = _control_0["actor"];
    const _settings_1 = _control_0["settings"];
    return $configure$(_xs_0, _actor_0, _settings_1, _minimum_0, _pending_0);
  } else {
    const _actor_1 = _control_0["actor"];
    const _version_0 = _control_0["version"];
    return $minimum_change$(_xs_0, _actor_1, _settings_0, _minimum_0, _version_0, _pending_0);
  }
}

function $journey_replay_step$(_result_0, _control_0) {
  if (_result_0.$ === "JourneyAccepted") {
    const _state_0 = _result_0["state"];
    return $journey_apply$(_state_0, _control_0);
  } else {
    return _result_0;
  }
}

function $journey_replay$($0, $1) {
  for (;;) {
    {
      const _controls_0 = $0;
      const _result_0 = $1;
      if (_controls_0.$ === "Nil") {
        return _result_0;
      } else {
        const _head_0 = _controls_0["head"];
        const _tail_0 = _controls_0["tail"];
        $0 = _tail_0;
        $1 = ($journey_replay_step$(_result_0, _head_0));
        continue;
      }
    }
  }
}

function $server_version$(_client_0, _minimum_0, _format_0) {
  return $Bool$and$(($Bool$and$(_format_0, ($stage_ready$(_client_0)))), ($version_ge$(_client_0, _minimum_0)));
}

function $server_read$(_access_0, _identity_0, _version_0) {
  return $Bool$and$(($Bool$and$(($access_read$(_access_0)), _identity_0)), _version_0);
}

function $server_content$(_access_0, _identity_0, _version_0, _pending_0) {
  return $Bool$and$(($Bool$and$(($content_write$(_access_0, _pending_0)), _identity_0)), _version_0);
}

function $admission_scope$(_member_0, _admitted_0) {
  if (_member_0.$ === "None") {
    if (_admitted_0.$ === "None") {
      return true;
    } else {
      return false;
    }
  } else {
    const _t_0 = _member_0["value"];
    if (_t_0.$ === "ReadOnly") {
      if (_admitted_0.$ === "Some") {
        const _t_1 = _admitted_0["value"];
        if (_t_1.$ === "ReadOnly") {
          return true;
        } else {
          return false;
        }
      } else {
        return false;
      }
    } else {
      if (_admitted_0.$ === "Some") {
        const _t_2 = _admitted_0["value"];
        if (_t_2.$ === "ReadWrite") {
          return true;
        } else {
          return false;
        }
      } else {
        return false;
      }
    }
  }
}

function $server_admission$(_kind_0, _scope_0, _admitted_0, _owner_0, _actor_0, _support_0) {
  if (_kind_0.$ === "Person") {
    const _x_0 = ($Bool$not$(_support_0));
    const _x_1 = ($admission_scope$(_scope_0, {$: "Some", "value": {$: "ReadOnly"}}));
    return (_x_0 || _x_1);
  } else {
    return $Nat$is_eq$(_owner_0, _actor_0);
  }
}

function $artifact_ready$(_v_0) {
  return $version_ge$(_v_0, {$: "Version", "major": 0, "minor": 1, "patch": 5});
}

function $artifact_client$(_client_0, _minimum_0, _control_0, _artifact_0) {
  return $Bool$and$(($Bool$and$(($Bool$and$(_control_0, _artifact_0)), ($artifact_ready$(_client_0)))), ($version_ge$(_client_0, _minimum_0)));
}

function $nat_has$(_xs_0, _id_0) {
  if (_xs_0.$ === "Nil") {
    return false;
  } else {
    const _h_0 = _xs_0["head"];
    const _t_0 = _xs_0["tail"];
    const _x_0 = ($Nat$is_eq$(_h_0, _id_0));
    const _x_1 = ($nat_has$(_t_0, _id_0));
    return (_x_0 || _x_1);
  }
}

function $artifact_find$(_xs_0, _id_0) {
  if (_xs_0.$ === "Nil") {
    return {$: "None"};
  } else {
    const _t_0 = _xs_0["head"];
    const _key_0 = _t_0["id"];
    const __0 = _t_0["author"];
    const __1 = _t_0["typeHash"];
    const __2 = _t_0["head"];
    const __3 = _t_0["deleted"];
    const __4 = _t_0["versions"];
    const _t_1 = _xs_0["tail"];
    return $Bool$pick$(($Nat$is_eq$(_key_0, _id_0)), {$: "Some", "value": {$: "Artifact", "id": _key_0, "author": __0, "typeHash": __1, "head": __2, "deleted": __3, "versions": __4}}, ($artifact_find$(_t_1, _id_0)));
  }
}

function $artifact_put$(_xs_0, _value_0) {
  if (_xs_0.$ === "Nil") {
    return {$: "Con", "head": _value_0, "tail": {$: "Nil"}};
  } else {
    const _t_0 = _xs_0["head"];
    const _key_0 = _t_0["id"];
    const __0 = _t_0["author"];
    const __1 = _t_0["typeHash"];
    const __2 = _t_0["head"];
    const __3 = _t_0["deleted"];
    const __4 = _t_0["versions"];
    const _t_1 = _xs_0["tail"];
    const _id_0 = _value_0["id"];
    const __5 = _value_0["author"];
    const __6 = _value_0["typeHash"];
    const __7 = _value_0["head"];
    const __8 = _value_0["deleted"];
    const __9 = _value_0["versions"];
    return $Bool$pick$(($Nat$is_eq$(_key_0, _id_0)), {$: "Con", "head": {$: "Artifact", "id": _id_0, "author": __5, "typeHash": __6, "head": __7, "deleted": __8, "versions": __9}, "tail": _t_1}, {$: "Con", "head": {$: "Artifact", "id": _key_0, "author": __0, "typeHash": __1, "head": __2, "deleted": __3, "versions": __4}, "tail": ($artifact_put$(_t_1, {$: "Artifact", "id": _id_0, "author": __5, "typeHash": __6, "head": __7, "deleted": __8, "versions": __9}))});
  }
}

function $artifact_version_has$(_xs_0, _id_0) {
  if (_xs_0.$ === "Nil") {
    return false;
  } else {
    const _t_0 = _xs_0["head"];
    const _key_0 = _t_0["id"];
    const _t_1 = _xs_0["tail"];
    const _x_0 = ($Nat$is_eq$(_key_0, _id_0));
    const _x_1 = ($artifact_version_has$(_t_1, _id_0));
    return (_x_0 || _x_1);
  }
}

function $artifact_blob_has$(_xs_0, _id_0) {
  if (_xs_0.$ === "Nil") {
    return false;
  } else {
    const _t_0 = _xs_0["head"];
    const _blobs_0 = _t_0["blobs"];
    const _t_1 = _xs_0["tail"];
    const _x_0 = ($nat_has$(_blobs_0, _id_0));
    const _x_1 = ($artifact_blob_has$(_t_1, _id_0));
    return (_x_0 || _x_1);
  }
}

function $artifact_other_blob$(_xs_0, _target_0, _blob_0) {
  if (_xs_0.$ === "Nil") {
    return false;
  } else {
    const _t_0 = _xs_0["head"];
    const _id_0 = _t_0["id"];
    const _versions_0 = _t_0["versions"];
    const _t_1 = _xs_0["tail"];
    const _x_0 = ($Bool$and$(($Bool$not$(($Nat$is_eq$(_id_0, _target_0)))), ($artifact_blob_has$(_versions_0, _blob_0))));
    const _x_1 = ($artifact_other_blob$(_t_1, _target_0, _blob_0));
    return (_x_0 || _x_1);
  }
}

function $artifact_references$(_blobs_0, _xs_0, _target_0) {
  if (_blobs_0.$ === "Nil") {
    return true;
  } else {
    const _h_0 = _blobs_0["head"];
    const _t_0 = _blobs_0["tail"];
    return $Bool$and$(($Bool$not$(($artifact_other_blob$(_xs_0, _target_0, _h_0)))), ($artifact_references$(_t_0, _xs_0, _target_0)));
  }
}

function $artifact_live_blob$(_xs_0, _blob_0) {
  if (_xs_0.$ === "Nil") {
    return false;
  } else {
    const _t_0 = _xs_0["head"];
    const _deleted_0 = _t_0["deleted"];
    const _versions_0 = _t_0["versions"];
    const _t_1 = _xs_0["tail"];
    const _x_0 = ($Bool$and$(($Bool$not$(_deleted_0)), ($artifact_blob_has$(_versions_0, _blob_0))));
    const _x_1 = ($artifact_live_blob$(_t_1, _blob_0));
    return (_x_0 || _x_1);
  }
}

function $artifact_guard$(_valid_0, _index_0) {
  if (!_valid_0) {
    return {$: "ArtifactConflict"};
  } else {
    return {$: "ArtifactAccepted", "index": _index_0};
  }
}

function $artifact_create$(_xs_0, _used_0, _actor_0, _id_0, _version_0, _author_0, _writer_0, _typeHash_0, _blobs_0) {
  const _x_0 = ($nat_has$(_used_0, _id_0));
  const _x_1 = ($nat_has$(_used_0, _version_0));
  const _x_2 = (_x_0 || _x_1);
  const _x_3 = ($Nat$is_eq$(_id_0, _version_0));
  return $artifact_guard$(($Bool$and$(($Bool$and$(($Bool$and$(($Bool$not$((_x_2 || _x_3))), ($Nat$is_eq$(_author_0, _actor_0)))), ($Nat$is_eq$(_writer_0, _actor_0)))), ($artifact_references$(_blobs_0, _xs_0, _id_0)))), {$: "ArtifactIndex", "items": {$: "Con", "head": {$: "Artifact", "id": _id_0, "author": _actor_0, "typeHash": _typeHash_0, "head": _version_0, "deleted": false, "versions": {$: "Con", "head": {$: "ArtifactVersion", "id": _version_0, "writer": _actor_0, "blobs": _blobs_0}, "tail": {$: "Nil"}}}, "tail": _xs_0}, "used": {$: "Con", "head": _id_0, "tail": {$: "Con", "head": _version_0, "tail": _used_0}}});
}

function $artifact_edit$(_target_0, _xs_0, _used_0, _actor_0, _id_0, _version_0, _predecessor_0, _author_0, _writer_0, _typeHash_0, _blobs_0) {
  if (_target_0.$ === "None") {
    return {$: "ArtifactConflict"};
  } else {
    const _t_0 = _target_0["value"];
    const _creator_0 = _t_0["author"];
    const _kind_0 = _t_0["typeHash"];
    const _head_0 = _t_0["head"];
    const _deleted_0 = _t_0["deleted"];
    const _versions_0 = _t_0["versions"];
    const _x_0 = ($nat_has$(_used_0, _version_0));
    return $artifact_guard$(($Bool$and$(($Bool$and$(($Bool$and$(($Bool$and$(($Bool$and$(($Bool$not$((_deleted_0 || _x_0))), ($Nat$is_eq$(_predecessor_0, _head_0)))), ($Nat$is_eq$(_author_0, _creator_0)))), ($Nat$is_eq$(_writer_0, _actor_0)))), ($Nat$is_eq$(_typeHash_0, _kind_0)))), ($artifact_references$(_blobs_0, _xs_0, _id_0)))), {$: "ArtifactIndex", "items": ($artifact_put$(_xs_0, {$: "Artifact", "id": _id_0, "author": _creator_0, "typeHash": _kind_0, "head": _version_0, "deleted": false, "versions": {$: "Con", "head": {$: "ArtifactVersion", "id": _version_0, "writer": _actor_0, "blobs": _blobs_0}, "tail": _versions_0}})), "used": {$: "Con", "head": _version_0, "tail": _used_0}});
  }
}

function $artifact_comment$(_target_0, _xs_0, _used_0, _actor_0, _comment_0, _onVersion_0, _author_0, _writer_0) {
  if (_target_0.$ === "None") {
    return {$: "ArtifactConflict"};
  } else {
    const _t_0 = _target_0["value"];
    const _creator_0 = _t_0["author"];
    const _deleted_0 = _t_0["deleted"];
    const _versions_0 = _t_0["versions"];
    const _x_0 = ($nat_has$(_used_0, _comment_0));
    const _x_1 = ($Nat$is_eq$(_onVersion_0, 0));
    const _x_2 = ($artifact_version_has$(_versions_0, _onVersion_0));
    return $artifact_guard$(($Bool$and$(($Bool$and$(($Bool$and$(($Bool$not$((_deleted_0 || _x_0))), ($Nat$is_eq$(_author_0, _creator_0)))), ($Nat$is_eq$(_writer_0, _actor_0)))), (_x_1 || _x_2))), {$: "ArtifactIndex", "items": _xs_0, "used": {$: "Con", "head": _comment_0, "tail": _used_0}});
  }
}

function $artifact_delete$(_target_0, _xs_0, _used_0, _id_0, _author_0, _writer_0, _actor_0) {
  if (_target_0.$ === "None") {
    return {$: "ArtifactConflict"};
  } else {
    const _t_0 = _target_0["value"];
    const _creator_0 = _t_0["author"];
    const _kind_0 = _t_0["typeHash"];
    const _head_0 = _t_0["head"];
    const _deleted_0 = _t_0["deleted"];
    const _versions_0 = _t_0["versions"];
    return $artifact_guard$(($Bool$and$(($Bool$and$(($Bool$not$(_deleted_0)), ($Nat$is_eq$(_author_0, _creator_0)))), ($Nat$is_eq$(_writer_0, _actor_0)))), {$: "ArtifactIndex", "items": ($artifact_put$(_xs_0, {$: "Artifact", "id": _id_0, "author": _creator_0, "typeHash": _kind_0, "head": _head_0, "deleted": true, "versions": _versions_0})), "used": _used_0});
  }
}

function $artifact_action$(_index_0, _actor_0, _action_0) {
  const _xs_0 = _index_0["items"];
  const _used_0 = _index_0["used"];
  if (_action_0.$ === "ArtifactCreate") {
    const _id_0 = _action_0["id"];
    const _version_0 = _action_0["version"];
    const _author_0 = _action_0["author"];
    const _writer_0 = _action_0["writer"];
    const _typeHash_0 = _action_0["typeHash"];
    const _blobs_0 = _action_0["blobs"];
    return $artifact_create$(_xs_0, _used_0, _actor_0, _id_0, _version_0, _author_0, _writer_0, _typeHash_0, _blobs_0);
  } else if (_action_0.$ === "ArtifactEdit") {
    const _id_1 = _action_0["id"];
    const _version_1 = _action_0["version"];
    const _predecessor_0 = _action_0["predecessor"];
    const _author_1 = _action_0["author"];
    const _writer_1 = _action_0["writer"];
    const _typeHash_1 = _action_0["typeHash"];
    const _blobs_1 = _action_0["blobs"];
    return $artifact_edit$(($artifact_find$(_xs_0, _id_1)), _xs_0, _used_0, _actor_0, _id_1, _version_1, _predecessor_0, _author_1, _writer_1, _typeHash_1, _blobs_1);
  } else if (_action_0.$ === "ArtifactComment") {
    const _id_2 = _action_0["id"];
    const _comment_0 = _action_0["comment"];
    const _onVersion_0 = _action_0["onVersion"];
    const _author_2 = _action_0["author"];
    const _writer_2 = _action_0["writer"];
    return $artifact_comment$(($artifact_find$(_xs_0, _id_2)), _xs_0, _used_0, _actor_0, _comment_0, _onVersion_0, _author_2, _writer_2);
  } else {
    const _id_3 = _action_0["id"];
    const _author_3 = _action_0["author"];
    const _writer_3 = _action_0["writer"];
    return $artifact_delete$(($artifact_find$(_xs_0, _id_3)), _xs_0, _used_0, _id_3, _author_3, _writer_3, _actor_0);
  }
}

function $artifact_authorized$(_allowed_0, _index_0, _actor_0, _action_0) {
  if (!_allowed_0) {
    return {$: "ArtifactDenied"};
  } else {
    return $artifact_action$(_index_0, _actor_0, _action_0);
  }
}

function $artifact_apply$(_members_0, _actor_0, _minimum_0, _pending_0, _index_0, _action_0) {
  return $artifact_authorized$(($Bool$and$(($content_write$(($member_access$(($find$(_members_0, _actor_0)), _members_0)), _pending_0)), ($artifact_ready$(_minimum_0)))), _index_0, _actor_0, _action_0);
}

function $blob_stage$(_access_0, _identity_0, _version_0, _pending_0, _epoch_0, _current_0) {
  return $Bool$and$(($server_content$(_access_0, _identity_0, _version_0, _pending_0)), ($Nat$is_eq$(_epoch_0, _current_0)));
}

function $blob_upload$(_allowed_0, _exists_0, _owner_0, _actor_0, _unexpired_0, _available_0) {
  return $Bool$and$(($Bool$and$(($Bool$and$(($Bool$and$(_allowed_0, _exists_0)), ($Nat$is_eq$(_owner_0, _actor_0)))), _unexpired_0)), _available_0);
}

function $blob_reference$(_exists_0, _matches_0, _complete_0, _committed_0, _owner_0, _actor_0, _unexpired_0, _epoch_0, _current_0, _sameArtifact_0) {
  return $Bool$and$(($Bool$and$(($Bool$and$(_exists_0, _matches_0)), _complete_0)), ($Bool$pick$(_committed_0, _sameArtifact_0, ($Bool$and$(($Bool$and$(($Nat$is_eq$(_owner_0, _actor_0)), _unexpired_0)), ($Nat$is_eq$(_epoch_0, _current_0)))))));
}

function $blob_read$(_allowed_0, _live_0, _complete_0) {
  return $Bool$and$(($Bool$and$(_allowed_0, _live_0)), _complete_0);
}

function $blob_collect$(_live_0, _expired_0, _committed_0) {
  return $Bool$and$(($Bool$not$(_live_0)), (_expired_0 || _committed_0));
}

function $blob_reuse$(_target_0, _blob_0) {
  if (_target_0.$ === "None") {
    return false;
  } else {
    const _t_0 = _target_0["value"];
    const _deleted_0 = _t_0["deleted"];
    const _versions_0 = _t_0["versions"];
    return $Bool$and$(($Bool$not$(_deleted_0)), ($artifact_blob_has$(_versions_0, _blob_0)));
  }
}

function $project_ready$(_v_0) {
  return $version_ge$(_v_0, {$: "Version", "major": 0, "minor": 1, "patch": 6});
}

function $project_client$(_client_0, _minimum_0, _control_0, _artifact_0, _project_0) {
  return $Bool$and$(($Bool$and$(($Bool$and$(($Bool$and$(_control_0, _artifact_0)), _project_0)), ($project_ready$(_client_0)))), ($version_ge$(_client_0, _minimum_0)));
}

function $phase_eq$(_a_0, _b_0) {
  if (_a_0.$ === "GettingStarted") {
    if (_b_0.$ === "GettingStarted") {
      return true;
    } else {
      return false;
    }
  } else if (_a_0.$ === "Active") {
    if (_b_0.$ === "Active") {
      return true;
    } else {
      return false;
    }
  } else if (_a_0.$ === "LookingForOthers") {
    if (_b_0.$ === "LookingForOthers") {
      return true;
    } else {
      return false;
    }
  } else {
    if (_b_0.$ === "Archived") {
      return true;
    } else {
      return false;
    }
  }
}

function $project_find$(_xs_0, _id_0) {
  if (_xs_0.$ === "Nil") {
    return {$: "None"};
  } else {
    const _t_0 = _xs_0["head"];
    const _key_0 = _t_0["id"];
    const __0 = _t_0["revision"];
    const __1 = _t_0["phase"];
    const _t_1 = _xs_0["tail"];
    return $Bool$pick$(($Nat$is_eq$(_key_0, _id_0)), {$: "Some", "value": {$: "ProjectInfo", "id": _key_0, "revision": __0, "phase": __1}}, ($project_find$(_t_1, _id_0)));
  }
}

function $project_put$(_xs_0, _value_0) {
  if (_xs_0.$ === "Nil") {
    return {$: "Con", "head": _value_0, "tail": {$: "Nil"}};
  } else {
    const _t_0 = _xs_0["head"];
    const _key_0 = _t_0["id"];
    const __0 = _t_0["revision"];
    const __1 = _t_0["phase"];
    const _t_1 = _xs_0["tail"];
    const _id_0 = _value_0["id"];
    const __2 = _value_0["revision"];
    const __3 = _value_0["phase"];
    return $Bool$pick$(($Nat$is_eq$(_key_0, _id_0)), {$: "Con", "head": {$: "ProjectInfo", "id": _id_0, "revision": __2, "phase": __3}, "tail": _t_1}, {$: "Con", "head": {$: "ProjectInfo", "id": _key_0, "revision": __0, "phase": __1}, "tail": ($project_put$(_t_1, {$: "ProjectInfo", "id": _id_0, "revision": __2, "phase": __3}))});
  }
}

function $pair_find$(_xs_0, _project_0, _person_0) {
  if (_xs_0.$ === "Nil") {
    return {$: "Participation", "project": _project_0, "person": _person_0, "revision": 0, "active": false};
  } else {
    const _t_0 = _xs_0["head"];
    const _key_0 = _t_0["project"];
    const _member_0 = _t_0["person"];
    const __0 = _t_0["revision"];
    const __1 = _t_0["active"];
    const _t_1 = _xs_0["tail"];
    return $Bool$pick$(($Bool$and$(($Nat$is_eq$(_key_0, _project_0)), ($Nat$is_eq$(_member_0, _person_0)))), {$: "Participation", "project": _key_0, "person": _member_0, "revision": __0, "active": __1}, ($pair_find$(_t_1, _project_0, _person_0)));
  }
}

function $pair_put$(_xs_0, _value_0) {
  if (_xs_0.$ === "Nil") {
    return {$: "Con", "head": _value_0, "tail": {$: "Nil"}};
  } else {
    const _t_0 = _xs_0["head"];
    const _key_0 = _t_0["project"];
    const _member_0 = _t_0["person"];
    const __0 = _t_0["revision"];
    const __1 = _t_0["active"];
    const _t_1 = _xs_0["tail"];
    const _project_0 = _value_0["project"];
    const _person_0 = _value_0["person"];
    const __2 = _value_0["revision"];
    const __3 = _value_0["active"];
    return $Bool$pick$(($Bool$and$(($Nat$is_eq$(_key_0, _project_0)), ($Nat$is_eq$(_member_0, _person_0)))), {$: "Con", "head": {$: "Participation", "project": _project_0, "person": _person_0, "revision": __2, "active": __3}, "tail": _t_1}, {$: "Con", "head": {$: "Participation", "project": _key_0, "person": _member_0, "revision": __0, "active": __1}, "tail": ($pair_put$(_t_1, {$: "Participation", "project": _project_0, "person": _person_0, "revision": __2, "active": __3}))});
  }
}

function $placement_find$(_xs_0, _id_0) {
  if (_xs_0.$ === "Nil") {
    return {$: "Placement", "artifact": _id_0, "project": 0, "revision": 0};
  } else {
    const _t_0 = _xs_0["head"];
    const _key_0 = _t_0["artifact"];
    const __0 = _t_0["project"];
    const __1 = _t_0["revision"];
    const _t_1 = _xs_0["tail"];
    return $Bool$pick$(($Nat$is_eq$(_key_0, _id_0)), {$: "Placement", "artifact": _key_0, "project": __0, "revision": __1}, ($placement_find$(_t_1, _id_0)));
  }
}

function $placement_put$(_xs_0, _value_0) {
  if (_xs_0.$ === "Nil") {
    return {$: "Con", "head": _value_0, "tail": {$: "Nil"}};
  } else {
    const _t_0 = _xs_0["head"];
    const _key_0 = _t_0["artifact"];
    const __0 = _t_0["project"];
    const __1 = _t_0["revision"];
    const _t_1 = _xs_0["tail"];
    const _id_0 = _value_0["artifact"];
    const __2 = _value_0["project"];
    const __3 = _value_0["revision"];
    return $Bool$pick$(($Nat$is_eq$(_key_0, _id_0)), {$: "Con", "head": {$: "Placement", "artifact": _id_0, "project": __2, "revision": __3}, "tail": _t_1}, {$: "Con", "head": {$: "Placement", "artifact": _key_0, "project": __0, "revision": __1}, "tail": ($placement_put$(_t_1, {$: "Placement", "artifact": _id_0, "project": __2, "revision": __3}))});
  }
}

function $project_exists$(_target_0) {
  if (_target_0.$ === "None") {
    return false;
  } else {
    return true;
  }
}

function $pair_active$(_p_0) {
  const _active_0 = _p_0["active"];
  return _active_0;
}

function $project_person$(_target_0, _pairs_0, _project_0) {
  if (_target_0.$ === "None") {
    return false;
  } else {
    const _t_0 = _target_0["value"];
    const _id_0 = _t_0["id"];
    const _t_1 = _t_0["kind"];
    if (_t_1.$ === "Agent") {
      const _owner_0 = _t_0["owner"];
      const _live_0 = _t_0["live"];
      return $Bool$and$(_live_0, ($pair_active$(($pair_find$(_pairs_0, _project_0, _owner_0)))));
    } else {
      const _live_1 = _t_0["live"];
      return $Bool$and$(_live_1, ($pair_active$(($pair_find$(_pairs_0, _project_0, _id_0)))));
    }
  }
}

function $project_follower$(_target_0, _members_0, _pairs_0, _project_0) {
  if (_target_0.$ === "None") {
    return false;
  } else {
    const _t_0 = _target_0["value"];
    const _id_0 = _t_0["id"];
    const _t_1 = _t_0["kind"];
    if (_t_1.$ === "Person") {
      const _live_0 = _t_0["live"];
      return $Bool$and$(_live_0, ($pair_active$(($pair_find$(_pairs_0, _project_0, _id_0)))));
    } else {
      const _owner_1 = _t_0["owner"];
      const _live_1 = _t_0["live"];
      return $Bool$and$(_live_1, ($project_person$(($live_person$(($find$(_members_0, _owner_1)), _live_1)), _pairs_0, _project_0)));
    }
  }
}

function $project_participant$(_members_0, _pairs_0, _project_0, _actor_0) {
  return $project_follower$(($find$(_members_0, _actor_0)), _members_0, _pairs_0, _project_0);
}

function $project_remove$(_xs_0, _person_0, _revision_0) {
  if (_xs_0.$ === "Nil") {
    return {$: "Nil"};
  } else {
    const _t_0 = _xs_0["head"];
    const _project_0 = _t_0["project"];
    const _member_0 = _t_0["person"];
    const _old_0 = _t_0["revision"];
    const _active_0 = _t_0["active"];
    const _t_1 = _xs_0["tail"];
    return {$: "Con", "head": {$: "Participation", "project": _project_0, "person": _member_0, "revision": ($Bool$pick$(($Bool$and$(_active_0, ($Nat$is_eq$(_member_0, _person_0)))), _revision_0, _old_0)), "active": ($Bool$and$(_active_0, ($Bool$not$(($Nat$is_eq$(_member_0, _person_0))))))}, "tail": ($project_remove$(_t_1, _person_0, _revision_0))};
  }
}

function $project_guard$(_valid_0, _index_0) {
  if (!_valid_0) {
    return {$: "ProjectConflict"};
  } else {
    return {$: "ProjectAccepted", "index": _index_0};
  }
}

function $project_metadata$(_target_0, _items_0, _pairs_0, _placements_0, _predecessor_0, _revision_0, _phase_0) {
  if (_target_0.$ === "None") {
    return {$: "ProjectConflict"};
  } else {
    const _t_0 = _target_0["value"];
    const _id_0 = _t_0["id"];
    const _old_0 = _t_0["revision"];
    const _previous_0 = _t_0["phase"];
    if (_phase_0.$ === "None") {
      return $project_guard$(($Nat$is_eq$(_old_0, _predecessor_0)), {$: "ProjectIndex", "items": ($project_put$(_items_0, {$: "ProjectInfo", "id": _id_0, "revision": _revision_0, "phase": _previous_0})), "pairs": _pairs_0, "placements": _placements_0});
    } else {
      const _next_0 = _phase_0["value"];
      return $project_guard$(($Bool$and$(($Nat$is_eq$(_old_0, _predecessor_0)), ($Bool$not$(($phase_eq$(_previous_0, _next_0)))))), {$: "ProjectIndex", "items": ($project_put$(_items_0, {$: "ProjectInfo", "id": _id_0, "revision": _revision_0, "phase": _next_0})), "pairs": _pairs_0, "placements": _placements_0});
    }
  }
}

function $project_membership_pair$(_pair_0, _items_0, _pairs_0, _placements_0, _id_0, _member_0, _predecessor_0, _revision_0, _active_0) {
  const _old_0 = _pair_0["revision"];
  const _before_0 = _pair_0["active"];
  return $project_guard$(($Bool$and$(($Bool$and$(($project_exists$(($project_find$(_items_0, _id_0)))), ($Nat$is_eq$(_old_0, _predecessor_0)))), ($Bool$pick$(_active_0, ($Bool$not$(_before_0)), _before_0)))), {$: "ProjectIndex", "items": _items_0, "pairs": ($pair_put$(_pairs_0, {$: "Participation", "project": _id_0, "person": _member_0, "revision": _revision_0, "active": _active_0})), "placements": _placements_0});
}

function $project_membership$(_items_0, _pairs_0, _placements_0, _id_0, _member_0, _predecessor_0, _revision_0, _active_0) {
  return $project_membership_pair$(($pair_find$(_pairs_0, _id_0, _member_0)), _items_0, _pairs_0, _placements_0, _id_0, _member_0, _predecessor_0, _revision_0, _active_0);
}

function $project_placement_value$(_value_0, _target_0, _items_0, _pairs_0, _placements_0, _id_0, _project_0, _author_0, _writer_0, _actor_0, _predecessor_0, _revision_0) {
  const _previous_0 = _value_0["project"];
  const _old_0 = _value_0["revision"];
  if (_target_0.$ === "None") {
    return {$: "ProjectConflict"};
  } else {
    const _t_0 = _target_0["value"];
    const _creator_0 = _t_0["author"];
    const _deleted_0 = _t_0["deleted"];
    const _x_0 = ($Nat$is_eq$(_project_0, 0));
    const _x_1 = ($project_exists$(($project_find$(_items_0, _project_0))));
    return $project_guard$(($Bool$and$(($Bool$and$(($Bool$and$(($Bool$and$(($Bool$and$(($Bool$not$(_deleted_0)), ($Nat$is_eq$(_author_0, _creator_0)))), ($Nat$is_eq$(_writer_0, _actor_0)))), ($Nat$is_eq$(_old_0, _predecessor_0)))), ($Bool$not$(($Nat$is_eq$(_previous_0, _project_0)))))), (_x_0 || _x_1))), {$: "ProjectIndex", "items": _items_0, "pairs": _pairs_0, "placements": ($placement_put$(_placements_0, {$: "Placement", "artifact": _id_0, "project": _project_0, "revision": _revision_0}))});
  }
}

function $project_placement$(_target_0, _items_0, _pairs_0, _placements_0, _id_0, _project_0, _author_0, _writer_0, _actor_0, _predecessor_0, _revision_0) {
  return $project_placement_value$(($placement_find$(_placements_0, _id_0)), _target_0, _items_0, _pairs_0, _placements_0, _id_0, _project_0, _author_0, _writer_0, _actor_0, _predecessor_0, _revision_0);
}

function $project_self_person$(_person_0, _member_0) {
  if (_person_0.$ === "None") {
    return false;
  } else {
    const _t_0 = _person_0["value"];
    const _id_0 = _t_0["id"];
    return $Nat$is_eq$(_id_0, _member_0);
  }
}

function $project_self$(_members_0, _actor_0, _member_0) {
  return $project_self_person$(($authority_person$(($find$(_members_0, _actor_0)), _members_0)), _member_0);
}

function $project_authority$(_members_0, _actor_0, _pairs_0, _pending_0, _action_0) {
  if (_action_0.$ === "ProjectCreate") {
    return $content_write$(($member_access$(($find$(_members_0, _actor_0)), _members_0)), _pending_0);
  } else if (_action_0.$ === "ArtifactProject") {
    return $content_write$(($member_access$(($find$(_members_0, _actor_0)), _members_0)), _pending_0);
  } else if (_action_0.$ === "ProjectJoin") {
    const _member_0 = _action_0["member"];
    return $project_self$(_members_0, _actor_0, _member_0);
  } else if (_action_0.$ === "ProjectLeave") {
    const _member_1 = _action_0["member"];
    return $project_self$(_members_0, _actor_0, _member_1);
  } else if (_action_0.$ === "ProjectPurpose") {
    const _id_0 = _action_0["id"];
    return $project_participant$(_members_0, _pairs_0, _id_0, _actor_0);
  } else {
    const _id_1 = _action_0["id"];
    return $project_participant$(_members_0, _pairs_0, _id_1, _actor_0);
  }
}

function $project_action$(_index_0, _artifacts_0, _actor_0, _revision_0, _action_0) {
  const _items_0 = _index_0["items"];
  const _pairs_0 = _index_0["pairs"];
  const _placements_0 = _index_0["placements"];
  const _content_0 = _artifacts_0["items"];
  const _used_0 = _artifacts_0["used"];
  if (_action_0.$ === "ProjectCreate") {
    const _id_0 = _action_0["id"];
    const _x_0 = ($project_exists$(($project_find$(_items_0, _id_0))));
    const _x_1 = ($nat_has$(_used_0, _id_0));
    return $project_guard$(($Bool$not$((_x_0 || _x_1))), {$: "ProjectIndex", "items": {$: "Con", "head": {$: "ProjectInfo", "id": _id_0, "revision": _revision_0, "phase": {$: "GettingStarted"}}, "tail": _items_0}, "pairs": _pairs_0, "placements": _placements_0});
  } else if (_action_0.$ === "ProjectPurpose") {
    const _id_1 = _action_0["id"];
    const _predecessor_0 = _action_0["predecessor"];
    return $project_metadata$(($project_find$(_items_0, _id_1)), _items_0, _pairs_0, _placements_0, _predecessor_0, _revision_0, {$: "None"});
  } else if (_action_0.$ === "ProjectStateChange") {
    const _id_2 = _action_0["id"];
    const _predecessor_1 = _action_0["predecessor"];
    const _phase_0 = _action_0["phase"];
    return $project_metadata$(($project_find$(_items_0, _id_2)), _items_0, _pairs_0, _placements_0, _predecessor_1, _revision_0, {$: "Some", "value": _phase_0});
  } else if (_action_0.$ === "ProjectJoin") {
    const _id_3 = _action_0["id"];
    const _member_0 = _action_0["member"];
    const _predecessor_2 = _action_0["predecessor"];
    return $project_membership$(_items_0, _pairs_0, _placements_0, _id_3, _member_0, _predecessor_2, _revision_0, true);
  } else if (_action_0.$ === "ProjectLeave") {
    const _id_4 = _action_0["id"];
    const _member_1 = _action_0["member"];
    const _predecessor_3 = _action_0["predecessor"];
    return $project_membership$(_items_0, _pairs_0, _placements_0, _id_4, _member_1, _predecessor_3, _revision_0, false);
  } else {
    const _id_5 = _action_0["id"];
    const _project_0 = _action_0["project"];
    const _author_0 = _action_0["author"];
    const _writer_0 = _action_0["writer"];
    const _predecessor_4 = _action_0["predecessor"];
    return $project_placement$(($artifact_find$(_content_0, _id_5)), _items_0, _pairs_0, _placements_0, _id_5, _project_0, _author_0, _writer_0, _actor_0, _predecessor_4, _revision_0);
  }
}

function $project_previous$(_action_0, _revision_0) {
  if (_action_0.$ === "ProjectCreate") {
    return true;
  } else if (_action_0.$ === "ProjectPurpose") {
    const _predecessor_0 = _action_0["predecessor"];
    return (_predecessor_0 < _revision_0);
  } else if (_action_0.$ === "ProjectStateChange") {
    const _predecessor_1 = _action_0["predecessor"];
    return (_predecessor_1 < _revision_0);
  } else if (_action_0.$ === "ProjectJoin") {
    const _predecessor_2 = _action_0["predecessor"];
    return (_predecessor_2 < _revision_0);
  } else if (_action_0.$ === "ProjectLeave") {
    const _predecessor_3 = _action_0["predecessor"];
    return (_predecessor_3 < _revision_0);
  } else {
    const _predecessor_4 = _action_0["predecessor"];
    return (_predecessor_4 < _revision_0);
  }
}

function $project_authorized$(_allowed_0, _index_0, _artifacts_0, _actor_0, _revision_0, _action_0) {
  if (!_allowed_0) {
    return {$: "ProjectDenied"};
  } else {
    return $project_action$(_index_0, _artifacts_0, _actor_0, _revision_0, _action_0);
  }
}

function $project_apply$(_members_0, _actor_0, _minimum_0, _pending_0, _index_0, _artifacts_0, _revision_0, _action_0) {
  const __0 = _index_0["items"];
  const _pairs_0 = _index_0["pairs"];
  const __1 = _index_0["placements"];
  return $project_authorized$(($Bool$and$(($Bool$and$(($project_ready$(_minimum_0)), ($project_previous$(_action_0, _revision_0)))), ($project_authority$(_members_0, _actor_0, _pairs_0, _pending_0, _action_0)))), {$: "ProjectIndex", "items": __0, "pairs": _pairs_0, "placements": __1}, _artifacts_0, _actor_0, _revision_0, _action_0);
}

function $project_selector$(_items_0, _selector_0) {
  const _x_0 = ($Nat$is_eq$(_selector_0, 0));
  const _x_1 = ($Nat$is_eq$(_selector_0, 1));
  const _x_2 = (_x_0 || _x_1);
  const _x_3 = ($project_exists$(($project_find$(_items_0, _selector_0))));
  return (_x_2 || _x_3);
}

function $project_selected_value$(_value_0, _target_0, _placements_0, _selector_0, _id_0) {
  const _project_0 = _value_0["project"];
  if (_target_0.$ === "None") {
    return false;
  } else {
    const _t_0 = _target_0["value"];
    const _deleted_0 = _t_0["deleted"];
    const _x_0 = ($Nat$is_eq$(_selector_0, 1));
    const _x_1 = ($Nat$is_eq$(_selector_0, _project_0));
    return $Bool$and$(($Bool$not$(_deleted_0)), (_x_0 || _x_1));
  }
}

function $project_selected$(_target_0, _placements_0, _selector_0, _id_0) {
  return $project_selected_value$(($placement_find$(_placements_0, _id_0)), _target_0, _placements_0, _selector_0, _id_0);
}

function $private_ready$(_v_0) {
  return $version_ge$(_v_0, {$: "Version", "major": 0, "minor": 1, "patch": 7});
}

function $private_client$(_version_0, _minimum_0, _control_0, _artifact_0, _project_0, _private_0) {
  return $Bool$and$(($Bool$and$(($Bool$and$(($Bool$and$(($Bool$and$(_control_0, _artifact_0)), _project_0)), _private_0)), ($private_ready$(_version_0)))), ($version_ge$(_version_0, _minimum_0)));
}

function $private_credential$(_kind_0, _value_0) {
  if (_kind_0.$ === "Person") {
    if (_value_0.$ === "PrivatePersonCredential") {
      return true;
    } else {
      return false;
    }
  } else {
    if (_value_0.$ === "PrivateAuthenticatedAgent") {
      return true;
    } else {
      return false;
    }
  }
}

function $private_related_kind$(_kind_0, _id_0, _key_0, _actorKind_0, _owner_0) {
  if (_kind_0.$ === "Agent") {
    return $Nat$is_eq$(_id_0, _key_0);
  } else {
    const _x_0 = ($Nat$is_eq$(_id_0, _key_0));
    const _x_1 = ($owned_agent$(_actorKind_0, _owner_0, _id_0));
    return (_x_0 || _x_1);
  }
}

function $private_related_actor$(_kind_0, _id_0, _live_0, _actor_0) {
  if (_actor_0.$ === "None") {
    return false;
  } else {
    const _t_0 = _actor_0["value"];
    const _key_0 = _t_0["id"];
    const _actorKind_0 = _t_0["kind"];
    const _owner_0 = _t_0["owner"];
    const _actorLive_0 = _t_0["live"];
    return $Bool$and$(($Bool$and$(_live_0, _actorLive_0)), ($private_related_kind$(_kind_0, _id_0, _key_0, _actorKind_0, _owner_0)));
  }
}

function $private_relation$(_author_0, _actor_0) {
  if (_author_0.$ === "None") {
    return false;
  } else {
    const _t_0 = _author_0["value"];
    const _id_0 = _t_0["id"];
    const _kind_0 = _t_0["kind"];
    const _live_0 = _t_0["live"];
    return $private_related_actor$(_kind_0, _id_0, _live_0, _actor_0);
  }
}

function $private_audience_value$(_members_0, _author_0, _actor_0, _value_0) {
  if (_actor_0.$ === "None") {
    return false;
  } else {
    const _t_0 = _actor_0["value"];
    const __0 = _t_0["id"];
    const _kind_0 = _t_0["kind"];
    const __1 = _t_0["role"];
    const __2 = _t_0["guide"];
    const __3 = _t_0["owner"];
    const __4 = _t_0["support"];
    const __5 = _t_0["live"];
    return $Bool$and$(($private_credential$(_kind_0, _value_0)), ($private_relation$(($authority_person$(_author_0, _members_0)), ($authority_person$({$: "Some", "value": {$: "Member", "id": __0, "kind": _kind_0, "role": __1, "guide": __2, "owner": __3, "support": __4, "live": __5}}, _members_0)))));
  }
}

function $private_audience$(_members_0, _author_0, _actor_0, _value_0) {
  return $private_audience_value$(_members_0, ($find$(_members_0, _author_0)), ($find$(_members_0, _actor_0)), _value_0);
}

function $private_link_read$(_members_0, _actor_0) {
  return $Bool$and$(($access_read$(($member_access$(($find$(_members_0, _actor_0)), _members_0)))), ($Bool$not$(($private_audience$(_members_0, _actor_0, _actor_0, {$: "PrivateLinkCredential"})))));
}

function $private_write$(_members_0, _author_0, _actor_0, _value_0, _minimum_0, _pending_0, _current_0) {
  return $Bool$and$(($Bool$and$(($Bool$and$(_current_0, ($private_ready$(_minimum_0)))), ($private_audience$(_members_0, _author_0, _actor_0, _value_0)))), ($content_write$(($member_access$(($find$(_members_0, _actor_0)), _members_0)), _pending_0)));
}

function $private_wrap_access$(_members_0, _author_0, _actor_0, _target_0, _value_0, _write_0) {
  const _x_0 = ($private_audience$(_members_0, _author_0, _target_0, {$: "PrivatePersonCredential"}));
  const _x_1 = ($private_audience$(_members_0, _author_0, _target_0, {$: "PrivateAuthenticatedAgent"}));
  return $Bool$and$(($private_audience$(_members_0, _author_0, _actor_0, _value_0)), (_x_0 || _x_1));
}

function $private_copy_access$(_source_0, _destination_0, _different_0, _visibility_0) {
  return $Bool$and$(($Bool$and$(_source_0, _destination_0)), _different_0);
}

function $private_guard$(_valid_0, _value_0) {
  if (_valid_0) {
    return {$: "PrivateAccepted", "value": _value_0};
  } else {
    return {$: "PrivateConflict"};
  }
}

function $private_same$(_artifact_0, _author_0, _writer_0, _id_0, _creator_0, _actor_0) {
  return $Bool$and$(($Bool$and$(($Nat$is_eq$(_artifact_0, _id_0)), ($Nat$is_eq$(_author_0, _creator_0)))), ($Nat$is_eq$(_writer_0, _actor_0)));
}

function $private_action$(_value_0, _actor_0, _record_0, _next_0, _projects_0) {
  const _id_0 = _value_0["id"];
  const _artifact_0 = _value_0["artifact"];
  const _author_0 = _value_0["author"];
  const _journey_0 = _value_0["journey"];
  const _head_0 = _value_0["head"];
  const _seq_0 = _value_0["seq"];
  const _deleted_0 = _value_0["deleted"];
  const _versions_0 = _value_0["versions"];
  const _used_0 = _value_0["used"];
  const _project_0 = _value_0["project"];
  const _placement_0 = _value_0["placement"];
  const _kind_0 = _value_0["typeHash"];
  if (_next_0.$ === "PrivateCreate") {
    return {$: "PrivateConflict"};
  } else if (_next_0.$ === "PrivateEdit") {
    const _target_0 = _next_0["artifact"];
    const _creator_0 = _next_0["author"];
    const _writer_0 = _next_0["writer"];
    const _version_0 = _next_0["version"];
    const _typeHash_0 = _next_0["typeHash"];
    const _predecessor_0 = _next_0["predecessor"];
    const _blobs_0 = _next_0["blobs"];
    const _x_0 = ($nat_has$(_used_0, _version_0));
    return $private_guard$(($Bool$and$(($Bool$and$(($Bool$and$(($Bool$not$((_deleted_0 || _x_0))), ($private_same$(_target_0, _creator_0, _writer_0, _artifact_0, _author_0, _actor_0)))), ($Nat$is_eq$(_kind_0, _typeHash_0)))), ($Nat$is_eq$(_head_0, _predecessor_0)))), {$: "PrivateCopy", "id": _id_0, "artifact": _artifact_0, "author": _author_0, "journey": _journey_0, "head": _version_0, "record": _record_0, "seq": nat_chk(_seq_0 + 1), "deleted": false, "versions": {$: "Con", "head": {$: "ArtifactVersion", "id": _version_0, "writer": _actor_0, "blobs": _blobs_0}, "tail": _versions_0}, "used": {$: "Con", "head": _version_0, "tail": _used_0}, "project": _project_0, "placement": _placement_0, "typeHash": _kind_0});
  } else if (_next_0.$ === "PrivateComment") {
    const _target_1 = _next_0["artifact"];
    const _creator_1 = _next_0["author"];
    const _writer_1 = _next_0["writer"];
    const _comment_0 = _next_0["comment"];
    const _context_0 = _next_0["context"];
    const _x_1 = ($nat_has$(_used_0, _comment_0));
    const _x_2 = ($Nat$is_eq$(_context_0, 0));
    const _x_3 = ($artifact_version_has$(_versions_0, _context_0));
    return $private_guard$(($Bool$and$(($Bool$and$(($Bool$not$((_deleted_0 || _x_1))), ($private_same$(_target_1, _creator_1, _writer_1, _artifact_0, _author_0, _actor_0)))), (_x_2 || _x_3))), {$: "PrivateCopy", "id": _id_0, "artifact": _artifact_0, "author": _author_0, "journey": _journey_0, "head": _head_0, "record": _record_0, "seq": nat_chk(_seq_0 + 1), "deleted": false, "versions": _versions_0, "used": {$: "Con", "head": _comment_0, "tail": _used_0}, "project": _project_0, "placement": _placement_0, "typeHash": _kind_0});
  } else if (_next_0.$ === "PrivateDelete") {
    const _target_2 = _next_0["artifact"];
    const _creator_2 = _next_0["author"];
    const _writer_2 = _next_0["writer"];
    const _predecessor_1 = _next_0["predecessor"];
    return $private_guard$(($Bool$and$(($Bool$and$(($Bool$not$(_deleted_0)), ($private_same$(_target_2, _creator_2, _writer_2, _artifact_0, _author_0, _actor_0)))), ($Nat$is_eq$(_head_0, _predecessor_1)))), {$: "PrivateCopy", "id": _id_0, "artifact": _artifact_0, "author": _author_0, "journey": _journey_0, "head": _head_0, "record": _record_0, "seq": nat_chk(_seq_0 + 1), "deleted": true, "versions": _versions_0, "used": _used_0, "project": _project_0, "placement": _placement_0, "typeHash": _kind_0});
  } else {
    const _target_3 = _next_0["artifact"];
    const _creator_3 = _next_0["author"];
    const _writer_3 = _next_0["writer"];
    const _destination_0 = _next_0["project"];
    const _predecessor_2 = _next_0["predecessor"];
    const _x_4 = ($Nat$is_eq$(_destination_0, 0));
    const _x_5 = ($project_exists$(($project_find$(_projects_0, _destination_0))));
    return $private_guard$(($Bool$and$(($Bool$and$(($Bool$and$(($Bool$and$(($Bool$not$(_deleted_0)), ($private_same$(_target_3, _creator_3, _writer_3, _artifact_0, _author_0, _actor_0)))), ($Nat$is_eq$(_placement_0, _predecessor_2)))), ($Bool$not$(($Nat$is_eq$(_project_0, _destination_0)))))), (_x_4 || _x_5))), {$: "PrivateCopy", "id": _id_0, "artifact": _artifact_0, "author": _author_0, "journey": _journey_0, "head": _head_0, "record": _record_0, "seq": nat_chk(_seq_0 + 1), "deleted": false, "versions": _versions_0, "used": _used_0, "project": _destination_0, "placement": _record_0, "typeHash": _kind_0});
  }
}

function $private_first$(_id_0, _actor_0, _record_0, _next_0) {
  if (_next_0.$ === "PrivateCreate") {
    const _artifact_0 = _next_0["artifact"];
    const _author_0 = _next_0["author"];
    const _writer_0 = _next_0["writer"];
    const _journey_0 = _next_0["journey"];
    const _version_0 = _next_0["version"];
    const _typeHash_0 = _next_0["typeHash"];
    const _blobs_0 = _next_0["blobs"];
    return $private_guard$(($Nat$is_eq$(_writer_0, _actor_0)), {$: "PrivateCopy", "id": _id_0, "artifact": _artifact_0, "author": _author_0, "journey": _journey_0, "head": _version_0, "record": _record_0, "seq": 0, "deleted": false, "versions": {$: "Con", "head": {$: "ArtifactVersion", "id": _version_0, "writer": _actor_0, "blobs": _blobs_0}, "tail": {$: "Nil"}}, "used": {$: "Con", "head": _version_0, "tail": {$: "Nil"}}, "project": 0, "placement": 0, "typeHash": _typeHash_0});
  } else {
    return {$: "PrivateConflict"};
  }
}

function $private_position$(_value_0, _seq_0, _previous_0) {
  if (_value_0.$ === "None") {
    return $Bool$and$(($Nat$is_eq$(_seq_0, 0)), ($Nat$is_eq$(_previous_0, 0)));
  } else {
    const _t_0 = _value_0["value"];
    const _head_0 = _t_0["record"];
    const _old_0 = _t_0["seq"];
    return $Bool$and$(($Nat$is_eq$(_seq_0, nat_chk(_old_0 + 1))), ($Nat$is_eq$(_previous_0, _head_0)));
  }
}

function $private_step$(_value_0, _id_0, _actor_0, _record_0, _next_0, _projects_0) {
  if (_value_0.$ === "None") {
    return $private_first$(_id_0, _actor_0, _record_0, _next_0);
  } else {
    const _old_0 = _value_0["value"];
    return $private_action$(_old_0, _actor_0, _record_0, _next_0, _projects_0);
  }
}

function $private_checked$(_allowed_0, _positioned_0, _value_0, _id_0, _actor_0, _record_0, _next_0, _projects_0) {
  if (!_allowed_0) {
    return {$: "PrivateDenied"};
  } else {
    if (!_positioned_0) {
      return {$: "PrivateConflict"};
    } else {
      return $private_step$(_value_0, _id_0, _actor_0, _record_0, _next_0, _projects_0);
    }
  }
}

function $private_apply$(_allowed_0, _value_0, _id_0, _actor_0, _record_0, _seq_0, _previous_0, _next_0, _projects_0) {
  return $private_checked$(_allowed_0, ($private_position$(_value_0, _seq_0, _previous_0)), _value_0, _id_0, _actor_0, _record_0, _next_0, _projects_0);
}

function $private_bundle_recipient$(_scope_0, _kind_0, _same_0) {
  if (_scope_0.$ === "PrivateBackup") {
    return _same_0;
  } else if (_scope_0.$ === "PrivateReturn") {
    return _same_0;
  } else {
    return true;
  }
}

function $private_origin_version$(_current_0, _observed_0) {
  return $Nat$is_eq$(_current_0, _observed_0);
}

function $private_authority_snapshot$(_journey_0, _head_0, _otherJourney_0, _otherHead_0) {
  return $Bool$and$(($Nat$is_eq$(_journey_0, _otherJourney_0)), ($Nat$is_eq$(_head_0, _otherHead_0)));
}

function $private_copied$(_source_0, _id_0, _actor_0, _record_0, _journey_0, _version_0, _blobs_0, _observed_0, _fresh_0, _allowed_0) {
  const _sourceId_0 = _source_0["id"];
  const _artifact_0 = _source_0["artifact"];
  const _author_0 = _source_0["author"];
  const _sourceJourney_0 = _source_0["journey"];
  const _head_0 = _source_0["record"];
  const _deleted_0 = _source_0["deleted"];
  const _kind_0 = _source_0["typeHash"];
  const _x_0 = ($Nat$is_eq$(_sourceJourney_0, _journey_0));
  return $private_guard$(($Bool$and$(($Bool$and$(($Bool$and$(($Bool$and$(_allowed_0, _fresh_0)), ($Bool$not$(($Nat$is_eq$(_sourceId_0, _id_0)))))), ($Bool$not$((_deleted_0 || _x_0))))), ($Nat$is_eq$(_head_0, _observed_0)))), {$: "PrivateCopy", "id": _id_0, "artifact": _artifact_0, "author": _author_0, "journey": _journey_0, "head": _version_0, "record": _record_0, "seq": 0, "deleted": false, "versions": {$: "Con", "head": {$: "ArtifactVersion", "id": _version_0, "writer": _actor_0, "blobs": _blobs_0}, "tail": {$: "Nil"}}, "used": {$: "Con", "head": _version_0, "tail": {$: "Nil"}}, "project": 0, "placement": 0, "typeHash": _kind_0});
}

function $private_selected$(_value_0, _selector_0, _allowed_0) {
  const _deleted_0 = _value_0["deleted"];
  const _project_0 = _value_0["project"];
  const _x_0 = ($Nat$is_eq$(_selector_0, 1));
  const _x_1 = ($Nat$is_eq$(_selector_0, _project_0));
  return $Bool$and$(($Bool$and$(_allowed_0, ($Bool$not$(_deleted_0)))), (_x_0 || _x_1));
}

function $private_references$(_own_0, _complete_0, _digest_0, _staged_0) {
  return $Bool$and$(($Bool$and$(($Bool$and$(_own_0, _complete_0)), _digest_0)), _staged_0);
}

function $private_header$(_retained_0, _incoming_0, _private_same_0, _predecessor_0, _paired_0) {
  if (_retained_0 === 0) {
    return $Bool$pick$(_predecessor_0, ($Bool$pick$(_paired_0, {$: "PrivateVerifiedFreshness"}, {$: "PrivateUnverifiedFreshness"})), {$: "PrivateHeaderConflict"});
  } else {
    const _retained_1 = (_retained_0 - 0);
    return $Bool$pick$((_incoming_0 < _retained_1), {$: "PrivateRollback"}, ($Bool$pick$(_predecessor_0, ($Bool$pick$(($Bool$and$(($Nat$is_eq$(_incoming_0, _retained_1)), ($Bool$not$(_private_same_0)))), {$: "PrivateMergeRequired"}, ($Bool$pick$(_paired_0, {$: "PrivateVerifiedFreshness"}, {$: "PrivateUnverifiedFreshness"})))), {$: "PrivateHeaderConflict"})));
  }
}

function $private_merge$(_left_0, _right_0, _leftDeleted_0, _rightDeleted_0, _private_same_0) {
  const _x_0 = (_right_0 < _left_0);
  return $Bool$pick$((_leftDeleted_0 || _rightDeleted_0), {$: "PrivateTombstone"}, ($Bool$pick$((_left_0 < _right_0), {$: "PrivateRight"}, ($Bool$pick$((_x_0 || _private_same_0), {$: "PrivateLeft"}, {$: "PrivateBoth"})))));
}

function $private_capacity$(_bytes_0) {
  return $Bool$not$((67108864 < _bytes_0));
}

function $private_sync_due$(_open_0, _elapsed_0) {
  const _x_0 = ($Bool$not$((_elapsed_0 < 300000)));
  return (_open_0 || _x_0);
}

function $private_slot_take$($0, $1, $2) {
  for (;;) {
    {
      const _xs_0 = $0;
      const _fuel_0 = $1;
      const _selected_0 = $2;
      if (_xs_0.$ === "Nil") {
        return _selected_0;
      } else {
        const _slot_0 = _xs_0["head"];
        const _rest_0 = _xs_0["tail"];
        if (_fuel_0 === 0) {
          return _selected_0;
        } else {
          const _n_0 = (_fuel_0 - 1);
          $0 = _rest_0;
          $1 = ($Bool$pick$(($Bool$and$((_slot_0 < 64), ($Bool$not$(($nat_has$(_selected_0, _slot_0)))))), _n_0, nat_chk(_n_0 + 1)));
          $2 = ($Bool$pick$(($Bool$and$((_slot_0 < 64), ($Bool$not$(($nat_has$(_selected_0, _slot_0)))))), {$: "Con", "head": _slot_0, "tail": _selected_0}, _selected_0));
          continue;
        }
      }
    }
  }
}

function $private_slots$(_dirty_0, _randomOrder_0) {
  return $private_slot_take$(($List$append$(_dirty_0, _randomOrder_0)), 2, {$: "Nil"});
}

function $Bool$pick$(_c_0, _a_0, _b_0) {
  if (!_c_0) {
    return _b_0;
  } else {
    return _a_0;
  }
}

function $Nat$is_eq$(_a_0, _b_0) {
  return $Cmp$is_eq$(cmp_new(_a_0, _b_0));
}

function $Bool$and$(_a_0, _b_0) {
  if (!_a_0) {
    return false;
  } else {
    return _b_0;
  }
}

function $Bool$not$(_b_0) {
  if (!_b_0) {
    return true;
  } else {
    return false;
  }
}

function $Nat$is_gt$(_a_0, _b_0) {
  return $Cmp$is_gt$(cmp_new(_a_0, _b_0));
}

function $Nat$is_ge$(_a_0, _b_0) {
  return $Cmp$is_ge$(cmp_new(_a_0, _b_0));
}

function $List$append$(_xs_0, _ys_0) {
  if (_xs_0.$ === "Nil") {
    return _ys_0;
  } else {
    const _h_0 = _xs_0["head"];
    const _t_0 = _xs_0["tail"];
    return {$: "Con", "head": _h_0, "tail": ($List$append$(_t_0, _ys_0))};
  }
}

function $Cmp$is_eq$(_c_0) {
  if (_c_0.$ === "EQ") {
    return true;
  } else {
    return false;
  }
}

function $Cmp$is_gt$(_c_0) {
  if (_c_0.$ === "GT") {
    return true;
  } else {
    return false;
  }
}

function $Cmp$is_ge$(_c_0) {
  if (_c_0.$ === "LT") {
    return false;
  } else {
    return true;
  }
}

function $0m1(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Member": at = at[key] = {...v, "id": nat_host(v["id"]), "owner": nat_host(v["owner"])}; return top[0];
      default: throw "bend: Member has no tag " + v?.$ + " (its tags: Member); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m0(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Nil": at[key] = v; return top[0];
      case "Con": at = at[key] = {...v, "head": $0m1(v["head"])}; key = "tail"; v = v[key]; continue;
      default: throw "bend: List has no tag " + v?.$ + " (its tags: Nil, Con); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m3(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Member": at = at[key] = {...v, "id": BigInt(v["id"]), "owner": BigInt(v["owner"])}; return top[0];
      default: throw "bend: Member has no tag " + v?.$ + " (its tags: Member); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m2(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Nil": at[key] = v; return top[0];
      case "Con": at = at[key] = {...v, "head": $0m3(v["head"])}; key = "tail"; v = v[key]; continue;
      default: throw "bend: List has no tag " + v?.$ + " (its tags: Nil, Con); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m4(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "None": at[key] = v; return top[0];
      case "Some": at = at[key] = {...v, "value": $0m3(v["value"])}; return top[0];
      default: throw "bend: Maybe has no tag " + v?.$ + " (its tags: None, Some); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m5(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "None": at[key] = v; return top[0];
      case "Some": at = at[key] = {...v, "value": $0m1(v["value"])}; return top[0];
      default: throw "bend: Maybe has no tag " + v?.$ + " (its tags: None, Some); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m6(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Accepted": at = at[key] = {...v, "members": $0m2(v["members"])}; return top[0];
      case "Denied": at[key] = v; return top[0];
      case "Invalid": at[key] = v; return top[0];
      case "LastGuide": at[key] = v; return top[0];
      default: throw "bend: Transition has no tag " + v?.$ + " (its tags: Accepted, Denied, Invalid, LastGuide); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m7(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Add": at = at[key] = {...v, "actor": nat_host(v["actor"]), "member": $0m1(v["member"])}; return top[0];
      case "Remove": at = at[key] = {...v, "actor": nat_host(v["actor"]), "target": nat_host(v["target"])}; return top[0];
      case "Guide": at = at[key] = {...v, "actor": nat_host(v["actor"]), "target": nat_host(v["target"])}; return top[0];
      case "RoleChange": at = at[key] = {...v, "actor": nat_host(v["actor"]), "target": nat_host(v["target"])}; return top[0];
      case "Settings": at = at[key] = {...v, "actor": nat_host(v["actor"])}; return top[0];
      case "Profile": at = at[key] = {...v, "actor": nat_host(v["actor"]), "target": nat_host(v["target"])}; return top[0];
      case "Rename": at = at[key] = {...v, "actor": nat_host(v["actor"]), "target": nat_host(v["target"])}; return top[0];
      case "Rotate": at = at[key] = {...v, "actor": nat_host(v["actor"])}; return top[0];
      case "Renew": at = at[key] = {...v, "actor": nat_host(v["actor"]), "target": nat_host(v["target"])}; return top[0];
      default: throw "bend: Control has no tag " + v?.$ + " (its tags: Add, Remove, Guide, RoleChange, Settings, Profile, Rename, Rotate, Renew); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m8(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Add": at = at[key] = {...v, "actor": BigInt(v["actor"]), "member": $0m3(v["member"])}; return top[0];
      case "Remove": at = at[key] = {...v, "actor": BigInt(v["actor"]), "target": BigInt(v["target"])}; return top[0];
      case "Guide": at = at[key] = {...v, "actor": BigInt(v["actor"]), "target": BigInt(v["target"])}; return top[0];
      case "RoleChange": at = at[key] = {...v, "actor": BigInt(v["actor"]), "target": BigInt(v["target"])}; return top[0];
      case "Settings": at = at[key] = {...v, "actor": BigInt(v["actor"])}; return top[0];
      case "Profile": at = at[key] = {...v, "actor": BigInt(v["actor"]), "target": BigInt(v["target"])}; return top[0];
      case "Rename": at = at[key] = {...v, "actor": BigInt(v["actor"]), "target": BigInt(v["target"])}; return top[0];
      case "Rotate": at = at[key] = {...v, "actor": BigInt(v["actor"])}; return top[0];
      case "Renew": at = at[key] = {...v, "actor": BigInt(v["actor"]), "target": BigInt(v["target"])}; return top[0];
      default: throw "bend: Control has no tag " + v?.$ + " (its tags: Add, Remove, Guide, RoleChange, Settings, Profile, Rename, Rotate, Renew); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m9(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Accepted": at = at[key] = {...v, "members": $0m0(v["members"])}; return top[0];
      case "Denied": at[key] = v; return top[0];
      case "Invalid": at[key] = v; return top[0];
      case "LastGuide": at[key] = v; return top[0];
      default: throw "bend: Transition has no tag " + v?.$ + " (its tags: Accepted, Denied, Invalid, LastGuide); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m10(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Nil": at[key] = v; return top[0];
      case "Con": at = at[key] = {...v, "head": $0m7(v["head"])}; key = "tail"; v = v[key]; continue;
      default: throw "bend: List has no tag " + v?.$ + " (its tags: Nil, Con); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m11(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Nil": at[key] = v; return top[0];
      case "Con": at = at[key] = {...v, "head": $0m8(v["head"])}; key = "tail"; v = v[key]; continue;
      default: throw "bend: List has no tag " + v?.$ + " (its tags: Nil, Con); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m13(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Holding": at = at[key] = {...v, "principal": BigInt(v["principal"]), "epoch": BigInt(v["epoch"])}; return top[0];
      default: throw "bend: Holding has no tag " + v?.$ + " (its tags: Holding); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m12(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Nil": at[key] = v; return top[0];
      case "Con": at = at[key] = {...v, "head": $0m13(v["head"])}; key = "tail"; v = v[key]; continue;
      default: throw "bend: List has no tag " + v?.$ + " (its tags: Nil, Con); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m14(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "None": at[key] = v; return top[0];
      case "Some": at = at[key] = {...v, "value": $0m13(v["value"])}; return top[0];
      default: throw "bend: Maybe has no tag " + v?.$ + " (its tags: None, Some); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m15(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Version": at = at[key] = {...v, "major": nat_host(v["major"]), "minor": nat_host(v["minor"]), "patch": nat_host(v["patch"])}; return top[0];
      default: throw "bend: Version has no tag " + v?.$ + " (its tags: Version); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m16(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Version": at = at[key] = {...v, "major": BigInt(v["major"]), "minor": BigInt(v["minor"]), "patch": BigInt(v["patch"])}; return top[0];
      default: throw "bend: Version has no tag " + v?.$ + " (its tags: Version); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m17(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "JourneyState": at = at[key] = {...v, "members": $0m0(v["members"]), "minimum": $0m15(v["minimum"])}; return top[0];
      default: throw "bend: JourneyState has no tag " + v?.$ + " (its tags: JourneyState); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m18(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "JourneyState": at = at[key] = {...v, "members": $0m2(v["members"]), "minimum": $0m16(v["minimum"])}; return top[0];
      default: throw "bend: JourneyState has no tag " + v?.$ + " (its tags: JourneyState); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m19(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "JourneyAccepted": at = at[key] = {...v, "state": $0m18(v["state"])}; return top[0];
      case "JourneyDenied": at[key] = v; return top[0];
      case "JourneyInvalid": at[key] = v; return top[0];
      case "JourneyLastGuide": at[key] = v; return top[0];
      case "UpgradeRequired": at[key] = v; return top[0];
      default: throw "bend: JourneyTransition has no tag " + v?.$ + " (its tags: JourneyAccepted, JourneyDenied, JourneyInvalid, JourneyLastGuide, UpgradeRequired); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m20(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "LegacyControl": at = at[key] = {...v, "control": $0m7(v["control"])}; return top[0];
      case "NewControl": at = at[key] = {...v, "control": $0m7(v["control"])}; return top[0];
      case "Configure": at = at[key] = {...v, "actor": nat_host(v["actor"])}; return top[0];
      case "Minimum": at = at[key] = {...v, "actor": nat_host(v["actor"]), "version": $0m15(v["version"])}; return top[0];
      default: throw "bend: JourneyControl has no tag " + v?.$ + " (its tags: LegacyControl, NewControl, Configure, Minimum); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m21(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "LegacyControl": at = at[key] = {...v, "control": $0m8(v["control"])}; return top[0];
      case "NewControl": at = at[key] = {...v, "control": $0m8(v["control"])}; return top[0];
      case "Configure": at = at[key] = {...v, "actor": BigInt(v["actor"])}; return top[0];
      case "Minimum": at = at[key] = {...v, "actor": BigInt(v["actor"]), "version": $0m16(v["version"])}; return top[0];
      default: throw "bend: JourneyControl has no tag " + v?.$ + " (its tags: LegacyControl, NewControl, Configure, Minimum); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m22(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "JourneyAccepted": at = at[key] = {...v, "state": $0m17(v["state"])}; return top[0];
      case "JourneyDenied": at[key] = v; return top[0];
      case "JourneyInvalid": at[key] = v; return top[0];
      case "JourneyLastGuide": at[key] = v; return top[0];
      case "UpgradeRequired": at[key] = v; return top[0];
      default: throw "bend: JourneyTransition has no tag " + v?.$ + " (its tags: JourneyAccepted, JourneyDenied, JourneyInvalid, JourneyLastGuide, UpgradeRequired); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m23(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Nil": at[key] = v; return top[0];
      case "Con": at = at[key] = {...v, "head": $0m20(v["head"])}; key = "tail"; v = v[key]; continue;
      default: throw "bend: List has no tag " + v?.$ + " (its tags: Nil, Con); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m24(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Nil": at[key] = v; return top[0];
      case "Con": at = at[key] = {...v, "head": $0m21(v["head"])}; key = "tail"; v = v[key]; continue;
      default: throw "bend: List has no tag " + v?.$ + " (its tags: Nil, Con); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m25(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Nil": at[key] = v; return top[0];
      case "Con": at = at[key] = {...v, "head": nat_host(v["head"])}; key = "tail"; v = v[key]; continue;
      default: throw "bend: List has no tag " + v?.$ + " (its tags: Nil, Con); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m26(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Nil": at[key] = v; return top[0];
      case "Con": at = at[key] = {...v, "head": BigInt(v["head"])}; key = "tail"; v = v[key]; continue;
      default: throw "bend: List has no tag " + v?.$ + " (its tags: Nil, Con); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m30(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "ArtifactVersion": at = at[key] = {...v, "id": nat_host(v["id"]), "writer": nat_host(v["writer"]), "blobs": $0m25(v["blobs"])}; return top[0];
      default: throw "bend: ArtifactVersion has no tag " + v?.$ + " (its tags: ArtifactVersion); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m29(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Nil": at[key] = v; return top[0];
      case "Con": at = at[key] = {...v, "head": $0m30(v["head"])}; key = "tail"; v = v[key]; continue;
      default: throw "bend: List has no tag " + v?.$ + " (its tags: Nil, Con); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m28(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Artifact": at = at[key] = {...v, "id": nat_host(v["id"]), "author": nat_host(v["author"]), "typeHash": nat_host(v["typeHash"]), "head": nat_host(v["head"]), "versions": $0m29(v["versions"])}; return top[0];
      default: throw "bend: Artifact has no tag " + v?.$ + " (its tags: Artifact); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m27(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Nil": at[key] = v; return top[0];
      case "Con": at = at[key] = {...v, "head": $0m28(v["head"])}; key = "tail"; v = v[key]; continue;
      default: throw "bend: List has no tag " + v?.$ + " (its tags: Nil, Con); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m34(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "ArtifactVersion": at = at[key] = {...v, "id": BigInt(v["id"]), "writer": BigInt(v["writer"]), "blobs": $0m26(v["blobs"])}; return top[0];
      default: throw "bend: ArtifactVersion has no tag " + v?.$ + " (its tags: ArtifactVersion); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m33(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Nil": at[key] = v; return top[0];
      case "Con": at = at[key] = {...v, "head": $0m34(v["head"])}; key = "tail"; v = v[key]; continue;
      default: throw "bend: List has no tag " + v?.$ + " (its tags: Nil, Con); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m32(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Artifact": at = at[key] = {...v, "id": BigInt(v["id"]), "author": BigInt(v["author"]), "typeHash": BigInt(v["typeHash"]), "head": BigInt(v["head"]), "versions": $0m33(v["versions"])}; return top[0];
      default: throw "bend: Artifact has no tag " + v?.$ + " (its tags: Artifact); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m31(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Nil": at[key] = v; return top[0];
      case "Con": at = at[key] = {...v, "head": $0m32(v["head"])}; key = "tail"; v = v[key]; continue;
      default: throw "bend: List has no tag " + v?.$ + " (its tags: Nil, Con); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m35(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "None": at[key] = v; return top[0];
      case "Some": at = at[key] = {...v, "value": $0m32(v["value"])}; return top[0];
      default: throw "bend: Maybe has no tag " + v?.$ + " (its tags: None, Some); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m36(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "ArtifactIndex": at = at[key] = {...v, "items": $0m27(v["items"]), "used": $0m25(v["used"])}; return top[0];
      default: throw "bend: ArtifactIndex has no tag " + v?.$ + " (its tags: ArtifactIndex); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m37(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "ArtifactIndex": at = at[key] = {...v, "items": $0m31(v["items"]), "used": $0m26(v["used"])}; return top[0];
      default: throw "bend: ArtifactIndex has no tag " + v?.$ + " (its tags: ArtifactIndex); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m38(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "ArtifactAccepted": at = at[key] = {...v, "index": $0m37(v["index"])}; return top[0];
      case "ArtifactDenied": at[key] = v; return top[0];
      case "ArtifactConflict": at[key] = v; return top[0];
      default: throw "bend: ArtifactTransition has no tag " + v?.$ + " (its tags: ArtifactAccepted, ArtifactDenied, ArtifactConflict); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m39(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "None": at[key] = v; return top[0];
      case "Some": at = at[key] = {...v, "value": $0m28(v["value"])}; return top[0];
      default: throw "bend: Maybe has no tag " + v?.$ + " (its tags: None, Some); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m40(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "ArtifactCreate": at = at[key] = {...v, "id": nat_host(v["id"]), "version": nat_host(v["version"]), "author": nat_host(v["author"]), "writer": nat_host(v["writer"]), "typeHash": nat_host(v["typeHash"]), "blobs": $0m25(v["blobs"])}; return top[0];
      case "ArtifactEdit": at = at[key] = {...v, "id": nat_host(v["id"]), "version": nat_host(v["version"]), "predecessor": nat_host(v["predecessor"]), "author": nat_host(v["author"]), "writer": nat_host(v["writer"]), "typeHash": nat_host(v["typeHash"]), "blobs": $0m25(v["blobs"])}; return top[0];
      case "ArtifactComment": at = at[key] = {...v, "id": nat_host(v["id"]), "comment": nat_host(v["comment"]), "onVersion": nat_host(v["onVersion"]), "author": nat_host(v["author"]), "writer": nat_host(v["writer"])}; return top[0];
      case "ArtifactDelete": at = at[key] = {...v, "id": nat_host(v["id"]), "author": nat_host(v["author"]), "writer": nat_host(v["writer"])}; return top[0];
      default: throw "bend: ArtifactAction has no tag " + v?.$ + " (its tags: ArtifactCreate, ArtifactEdit, ArtifactComment, ArtifactDelete); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m41(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "ArtifactCreate": at = at[key] = {...v, "id": BigInt(v["id"]), "version": BigInt(v["version"]), "author": BigInt(v["author"]), "writer": BigInt(v["writer"]), "typeHash": BigInt(v["typeHash"]), "blobs": $0m26(v["blobs"])}; return top[0];
      case "ArtifactEdit": at = at[key] = {...v, "id": BigInt(v["id"]), "version": BigInt(v["version"]), "predecessor": BigInt(v["predecessor"]), "author": BigInt(v["author"]), "writer": BigInt(v["writer"]), "typeHash": BigInt(v["typeHash"]), "blobs": $0m26(v["blobs"])}; return top[0];
      case "ArtifactComment": at = at[key] = {...v, "id": BigInt(v["id"]), "comment": BigInt(v["comment"]), "onVersion": BigInt(v["onVersion"]), "author": BigInt(v["author"]), "writer": BigInt(v["writer"])}; return top[0];
      case "ArtifactDelete": at = at[key] = {...v, "id": BigInt(v["id"]), "author": BigInt(v["author"]), "writer": BigInt(v["writer"])}; return top[0];
      default: throw "bend: ArtifactAction has no tag " + v?.$ + " (its tags: ArtifactCreate, ArtifactEdit, ArtifactComment, ArtifactDelete); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m43(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "ProjectInfo": at = at[key] = {...v, "id": nat_host(v["id"]), "revision": nat_host(v["revision"])}; return top[0];
      default: throw "bend: ProjectInfo has no tag " + v?.$ + " (its tags: ProjectInfo); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m42(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Nil": at[key] = v; return top[0];
      case "Con": at = at[key] = {...v, "head": $0m43(v["head"])}; key = "tail"; v = v[key]; continue;
      default: throw "bend: List has no tag " + v?.$ + " (its tags: Nil, Con); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m45(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "ProjectInfo": at = at[key] = {...v, "id": BigInt(v["id"]), "revision": BigInt(v["revision"])}; return top[0];
      default: throw "bend: ProjectInfo has no tag " + v?.$ + " (its tags: ProjectInfo); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m44(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Nil": at[key] = v; return top[0];
      case "Con": at = at[key] = {...v, "head": $0m45(v["head"])}; key = "tail"; v = v[key]; continue;
      default: throw "bend: List has no tag " + v?.$ + " (its tags: Nil, Con); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m46(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "None": at[key] = v; return top[0];
      case "Some": at = at[key] = {...v, "value": $0m45(v["value"])}; return top[0];
      default: throw "bend: Maybe has no tag " + v?.$ + " (its tags: None, Some); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m48(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Participation": at = at[key] = {...v, "project": nat_host(v["project"]), "person": nat_host(v["person"]), "revision": nat_host(v["revision"])}; return top[0];
      default: throw "bend: Participation has no tag " + v?.$ + " (its tags: Participation); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m47(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Nil": at[key] = v; return top[0];
      case "Con": at = at[key] = {...v, "head": $0m48(v["head"])}; key = "tail"; v = v[key]; continue;
      default: throw "bend: List has no tag " + v?.$ + " (its tags: Nil, Con); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m50(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Participation": at = at[key] = {...v, "project": BigInt(v["project"]), "person": BigInt(v["person"]), "revision": BigInt(v["revision"])}; return top[0];
      default: throw "bend: Participation has no tag " + v?.$ + " (its tags: Participation); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m49(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Nil": at[key] = v; return top[0];
      case "Con": at = at[key] = {...v, "head": $0m50(v["head"])}; key = "tail"; v = v[key]; continue;
      default: throw "bend: List has no tag " + v?.$ + " (its tags: Nil, Con); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m52(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Placement": at = at[key] = {...v, "artifact": nat_host(v["artifact"]), "project": nat_host(v["project"]), "revision": nat_host(v["revision"])}; return top[0];
      default: throw "bend: Placement has no tag " + v?.$ + " (its tags: Placement); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m51(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Nil": at[key] = v; return top[0];
      case "Con": at = at[key] = {...v, "head": $0m52(v["head"])}; key = "tail"; v = v[key]; continue;
      default: throw "bend: List has no tag " + v?.$ + " (its tags: Nil, Con); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m54(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Placement": at = at[key] = {...v, "artifact": BigInt(v["artifact"]), "project": BigInt(v["project"]), "revision": BigInt(v["revision"])}; return top[0];
      default: throw "bend: Placement has no tag " + v?.$ + " (its tags: Placement); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m53(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "Nil": at[key] = v; return top[0];
      case "Con": at = at[key] = {...v, "head": $0m54(v["head"])}; key = "tail"; v = v[key]; continue;
      default: throw "bend: List has no tag " + v?.$ + " (its tags: Nil, Con); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m55(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "None": at[key] = v; return top[0];
      case "Some": at = at[key] = {...v, "value": $0m43(v["value"])}; return top[0];
      default: throw "bend: Maybe has no tag " + v?.$ + " (its tags: None, Some); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m56(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "ProjectIndex": at = at[key] = {...v, "items": $0m42(v["items"]), "pairs": $0m47(v["pairs"]), "placements": $0m51(v["placements"])}; return top[0];
      default: throw "bend: ProjectIndex has no tag " + v?.$ + " (its tags: ProjectIndex); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m57(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "ProjectIndex": at = at[key] = {...v, "items": $0m44(v["items"]), "pairs": $0m49(v["pairs"]), "placements": $0m53(v["placements"])}; return top[0];
      default: throw "bend: ProjectIndex has no tag " + v?.$ + " (its tags: ProjectIndex); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m58(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "ProjectAccepted": at = at[key] = {...v, "index": $0m57(v["index"])}; return top[0];
      case "ProjectDenied": at[key] = v; return top[0];
      case "ProjectConflict": at[key] = v; return top[0];
      default: throw "bend: ProjectTransition has no tag " + v?.$ + " (its tags: ProjectAccepted, ProjectDenied, ProjectConflict); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m59(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "ProjectCreate": at = at[key] = {...v, "id": nat_host(v["id"])}; return top[0];
      case "ProjectPurpose": at = at[key] = {...v, "id": nat_host(v["id"]), "predecessor": nat_host(v["predecessor"])}; return top[0];
      case "ProjectStateChange": at = at[key] = {...v, "id": nat_host(v["id"]), "predecessor": nat_host(v["predecessor"])}; return top[0];
      case "ProjectJoin": at = at[key] = {...v, "id": nat_host(v["id"]), "member": nat_host(v["member"]), "predecessor": nat_host(v["predecessor"])}; return top[0];
      case "ProjectLeave": at = at[key] = {...v, "id": nat_host(v["id"]), "member": nat_host(v["member"]), "predecessor": nat_host(v["predecessor"])}; return top[0];
      case "ArtifactProject": at = at[key] = {...v, "id": nat_host(v["id"]), "project": nat_host(v["project"]), "author": nat_host(v["author"]), "writer": nat_host(v["writer"]), "predecessor": nat_host(v["predecessor"])}; return top[0];
      default: throw "bend: ProjectAction has no tag " + v?.$ + " (its tags: ProjectCreate, ProjectPurpose, ProjectStateChange, ProjectJoin, ProjectLeave, ArtifactProject); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m60(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "ProjectCreate": at = at[key] = {...v, "id": BigInt(v["id"])}; return top[0];
      case "ProjectPurpose": at = at[key] = {...v, "id": BigInt(v["id"]), "predecessor": BigInt(v["predecessor"])}; return top[0];
      case "ProjectStateChange": at = at[key] = {...v, "id": BigInt(v["id"]), "predecessor": BigInt(v["predecessor"])}; return top[0];
      case "ProjectJoin": at = at[key] = {...v, "id": BigInt(v["id"]), "member": BigInt(v["member"]), "predecessor": BigInt(v["predecessor"])}; return top[0];
      case "ProjectLeave": at = at[key] = {...v, "id": BigInt(v["id"]), "member": BigInt(v["member"]), "predecessor": BigInt(v["predecessor"])}; return top[0];
      case "ArtifactProject": at = at[key] = {...v, "id": BigInt(v["id"]), "project": BigInt(v["project"]), "author": BigInt(v["author"]), "writer": BigInt(v["writer"]), "predecessor": BigInt(v["predecessor"])}; return top[0];
      default: throw "bend: ProjectAction has no tag " + v?.$ + " (its tags: ProjectCreate, ProjectPurpose, ProjectStateChange, ProjectJoin, ProjectLeave, ArtifactProject); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m61(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "PrivateCopy": at = at[key] = {...v, "id": nat_host(v["id"]), "artifact": nat_host(v["artifact"]), "author": nat_host(v["author"]), "journey": nat_host(v["journey"]), "head": nat_host(v["head"]), "record": nat_host(v["record"]), "seq": nat_host(v["seq"]), "versions": $0m29(v["versions"]), "used": $0m25(v["used"]), "project": nat_host(v["project"]), "placement": nat_host(v["placement"]), "typeHash": nat_host(v["typeHash"])}; return top[0];
      default: throw "bend: PrivateCopy has no tag " + v?.$ + " (its tags: PrivateCopy); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m62(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "PrivateCopy": at = at[key] = {...v, "id": BigInt(v["id"]), "artifact": BigInt(v["artifact"]), "author": BigInt(v["author"]), "journey": BigInt(v["journey"]), "head": BigInt(v["head"]), "record": BigInt(v["record"]), "seq": BigInt(v["seq"]), "versions": $0m33(v["versions"]), "used": $0m26(v["used"]), "project": BigInt(v["project"]), "placement": BigInt(v["placement"]), "typeHash": BigInt(v["typeHash"])}; return top[0];
      default: throw "bend: PrivateCopy has no tag " + v?.$ + " (its tags: PrivateCopy); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m63(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "PrivateAccepted": at = at[key] = {...v, "value": $0m62(v["value"])}; return top[0];
      case "PrivateConflict": at[key] = v; return top[0];
      case "PrivateDenied": at[key] = v; return top[0];
      default: throw "bend: PrivateTransition has no tag " + v?.$ + " (its tags: PrivateAccepted, PrivateConflict, PrivateDenied); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m64(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "PrivateCreate": at = at[key] = {...v, "artifact": nat_host(v["artifact"]), "author": nat_host(v["author"]), "writer": nat_host(v["writer"]), "journey": nat_host(v["journey"]), "version": nat_host(v["version"]), "typeHash": nat_host(v["typeHash"]), "blobs": $0m25(v["blobs"])}; return top[0];
      case "PrivateEdit": at = at[key] = {...v, "artifact": nat_host(v["artifact"]), "author": nat_host(v["author"]), "writer": nat_host(v["writer"]), "version": nat_host(v["version"]), "typeHash": nat_host(v["typeHash"]), "predecessor": nat_host(v["predecessor"]), "blobs": $0m25(v["blobs"])}; return top[0];
      case "PrivateComment": at = at[key] = {...v, "artifact": nat_host(v["artifact"]), "author": nat_host(v["author"]), "writer": nat_host(v["writer"]), "comment": nat_host(v["comment"]), "context": nat_host(v["context"])}; return top[0];
      case "PrivateDelete": at = at[key] = {...v, "artifact": nat_host(v["artifact"]), "author": nat_host(v["author"]), "writer": nat_host(v["writer"]), "predecessor": nat_host(v["predecessor"])}; return top[0];
      case "PrivateProject": at = at[key] = {...v, "artifact": nat_host(v["artifact"]), "author": nat_host(v["author"]), "writer": nat_host(v["writer"]), "project": nat_host(v["project"]), "predecessor": nat_host(v["predecessor"])}; return top[0];
      default: throw "bend: PrivateAction has no tag " + v?.$ + " (its tags: PrivateCreate, PrivateEdit, PrivateComment, PrivateDelete, PrivateProject); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m65(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "PrivateCreate": at = at[key] = {...v, "artifact": BigInt(v["artifact"]), "author": BigInt(v["author"]), "writer": BigInt(v["writer"]), "journey": BigInt(v["journey"]), "version": BigInt(v["version"]), "typeHash": BigInt(v["typeHash"]), "blobs": $0m26(v["blobs"])}; return top[0];
      case "PrivateEdit": at = at[key] = {...v, "artifact": BigInt(v["artifact"]), "author": BigInt(v["author"]), "writer": BigInt(v["writer"]), "version": BigInt(v["version"]), "typeHash": BigInt(v["typeHash"]), "predecessor": BigInt(v["predecessor"]), "blobs": $0m26(v["blobs"])}; return top[0];
      case "PrivateComment": at = at[key] = {...v, "artifact": BigInt(v["artifact"]), "author": BigInt(v["author"]), "writer": BigInt(v["writer"]), "comment": BigInt(v["comment"]), "context": BigInt(v["context"])}; return top[0];
      case "PrivateDelete": at = at[key] = {...v, "artifact": BigInt(v["artifact"]), "author": BigInt(v["author"]), "writer": BigInt(v["writer"]), "predecessor": BigInt(v["predecessor"])}; return top[0];
      case "PrivateProject": at = at[key] = {...v, "artifact": BigInt(v["artifact"]), "author": BigInt(v["author"]), "writer": BigInt(v["writer"]), "project": BigInt(v["project"]), "predecessor": BigInt(v["predecessor"])}; return top[0];
      default: throw "bend: PrivateAction has no tag " + v?.$ + " (its tags: PrivateCreate, PrivateEdit, PrivateComment, PrivateDelete, PrivateProject); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m66(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "None": at[key] = v; return top[0];
      case "Some": at = at[key] = {...v, "value": $0m61(v["value"])}; return top[0];
      default: throw "bend: Maybe has no tag " + v?.$ + " (its tags: None, Some); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}

function $0m67(v) {
  const top = [v];
  for (let at = top, key = 0;;) {
    switch (v.$) {
      case "None": at[key] = v; return top[0];
      case "Some": at = at[key] = {...v, "value": $0m62(v["value"])}; return top[0];
      default: throw "bend: Maybe has no tag " + v?.$ + " (its tags: None, Some); a tag names its constructor as the"
      + " loading file sees it, which a later version will make the same"
      + " everywhere (#1105)";
    }
  }
}
export default {
  "agent_access": run_lib((a0, a1) => { const r = (run_loop($agent_access$((a0), (a1)))); (a0); (a1); return r; }, 2),
  "can_write": run_lib((a0) => { const r = (run_loop($can_write$((a0)))); (a0); return r; }, 1),
  "person_guide": run_lib((a0, a1) => { const r = (run_loop($person_guide$((a0), (a1)))); (a0); (a1); return r; }, 2),
  "find": run_lib((a0, a1) => { const r = $0m4(run_loop($find$($0m0(a0), nat_host(a1)))); $0m2(a0); BigInt(a1); return r; }, 2),
  "is_person": run_lib((a0) => { const r = (run_loop($is_person$($0m5(a0)))); $0m4(a0); return r; }, 1),
  "is_guide": run_lib((a0) => { const r = (run_loop($is_guide$($0m5(a0)))); $0m4(a0); return r; }, 1),
  "has_guide": run_lib((a0) => { const r = (run_loop($has_guide$($0m0(a0)))); $0m2(a0); return r; }, 1),
  "agent_live_access": run_lib((a0, a1, a2) => { const r = (run_loop($agent_live_access$($0m5(a0), (a1), (a2)))); $0m4(a0); (a1); (a2); return r; }, 3),
  "live_person": run_lib((a0, a1) => { const r = $0m4(run_loop($live_person$($0m5(a0), (a1)))); $0m4(a0); (a1); return r; }, 2),
  "authority_person": run_lib((a0, a1) => { const r = $0m4(run_loop($authority_person$($0m5(a0), $0m0(a1)))); $0m4(a0); $0m2(a1); return r; }, 2),
  "member_access": run_lib((a0, a1) => { const r = (run_loop($member_access$($0m5(a0), $0m0(a1)))); $0m4(a0); $0m2(a1); return r; }, 2),
  "access_write": run_lib((a0) => { const r = (run_loop($access_write$((a0)))); (a0); return r; }, 1),
  "access_read": run_lib((a0) => { const r = (run_loop($access_read$((a0)))); (a0); return r; }, 1),
  "owned_agent": run_lib((a0, a1, a2) => { const r = (run_loop($owned_agent$((a0), nat_host(a1), nat_host(a2)))); (a0); BigInt(a1); BigInt(a2); return r; }, 3),
  "survives": run_lib((a0, a1, a2) => { const r = (run_loop($survives$(nat_host(a0), (a1), $0m1(a2)))); BigInt(a0); (a1); $0m3(a2); return r; }, 3),
  "remove": run_lib((a0, a1, a2) => { const r = $0m2(run_loop($remove$($0m0(a0), nat_host(a1), (a2)))); $0m2(a0); BigInt(a1); (a2); return r; }, 3),
  "removal_authority": run_lib((a0, a1, a2, a3) => { const r = (run_loop($removal_authority$((a0), (a1), $0m5(a2), nat_host(a3)))); (a0); (a1); $0m4(a2); BigInt(a3); return r; }, 4),
  "can_remove": run_lib((a0, a1, a2) => { const r = (run_loop($can_remove$($0m0(a0), nat_host(a1), nat_host(a2)))); $0m2(a0); BigInt(a1); BigInt(a2); return r; }, 3),
  "set_guide": run_lib((a0, a1, a2) => { const r = $0m2(run_loop($set_guide$($0m0(a0), nat_host(a1), (a2)))); $0m2(a0); BigInt(a1); (a2); return r; }, 3),
  "set_role": run_lib((a0, a1, a2) => { const r = $0m2(run_loop($set_role$($0m0(a0), nat_host(a1), (a2)))); $0m2(a0); BigInt(a1); (a2); return r; }, 3),
  "guarded_members": run_lib((a0, a1) => { const r = $0m6(run_loop($guarded_members$((a0), $0m0(a1)))); (a0); $0m2(a1); return r; }, 2),
  "guard": run_lib((a0, a1) => { const r = $0m6(run_loop($guard$((a0), $0m0(a1)))); (a0); $0m2(a1); return r; }, 2),
  "addition_authority": run_lib((a0, a1, a2) => { const r = (run_loop($addition_authority$($0m0(a0), nat_host(a1), $0m1(a2)))); $0m2(a0); BigInt(a1); $0m3(a2); return r; }, 3),
  "missing": run_lib((a0) => { const r = (run_loop($missing$($0m5(a0)))); $0m4(a0); return r; }, 1),
  "guide_target": run_lib((a0) => { const r = (run_loop($guide_target$($0m5(a0)))); $0m4(a0); return r; }, 1),
  "own_profile": run_lib((a0, a1, a2) => { const r = (run_loop($own_profile$($0m0(a0), nat_host(a1), nat_host(a2)))); $0m2(a0); BigInt(a1); BigInt(a2); return r; }, 3),
  "rename_authority": run_lib((a0, a1, a2) => { const r = (run_loop($rename_authority$($0m0(a0), nat_host(a1), $0m5(a2)))); $0m2(a0); BigInt(a1); $0m4(a2); return r; }, 3),
  "add_checked": run_lib((a0, a1, a2, a3) => { const r = $0m6(run_loop($add_checked$((a0), (a1), $0m1(a2), $0m0(a3)))); (a0); (a1); $0m3(a2); $0m2(a3); return r; }, 4),
  "rename_checked": run_lib((a0, a1, a2) => { const r = $0m6(run_loop($rename_checked$((a0), (a1), $0m0(a2)))); (a0); (a1); $0m2(a2); return r; }, 3),
  "own_agent": run_lib((a0, a1, a2) => { const r = (run_loop($own_agent$($0m0(a0), nat_host(a1), $0m5(a2)))); $0m2(a0); BigInt(a1); $0m4(a2); return r; }, 3),
  "apply": run_lib((a0, a1) => { const r = $0m6(run_loop($apply$($0m0(a0), $0m7(a1)))); $0m2(a0); $0m8(a1); return r; }, 2),
  "replay_step": run_lib((a0, a1) => { const r = $0m6(run_loop($replay_step$($0m9(a0), $0m7(a1)))); $0m6(a0); $0m8(a1); return r; }, 2),
  "replay": run_lib((a0, a1) => { const r = $0m6(run_loop($replay$($0m10(a0), $0m9(a1)))); $0m11(a0); $0m6(a1); return r; }, 2),
  "new_epoch_key": run_lib((a0, a1, a2) => { const r = (run_loop($new_epoch_key$(nat_host(a0), (a1), $0m1(a2)))); BigInt(a0); (a1); $0m3(a2); return r; }, 3),
  "all_survive": run_lib((a0, a1, a2) => { const r = (run_loop($all_survive$(nat_host(a0), (a1), $0m0(a2)))); BigInt(a0); (a1); $0m2(a2); return r; }, 3),
  "transport_access": run_lib((a0, a1, a2, a3) => { const r = (run_loop($transport_access$((a0), (a1), (a2), (a3)))); (a0); (a1); (a2); (a3); return r; }, 4),
  "transport_remove": run_lib((a0, a1) => { const r = (run_loop($transport_remove$((a0), (a1)))); (a0); (a1); return r; }, 2),
  "transport_renew": run_lib((a0, a1, a2, a3) => { const r = (run_loop($transport_renew$((a0), (a1), (a2), (a3)))); (a0); (a1); (a2); (a3); return r; }, 4),
  "rotation_holdings": run_lib((a0, a1) => { const r = $0m12(run_loop($rotation_holdings$($0m0(a0), nat_host(a1)))); $0m2(a0); BigInt(a1); return r; }, 2),
  "remove_and_rotate": run_lib((a0, a1, a2, a3) => { const r = $0m12(run_loop($remove_and_rotate$($0m0(a0), nat_host(a1), (a2), nat_host(a3)))); $0m2(a0); BigInt(a1); (a2); BigInt(a3); return r; }, 4),
  "next_holding": run_lib((a0, a1, a2, a3) => { const r = $0m14(run_loop($next_holding$(nat_host(a0), (a1), $0m1(a2), nat_host(a3)))); BigInt(a0); (a1); $0m3(a2); BigInt(a3); return r; }, 4),
  "active_settings": run_lib((a0) => { const r = (run_loop($active_settings$((a0)))); (a0); return r; }, 1),
  "legacy_settings": run_lib((a0, a1) => { const r = (run_loop($legacy_settings$((a0), (a1)))); (a0); (a1); return r; }, 2),
  "admission_role": run_lib((a0, a1) => { const r = (run_loop($admission_role$((a0), (a1)))); (a0); (a1); return r; }, 2),
  "admitted_member": run_lib((a0, a1) => { const r = $0m3(run_loop($admitted_member$($0m1(a0), (a1)))); $0m3(a0); (a1); return r; }, 2),
  "version_ge": run_lib((a0, a1) => { const r = (run_loop($version_ge$($0m15(a0), $0m15(a1)))); $0m16(a0); $0m16(a1); return r; }, 2),
  "stage_ready": run_lib((a0) => { const r = (run_loop($stage_ready$($0m15(a0)))); $0m16(a0); return r; }, 1),
  "journey_guard": run_lib((a0, a1) => { const r = $0m19(run_loop($journey_guard$((a0), $0m17(a1)))); (a0); $0m18(a1); return r; }, 2),
  "configure": run_lib((a0, a1, a2, a3, a4) => { const r = $0m19(run_loop($configure$($0m0(a0), nat_host(a1), (a2), $0m15(a3), (a4)))); $0m2(a0); BigInt(a1); (a2); $0m16(a3); (a4); return r; }, 5),
  "minimum_change": run_lib((a0, a1, a2, a3, a4, a5) => { const r = $0m19(run_loop($minimum_change$($0m0(a0), nat_host(a1), (a2), $0m15(a3), $0m15(a4), (a5)))); $0m2(a0); BigInt(a1); (a2); $0m16(a3); $0m16(a4); (a5); return r; }, 6),
  "content_write": run_lib((a0, a1) => { const r = (run_loop($content_write$((a0), (a1)))); (a0); (a1); return r; }, 2),
  "control_pending": run_lib((a0, a1) => { const r = (run_loop($control_pending$($0m7(a0), (a1)))); $0m8(a0); (a1); return r; }, 2),
  "admission_control": run_lib((a0, a1, a2) => { const r = $0m8(run_loop($admission_control$($0m7(a0), (a1), (a2)))); $0m8(a0); (a1); (a2); return r; }, 3),
  "journey_result": run_lib((a0, a1, a2, a3) => { const r = $0m19(run_loop($journey_result$($0m9(a0), (a1), $0m15(a2), (a3)))); $0m6(a0); (a1); $0m16(a2); (a3); return r; }, 4),
  "journey_control": run_lib((a0, a1, a2, a3, a4) => { const r = $0m19(run_loop($journey_control$($0m0(a0), (a1), $0m15(a2), (a3), $0m7(a4)))); $0m2(a0); (a1); $0m16(a2); (a3); $0m8(a4); return r; }, 5),
  "upgrade_control": run_lib((a0, a1, a2, a3, a4, a5) => { const r = $0m19(run_loop($upgrade_control$((a0), $0m0(a1), (a2), $0m15(a3), (a4), $0m7(a5)))); (a0); $0m2(a1); (a2); $0m16(a3); (a4); $0m8(a5); return r; }, 6),
  "journey_apply": run_lib((a0, a1) => { const r = $0m19(run_loop($journey_apply$($0m17(a0), $0m20(a1)))); $0m18(a0); $0m21(a1); return r; }, 2),
  "journey_replay_step": run_lib((a0, a1) => { const r = $0m19(run_loop($journey_replay_step$($0m22(a0), $0m20(a1)))); $0m19(a0); $0m21(a1); return r; }, 2),
  "journey_replay": run_lib((a0, a1) => { const r = $0m19(run_loop($journey_replay$($0m23(a0), $0m22(a1)))); $0m24(a0); $0m19(a1); return r; }, 2),
  "server_version": run_lib((a0, a1, a2) => { const r = (run_loop($server_version$($0m15(a0), $0m15(a1), (a2)))); $0m16(a0); $0m16(a1); (a2); return r; }, 3),
  "server_read": run_lib((a0, a1, a2) => { const r = (run_loop($server_read$((a0), (a1), (a2)))); (a0); (a1); (a2); return r; }, 3),
  "server_content": run_lib((a0, a1, a2, a3) => { const r = (run_loop($server_content$((a0), (a1), (a2), (a3)))); (a0); (a1); (a2); (a3); return r; }, 4),
  "admission_scope": run_lib((a0, a1) => { const r = (run_loop($admission_scope$((a0), (a1)))); (a0); (a1); return r; }, 2),
  "server_admission": run_lib((a0, a1, a2, a3, a4, a5) => { const r = (run_loop($server_admission$((a0), (a1), (a2), nat_host(a3), nat_host(a4), (a5)))); (a0); (a1); (a2); BigInt(a3); BigInt(a4); (a5); return r; }, 6),
  "artifact_ready": run_lib((a0) => { const r = (run_loop($artifact_ready$($0m15(a0)))); $0m16(a0); return r; }, 1),
  "artifact_client": run_lib((a0, a1, a2, a3) => { const r = (run_loop($artifact_client$($0m15(a0), $0m15(a1), (a2), (a3)))); $0m16(a0); $0m16(a1); (a2); (a3); return r; }, 4),
  "nat_has": run_lib((a0, a1) => { const r = (run_loop($nat_has$($0m25(a0), nat_host(a1)))); $0m26(a0); BigInt(a1); return r; }, 2),
  "artifact_find": run_lib((a0, a1) => { const r = $0m35(run_loop($artifact_find$($0m27(a0), nat_host(a1)))); $0m31(a0); BigInt(a1); return r; }, 2),
  "artifact_put": run_lib((a0, a1) => { const r = $0m31(run_loop($artifact_put$($0m27(a0), $0m28(a1)))); $0m31(a0); $0m32(a1); return r; }, 2),
  "artifact_version_has": run_lib((a0, a1) => { const r = (run_loop($artifact_version_has$($0m29(a0), nat_host(a1)))); $0m33(a0); BigInt(a1); return r; }, 2),
  "artifact_blob_has": run_lib((a0, a1) => { const r = (run_loop($artifact_blob_has$($0m29(a0), nat_host(a1)))); $0m33(a0); BigInt(a1); return r; }, 2),
  "artifact_other_blob": run_lib((a0, a1, a2) => { const r = (run_loop($artifact_other_blob$($0m27(a0), nat_host(a1), nat_host(a2)))); $0m31(a0); BigInt(a1); BigInt(a2); return r; }, 3),
  "artifact_references": run_lib((a0, a1, a2) => { const r = (run_loop($artifact_references$($0m25(a0), $0m27(a1), nat_host(a2)))); $0m26(a0); $0m31(a1); BigInt(a2); return r; }, 3),
  "artifact_live_blob": run_lib((a0, a1) => { const r = (run_loop($artifact_live_blob$($0m27(a0), nat_host(a1)))); $0m31(a0); BigInt(a1); return r; }, 2),
  "artifact_guard": run_lib((a0, a1) => { const r = $0m38(run_loop($artifact_guard$((a0), $0m36(a1)))); (a0); $0m37(a1); return r; }, 2),
  "artifact_create": run_lib((a0, a1, a2, a3, a4, a5, a6, a7, a8) => { const r = $0m38(run_loop($artifact_create$($0m27(a0), $0m25(a1), nat_host(a2), nat_host(a3), nat_host(a4), nat_host(a5), nat_host(a6), nat_host(a7), $0m25(a8)))); $0m31(a0); $0m26(a1); BigInt(a2); BigInt(a3); BigInt(a4); BigInt(a5); BigInt(a6); BigInt(a7); $0m26(a8); return r; }, 9),
  "artifact_edit": run_lib((a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10) => { const r = $0m38(run_loop($artifact_edit$($0m39(a0), $0m27(a1), $0m25(a2), nat_host(a3), nat_host(a4), nat_host(a5), nat_host(a6), nat_host(a7), nat_host(a8), nat_host(a9), $0m25(a10)))); $0m35(a0); $0m31(a1); $0m26(a2); BigInt(a3); BigInt(a4); BigInt(a5); BigInt(a6); BigInt(a7); BigInt(a8); BigInt(a9); $0m26(a10); return r; }, 11),
  "artifact_comment": run_lib((a0, a1, a2, a3, a4, a5, a6, a7) => { const r = $0m38(run_loop($artifact_comment$($0m39(a0), $0m27(a1), $0m25(a2), nat_host(a3), nat_host(a4), nat_host(a5), nat_host(a6), nat_host(a7)))); $0m35(a0); $0m31(a1); $0m26(a2); BigInt(a3); BigInt(a4); BigInt(a5); BigInt(a6); BigInt(a7); return r; }, 8),
  "artifact_delete": run_lib((a0, a1, a2, a3, a4, a5, a6) => { const r = $0m38(run_loop($artifact_delete$($0m39(a0), $0m27(a1), $0m25(a2), nat_host(a3), nat_host(a4), nat_host(a5), nat_host(a6)))); $0m35(a0); $0m31(a1); $0m26(a2); BigInt(a3); BigInt(a4); BigInt(a5); BigInt(a6); return r; }, 7),
  "artifact_action": run_lib((a0, a1, a2) => { const r = $0m38(run_loop($artifact_action$($0m36(a0), nat_host(a1), $0m40(a2)))); $0m37(a0); BigInt(a1); $0m41(a2); return r; }, 3),
  "artifact_authorized": run_lib((a0, a1, a2, a3) => { const r = $0m38(run_loop($artifact_authorized$((a0), $0m36(a1), nat_host(a2), $0m40(a3)))); (a0); $0m37(a1); BigInt(a2); $0m41(a3); return r; }, 4),
  "artifact_apply": run_lib((a0, a1, a2, a3, a4, a5) => { const r = $0m38(run_loop($artifact_apply$($0m0(a0), nat_host(a1), $0m15(a2), (a3), $0m36(a4), $0m40(a5)))); $0m2(a0); BigInt(a1); $0m16(a2); (a3); $0m37(a4); $0m41(a5); return r; }, 6),
  "blob_stage": run_lib((a0, a1, a2, a3, a4, a5) => { const r = (run_loop($blob_stage$((a0), (a1), (a2), (a3), nat_host(a4), nat_host(a5)))); (a0); (a1); (a2); (a3); BigInt(a4); BigInt(a5); return r; }, 6),
  "blob_upload": run_lib((a0, a1, a2, a3, a4, a5) => { const r = (run_loop($blob_upload$((a0), (a1), nat_host(a2), nat_host(a3), (a4), (a5)))); (a0); (a1); BigInt(a2); BigInt(a3); (a4); (a5); return r; }, 6),
  "blob_reference": run_lib((a0, a1, a2, a3, a4, a5, a6, a7, a8, a9) => { const r = (run_loop($blob_reference$((a0), (a1), (a2), (a3), nat_host(a4), nat_host(a5), (a6), nat_host(a7), nat_host(a8), (a9)))); (a0); (a1); (a2); (a3); BigInt(a4); BigInt(a5); (a6); BigInt(a7); BigInt(a8); (a9); return r; }, 10),
  "blob_read": run_lib((a0, a1, a2) => { const r = (run_loop($blob_read$((a0), (a1), (a2)))); (a0); (a1); (a2); return r; }, 3),
  "blob_collect": run_lib((a0, a1, a2) => { const r = (run_loop($blob_collect$((a0), (a1), (a2)))); (a0); (a1); (a2); return r; }, 3),
  "blob_reuse": run_lib((a0, a1) => { const r = (run_loop($blob_reuse$($0m39(a0), nat_host(a1)))); $0m35(a0); BigInt(a1); return r; }, 2),
  "project_ready": run_lib((a0) => { const r = (run_loop($project_ready$($0m15(a0)))); $0m16(a0); return r; }, 1),
  "project_client": run_lib((a0, a1, a2, a3, a4) => { const r = (run_loop($project_client$($0m15(a0), $0m15(a1), (a2), (a3), (a4)))); $0m16(a0); $0m16(a1); (a2); (a3); (a4); return r; }, 5),
  "phase_eq": run_lib((a0, a1) => { const r = (run_loop($phase_eq$((a0), (a1)))); (a0); (a1); return r; }, 2),
  "project_find": run_lib((a0, a1) => { const r = $0m46(run_loop($project_find$($0m42(a0), nat_host(a1)))); $0m44(a0); BigInt(a1); return r; }, 2),
  "project_put": run_lib((a0, a1) => { const r = $0m44(run_loop($project_put$($0m42(a0), $0m43(a1)))); $0m44(a0); $0m45(a1); return r; }, 2),
  "pair_find": run_lib((a0, a1, a2) => { const r = $0m50(run_loop($pair_find$($0m47(a0), nat_host(a1), nat_host(a2)))); $0m49(a0); BigInt(a1); BigInt(a2); return r; }, 3),
  "pair_put": run_lib((a0, a1) => { const r = $0m49(run_loop($pair_put$($0m47(a0), $0m48(a1)))); $0m49(a0); $0m50(a1); return r; }, 2),
  "placement_find": run_lib((a0, a1) => { const r = $0m54(run_loop($placement_find$($0m51(a0), nat_host(a1)))); $0m53(a0); BigInt(a1); return r; }, 2),
  "placement_put": run_lib((a0, a1) => { const r = $0m53(run_loop($placement_put$($0m51(a0), $0m52(a1)))); $0m53(a0); $0m54(a1); return r; }, 2),
  "project_exists": run_lib((a0) => { const r = (run_loop($project_exists$($0m55(a0)))); $0m46(a0); return r; }, 1),
  "pair_active": run_lib((a0) => { const r = (run_loop($pair_active$($0m48(a0)))); $0m50(a0); return r; }, 1),
  "project_person": run_lib((a0, a1, a2) => { const r = (run_loop($project_person$($0m5(a0), $0m47(a1), nat_host(a2)))); $0m4(a0); $0m49(a1); BigInt(a2); return r; }, 3),
  "project_follower": run_lib((a0, a1, a2, a3) => { const r = (run_loop($project_follower$($0m5(a0), $0m0(a1), $0m47(a2), nat_host(a3)))); $0m4(a0); $0m2(a1); $0m49(a2); BigInt(a3); return r; }, 4),
  "project_participant": run_lib((a0, a1, a2, a3) => { const r = (run_loop($project_participant$($0m0(a0), $0m47(a1), nat_host(a2), nat_host(a3)))); $0m2(a0); $0m49(a1); BigInt(a2); BigInt(a3); return r; }, 4),
  "project_remove": run_lib((a0, a1, a2) => { const r = $0m49(run_loop($project_remove$($0m47(a0), nat_host(a1), nat_host(a2)))); $0m49(a0); BigInt(a1); BigInt(a2); return r; }, 3),
  "project_guard": run_lib((a0, a1) => { const r = $0m58(run_loop($project_guard$((a0), $0m56(a1)))); (a0); $0m57(a1); return r; }, 2),
  "project_metadata": run_lib((a0, a1, a2, a3, a4, a5, a6) => { const r = $0m58(run_loop($project_metadata$($0m55(a0), $0m42(a1), $0m47(a2), $0m51(a3), nat_host(a4), nat_host(a5), (a6)))); $0m46(a0); $0m44(a1); $0m49(a2); $0m53(a3); BigInt(a4); BigInt(a5); (a6); return r; }, 7),
  "project_membership_pair": run_lib((a0, a1, a2, a3, a4, a5, a6, a7, a8) => { const r = $0m58(run_loop($project_membership_pair$($0m48(a0), $0m42(a1), $0m47(a2), $0m51(a3), nat_host(a4), nat_host(a5), nat_host(a6), nat_host(a7), (a8)))); $0m50(a0); $0m44(a1); $0m49(a2); $0m53(a3); BigInt(a4); BigInt(a5); BigInt(a6); BigInt(a7); (a8); return r; }, 9),
  "project_membership": run_lib((a0, a1, a2, a3, a4, a5, a6, a7) => { const r = $0m58(run_loop($project_membership$($0m42(a0), $0m47(a1), $0m51(a2), nat_host(a3), nat_host(a4), nat_host(a5), nat_host(a6), (a7)))); $0m44(a0); $0m49(a1); $0m53(a2); BigInt(a3); BigInt(a4); BigInt(a5); BigInt(a6); (a7); return r; }, 8),
  "project_placement_value": run_lib((a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11) => { const r = $0m58(run_loop($project_placement_value$($0m52(a0), $0m39(a1), $0m42(a2), $0m47(a3), $0m51(a4), nat_host(a5), nat_host(a6), nat_host(a7), nat_host(a8), nat_host(a9), nat_host(a10), nat_host(a11)))); $0m54(a0); $0m35(a1); $0m44(a2); $0m49(a3); $0m53(a4); BigInt(a5); BigInt(a6); BigInt(a7); BigInt(a8); BigInt(a9); BigInt(a10); BigInt(a11); return r; }, 12),
  "project_placement": run_lib((a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10) => { const r = $0m58(run_loop($project_placement$($0m39(a0), $0m42(a1), $0m47(a2), $0m51(a3), nat_host(a4), nat_host(a5), nat_host(a6), nat_host(a7), nat_host(a8), nat_host(a9), nat_host(a10)))); $0m35(a0); $0m44(a1); $0m49(a2); $0m53(a3); BigInt(a4); BigInt(a5); BigInt(a6); BigInt(a7); BigInt(a8); BigInt(a9); BigInt(a10); return r; }, 11),
  "project_self_person": run_lib((a0, a1) => { const r = (run_loop($project_self_person$($0m5(a0), nat_host(a1)))); $0m4(a0); BigInt(a1); return r; }, 2),
  "project_self": run_lib((a0, a1, a2) => { const r = (run_loop($project_self$($0m0(a0), nat_host(a1), nat_host(a2)))); $0m2(a0); BigInt(a1); BigInt(a2); return r; }, 3),
  "project_authority": run_lib((a0, a1, a2, a3, a4) => { const r = (run_loop($project_authority$($0m0(a0), nat_host(a1), $0m47(a2), (a3), $0m59(a4)))); $0m2(a0); BigInt(a1); $0m49(a2); (a3); $0m60(a4); return r; }, 5),
  "project_action": run_lib((a0, a1, a2, a3, a4) => { const r = $0m58(run_loop($project_action$($0m56(a0), $0m36(a1), nat_host(a2), nat_host(a3), $0m59(a4)))); $0m57(a0); $0m37(a1); BigInt(a2); BigInt(a3); $0m60(a4); return r; }, 5),
  "project_previous": run_lib((a0, a1) => { const r = (run_loop($project_previous$($0m59(a0), nat_host(a1)))); $0m60(a0); BigInt(a1); return r; }, 2),
  "project_authorized": run_lib((a0, a1, a2, a3, a4, a5) => { const r = $0m58(run_loop($project_authorized$((a0), $0m56(a1), $0m36(a2), nat_host(a3), nat_host(a4), $0m59(a5)))); (a0); $0m57(a1); $0m37(a2); BigInt(a3); BigInt(a4); $0m60(a5); return r; }, 6),
  "project_apply": run_lib((a0, a1, a2, a3, a4, a5, a6, a7) => { const r = $0m58(run_loop($project_apply$($0m0(a0), nat_host(a1), $0m15(a2), (a3), $0m56(a4), $0m36(a5), nat_host(a6), $0m59(a7)))); $0m2(a0); BigInt(a1); $0m16(a2); (a3); $0m57(a4); $0m37(a5); BigInt(a6); $0m60(a7); return r; }, 8),
  "project_selector": run_lib((a0, a1) => { const r = (run_loop($project_selector$($0m42(a0), nat_host(a1)))); $0m44(a0); BigInt(a1); return r; }, 2),
  "project_selected_value": run_lib((a0, a1, a2, a3, a4) => { const r = (run_loop($project_selected_value$($0m52(a0), $0m39(a1), $0m51(a2), nat_host(a3), nat_host(a4)))); $0m54(a0); $0m35(a1); $0m53(a2); BigInt(a3); BigInt(a4); return r; }, 5),
  "project_selected": run_lib((a0, a1, a2, a3) => { const r = (run_loop($project_selected$($0m39(a0), $0m51(a1), nat_host(a2), nat_host(a3)))); $0m35(a0); $0m53(a1); BigInt(a2); BigInt(a3); return r; }, 4),
  "private_ready": run_lib((a0) => { const r = (run_loop($private_ready$($0m15(a0)))); $0m16(a0); return r; }, 1),
  "private_client": run_lib((a0, a1, a2, a3, a4, a5) => { const r = (run_loop($private_client$($0m15(a0), $0m15(a1), (a2), (a3), (a4), (a5)))); $0m16(a0); $0m16(a1); (a2); (a3); (a4); (a5); return r; }, 6),
  "private_credential": run_lib((a0, a1) => { const r = (run_loop($private_credential$((a0), (a1)))); (a0); (a1); return r; }, 2),
  "private_related_kind": run_lib((a0, a1, a2, a3, a4) => { const r = (run_loop($private_related_kind$((a0), nat_host(a1), nat_host(a2), (a3), nat_host(a4)))); (a0); BigInt(a1); BigInt(a2); (a3); BigInt(a4); return r; }, 5),
  "private_related_actor": run_lib((a0, a1, a2, a3) => { const r = (run_loop($private_related_actor$((a0), nat_host(a1), (a2), $0m5(a3)))); (a0); BigInt(a1); (a2); $0m4(a3); return r; }, 4),
  "private_relation": run_lib((a0, a1) => { const r = (run_loop($private_relation$($0m5(a0), $0m5(a1)))); $0m4(a0); $0m4(a1); return r; }, 2),
  "private_audience_value": run_lib((a0, a1, a2, a3) => { const r = (run_loop($private_audience_value$($0m0(a0), $0m5(a1), $0m5(a2), (a3)))); $0m2(a0); $0m4(a1); $0m4(a2); (a3); return r; }, 4),
  "private_audience": run_lib((a0, a1, a2, a3) => { const r = (run_loop($private_audience$($0m0(a0), nat_host(a1), nat_host(a2), (a3)))); $0m2(a0); BigInt(a1); BigInt(a2); (a3); return r; }, 4),
  "private_link_read": run_lib((a0, a1) => { const r = (run_loop($private_link_read$($0m0(a0), nat_host(a1)))); $0m2(a0); BigInt(a1); return r; }, 2),
  "private_write": run_lib((a0, a1, a2, a3, a4, a5, a6) => { const r = (run_loop($private_write$($0m0(a0), nat_host(a1), nat_host(a2), (a3), $0m15(a4), (a5), (a6)))); $0m2(a0); BigInt(a1); BigInt(a2); (a3); $0m16(a4); (a5); (a6); return r; }, 7),
  "private_wrap_access": run_lib((a0, a1, a2, a3, a4, a5) => { const r = (run_loop($private_wrap_access$($0m0(a0), nat_host(a1), nat_host(a2), nat_host(a3), (a4), (a5)))); $0m2(a0); BigInt(a1); BigInt(a2); BigInt(a3); (a4); (a5); return r; }, 6),
  "private_copy_access": run_lib((a0, a1, a2, a3) => { const r = (run_loop($private_copy_access$((a0), (a1), (a2), (a3)))); (a0); (a1); (a2); (a3); return r; }, 4),
  "private_guard": run_lib((a0, a1) => { const r = $0m63(run_loop($private_guard$((a0), $0m61(a1)))); (a0); $0m62(a1); return r; }, 2),
  "private_same": run_lib((a0, a1, a2, a3, a4, a5) => { const r = (run_loop($private_same$(nat_host(a0), nat_host(a1), nat_host(a2), nat_host(a3), nat_host(a4), nat_host(a5)))); BigInt(a0); BigInt(a1); BigInt(a2); BigInt(a3); BigInt(a4); BigInt(a5); return r; }, 6),
  "private_action": run_lib((a0, a1, a2, a3, a4) => { const r = $0m63(run_loop($private_action$($0m61(a0), nat_host(a1), nat_host(a2), $0m64(a3), $0m42(a4)))); $0m62(a0); BigInt(a1); BigInt(a2); $0m65(a3); $0m44(a4); return r; }, 5),
  "private_first": run_lib((a0, a1, a2, a3) => { const r = $0m63(run_loop($private_first$(nat_host(a0), nat_host(a1), nat_host(a2), $0m64(a3)))); BigInt(a0); BigInt(a1); BigInt(a2); $0m65(a3); return r; }, 4),
  "private_position": run_lib((a0, a1, a2) => { const r = (run_loop($private_position$($0m66(a0), nat_host(a1), nat_host(a2)))); $0m67(a0); BigInt(a1); BigInt(a2); return r; }, 3),
  "private_step": run_lib((a0, a1, a2, a3, a4, a5) => { const r = $0m63(run_loop($private_step$($0m66(a0), nat_host(a1), nat_host(a2), nat_host(a3), $0m64(a4), $0m42(a5)))); $0m67(a0); BigInt(a1); BigInt(a2); BigInt(a3); $0m65(a4); $0m44(a5); return r; }, 6),
  "private_checked": run_lib((a0, a1, a2, a3, a4, a5, a6, a7) => { const r = $0m63(run_loop($private_checked$((a0), (a1), $0m66(a2), nat_host(a3), nat_host(a4), nat_host(a5), $0m64(a6), $0m42(a7)))); (a0); (a1); $0m67(a2); BigInt(a3); BigInt(a4); BigInt(a5); $0m65(a6); $0m44(a7); return r; }, 8),
  "private_apply": run_lib((a0, a1, a2, a3, a4, a5, a6, a7, a8) => { const r = $0m63(run_loop($private_apply$((a0), $0m66(a1), nat_host(a2), nat_host(a3), nat_host(a4), nat_host(a5), nat_host(a6), $0m64(a7), $0m42(a8)))); (a0); $0m67(a1); BigInt(a2); BigInt(a3); BigInt(a4); BigInt(a5); BigInt(a6); $0m65(a7); $0m44(a8); return r; }, 9),
  "private_bundle_recipient": run_lib((a0, a1, a2) => { const r = (run_loop($private_bundle_recipient$((a0), (a1), (a2)))); (a0); (a1); (a2); return r; }, 3),
  "private_origin_version": run_lib((a0, a1) => { const r = (run_loop($private_origin_version$(nat_host(a0), nat_host(a1)))); BigInt(a0); BigInt(a1); return r; }, 2),
  "private_authority_snapshot": run_lib((a0, a1, a2, a3) => { const r = (run_loop($private_authority_snapshot$(nat_host(a0), nat_host(a1), nat_host(a2), nat_host(a3)))); BigInt(a0); BigInt(a1); BigInt(a2); BigInt(a3); return r; }, 4),
  "private_copied": run_lib((a0, a1, a2, a3, a4, a5, a6, a7, a8, a9) => { const r = $0m63(run_loop($private_copied$($0m61(a0), nat_host(a1), nat_host(a2), nat_host(a3), nat_host(a4), nat_host(a5), $0m25(a6), nat_host(a7), (a8), (a9)))); $0m62(a0); BigInt(a1); BigInt(a2); BigInt(a3); BigInt(a4); BigInt(a5); $0m26(a6); BigInt(a7); (a8); (a9); return r; }, 10),
  "private_selected": run_lib((a0, a1, a2) => { const r = (run_loop($private_selected$($0m61(a0), nat_host(a1), (a2)))); $0m62(a0); BigInt(a1); (a2); return r; }, 3),
  "private_references": run_lib((a0, a1, a2, a3) => { const r = (run_loop($private_references$((a0), (a1), (a2), (a3)))); (a0); (a1); (a2); (a3); return r; }, 4),
  "private_header": run_lib((a0, a1, a2, a3, a4) => { const r = (run_loop($private_header$(nat_host(a0), nat_host(a1), (a2), (a3), (a4)))); BigInt(a0); BigInt(a1); (a2); (a3); (a4); return r; }, 5),
  "private_merge": run_lib((a0, a1, a2, a3, a4) => { const r = (run_loop($private_merge$(nat_host(a0), nat_host(a1), (a2), (a3), (a4)))); BigInt(a0); BigInt(a1); (a2); (a3); (a4); return r; }, 5),
  "private_capacity": run_lib((a0) => { const r = (run_loop($private_capacity$((a0)))); (a0); return r; }, 1),
  "private_sync_due": run_lib((a0, a1) => { const r = (run_loop($private_sync_due$((a0), nat_host(a1)))); (a0); BigInt(a1); return r; }, 2),
  "private_slot_take": run_lib((a0, a1, a2) => { const r = $0m26(run_loop($private_slot_take$($0m25(a0), nat_host(a1), $0m25(a2)))); $0m26(a0); BigInt(a1); $0m26(a2); return r; }, 3),
  "private_slots": run_lib((a0, a1) => { const r = $0m26(run_loop($private_slots$($0m25(a0), $0m25(a1)))); $0m26(a0); $0m26(a1); return r; }, 2),
};
