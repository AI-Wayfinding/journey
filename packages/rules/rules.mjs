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
  if (_member_0.$ === "ReadOnly") {
    return {$: "ReadOnly"};
  } else {
    return _setting_0;
  }
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
      return true;
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
  } else {
    const _actor_7 = _control_0["actor"];
    return $guard$(($is_guide$(($find$(_xs_0, _actor_7)))), _xs_0);
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

function $Cmp$is_eq$(_c_0) {
  if (_c_0.$ === "EQ") {
    return true;
  } else {
    return false;
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
      default: throw "bend: Control has no tag " + v?.$ + " (its tags: Add, Remove, Guide, RoleChange, Settings, Profile, Rename, Rotate); a tag names its constructor as the"
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
      default: throw "bend: Control has no tag " + v?.$ + " (its tags: Add, Remove, Guide, RoleChange, Settings, Profile, Rename, Rotate); a tag names its constructor as the"
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
export default {
  "agent_access": run_lib((a0, a1) => { const r = (run_loop($agent_access$((a0), (a1)))); (a0); (a1); return r; }, 2),
  "can_write": run_lib((a0) => { const r = (run_loop($can_write$((a0)))); (a0); return r; }, 1),
  "person_guide": run_lib((a0, a1) => { const r = (run_loop($person_guide$((a0), (a1)))); (a0); (a1); return r; }, 2),
  "find": run_lib((a0, a1) => { const r = $0m4(run_loop($find$($0m0(a0), nat_host(a1)))); $0m2(a0); BigInt(a1); return r; }, 2),
  "is_person": run_lib((a0) => { const r = (run_loop($is_person$($0m5(a0)))); $0m4(a0); return r; }, 1),
  "is_guide": run_lib((a0) => { const r = (run_loop($is_guide$($0m5(a0)))); $0m4(a0); return r; }, 1),
  "has_guide": run_lib((a0) => { const r = (run_loop($has_guide$($0m0(a0)))); $0m2(a0); return r; }, 1),
  "agent_live_access": run_lib((a0, a1, a2) => { const r = (run_loop($agent_live_access$($0m5(a0), (a1), (a2)))); $0m4(a0); (a1); (a2); return r; }, 3),
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
  "own_agent": run_lib((a0, a1, a2) => { const r = (run_loop($own_agent$($0m0(a0), nat_host(a1), $0m5(a2)))); $0m2(a0); BigInt(a1); $0m4(a2); return r; }, 3),
  "next_holding": run_lib((a0, a1, a2, a3) => { const r = $0m14(run_loop($next_holding$(nat_host(a0), (a1), $0m1(a2), nat_host(a3)))); BigInt(a0); (a1); $0m3(a2); BigInt(a3); return r; }, 4),
};
