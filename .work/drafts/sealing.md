# Sealing non-routing content with MLS

Design draft, 2026-11-11. Source baseline: `c4560c9ad1273c45c6c264695e03227226ba287c` (`origin/main` when this worktree was made). This document proposes the implementation; it does not claim that encryption, browser devices or the tests named below exist.

## Decision and boundary

Dan's decision, 2026-11-11: “posts, interviews, etc... everything not required for the server to work, should be encrypted via mls.” Offers are switched on or off per journey, on the offer, with an optional journey limit below the agent-wide ceiling. The agent-wide ceiling remains the hard cap.

Keep authority, routing, state transitions, bounded storage and admission on the server. Seal user-authored names, descriptions and content at the device before transmission. This includes copies and derived content, not just the original field. The server must not receive a clear post body through a console form, search query, error, MCP result or audit record after the change.

**Numbering correction:** the privacy deviation is item 9 in `.work/drafts/v2.md`, recorded as decision **27** in `docs/decisions.md`. Decision 9 in that log is the numeric bound, which remains. This draft reverses v2 item 9 / log entry 27 and replaces the plaintext boundary of entry 33. It preserves entry 20 (people alone issue grants) and entry 32 (explicit, passkey-confirmed `device.keys`).

### What this does and does not protect

- A storage reader must not recover content, names, tags, schemas or instructions from DO state, R2, indexes, task results or logs. Each client validates decrypted data before rendering or executing anything.
- A caller must not bypass membership, ownership, card capabilities, admission, ceilings, deadlines or version checks by supplying ciphertext. These checks stay on the server and use authenticated facts, not caller-supplied flags.
- An honest remaining device must exclude removed members before encrypting new content, including new versions of old artifacts. Revocation assumes honest devices validate the actual MLS roster and removal commit; a colluding remaining member can disclose keys/plaintext or omit a removal, which is insider disclosure, not something an opaque server fence can prevent. Reusing a previously shared artifact key is forbidden.
- The server still sees membership, relationships, timing, status, counts, ciphertext lengths and access patterns. MLS does not hide those. Authorization metadata may itself be sensitive.
- Members can retain and disclose material they could read. Hiding a post, deleting an artifact, narrowing visibility, removing a device or leaving a journey cannot erase those copies.
- A compromised endpoint can leak plaintext. A compromised Worker can deny service and can replace the hosted browser code. CSP and a published hash help inspection; they do not make that Worker a trusted key custodian.
- ts-mls 1.6.4 is unaudited. Keep synthetic data only. Encryption does not waive Dan's rule review or the independent security review before real users/confidential data.

### Alternatives

| Choice | Consequence | Decision |
|---|---|---|
| Encrypt whole records, including authority | Server cannot check ownership, private visibility, admission or task expiry without trusting a device | Reject |
| Keep descriptive metadata clear; encrypt bodies only | Names, topics, tags, URLs, instructions and schema examples still disclose content | Reject |
| Keep a small clear coordination record plus audience-bound sealed content | Existing laws remain server-enforced; devices own content and search | Use |
| Encrypt every task/interview to the whole journey | A held request and a private interview become readable by unrelated members | Reject; use narrower groups |
| Reseal old PoC data | Requires an enrolled endpoint to handle every plaintext copy, old version and derived title; cannot undo prior disclosure | Do not migrate synthetic content; reset storage |

## 1. Field inventory

The tables enumerate the baseline stored fields, including fields stored outside the main JSON records. **C** means clear server coordination/authentication data; **E** means sealed content. A rendering/search/copy reader is not a reason to retain plaintext: it moves to the device. The “reader” column cites a current check, not just a type declaration. References are paths and line numbers at the baseline above.

Audience notation:

- **J**: the journey's MLS group, limited to its currently entitled devices/agents.
- **P(owner)**: that person's personal MLS group, with only explicitly enrolled devices/agents.
- **I(round, person)**: a private interview MLS group; participant devices/authorised agents, not the facilitator.
- **T(task)**: the task MLS group; requester, assignee/agent, offering owner and authorised deciders as described in section 2.
- **A(item)**: J for members-visible items; P(owner) for private items and their conversations. An item's owner-only audience is not the whole journey.

A `Snapshot` is `{scalars, maps, defaults?}` (`packages/mcp/src/rules.ts`); the named scalars/maps below exhaust the persisted rule state. Numeric defaults and interned slot tables remain clear because the generated rules read them. Inputs, derived flags and proof code are not additional stored records.

### Journey, people, projects and grants

`JourneyState` is stored under `journey`; see `packages/mcp/src/journey.ts:21-28,43-48,249-255`.

| Record / fields | Class and audience | Current reader/check and required change |
|---|---|---|
| Journey `id`, `rulesHash` | C | Relay group equality and resource routing, `packages/mcp/src/journey.ts:366-376,519-527`; stored-module check `:43-48` |
| Journey `name` | E / J | Display only, `packages/mcp/src/journey.ts:154-156`; listing/summary must return id + sealed descriptor |
| Journey `identities[].id` and array order | C | Stable slot interning/liveness, `packages/mcp/src/journey.ts:52-65`; do not remove/reorder tombstones |
| Journey `identities[].name` | E / J | Display and cached agent names, `packages/mcp/src/journey.ts:164,330,453`; author names from this cache also disappear from clear responses |
| Journey `membership.scalars.{founded,policy,defaultRole,allowed}` and `maps.{Members,Roles,Guides,AddedBy,Pending}` | C | Live-person/agent/guide checks, join policy and last-guide guard, `packages/rules/src/journey.ts:59-126`; host `packages/mcp/src/journey.ts:61-84` |
| Journey `agents[].{id,owner}` | C | Own live agent and effective card check, `packages/mcp/src/journey.ts:69-84`; removal must also update crypto eligibility |
| Journey arrays `projects`, `grants`, `artifacts`, `tasks`, `boards`, `topicRecords`, `targets`, `posts`, `rounds`; `topics`; optional `offerOutbox` | C container/index structure | Individual fields classified below; serialization does not authorise carrying clear nested content |
| Project `id` | C | Project lookup, grant-resource and conversation targets, `packages/mcp/src/journey.ts:461-466,519-527` |
| Project `name`, `purpose` | E / J | Presentation and attached-topic title copying, `packages/mcp/src/journey.ts:167,459,470`; `packages/mcp/src/forum.ts:56-64`. Purpose edits still step the rule before saving an envelope |
| Project `rule.scalars.{exists,status,purposeEdits}`, `maps.Members` | C | Live membership, archive/open checks and no last-member leave, `packages/rules/src/project.ts:38-68`; host `packages/mcp/src/journey.ts:461-472`. No separate stored lead field exists today |
| Grant `id`, `need`, `resource`, `expiresAt` | C | Resource identity/need and expiration, `packages/mcp/src/journey.ts:476-499,519-527`; opaque resource id, never a resource label |
| Grant `rule.scalars.{status,grantor,to,forCommand,forResource,usesLeft,used}` | C | Non-redelegation, live grantor/grantee, exact command/resource and remaining uses, `packages/rules/src/grant.ts:58-85`; host `packages/mcp/src/journey.ts:490-499` |

`seats`, legacy `agentCard` and `transfer` also ship in `packages/rules/src/models.ts`. They do not add another current Journey record: seats has `members`; legacy card has `signed,mayRead,mayWrite,mayGrant,allowed`; transfer has `outcome`. These coordination-only scalars remain clear if persisted. Their checks are `packages/rules/src/seats.ts:11-16`, `packages/rules/src/agentCard.ts:46-76` and `packages/rules/src/transfer.ts:42-70`. No content belongs in a proof snapshot.

### Forum: boards, topics, posts and attached conversations

Declarations: `packages/mcp/src/forum.ts:9-15`. A conversation is an attached topic, not a separate content store. Project/item conversations are created on first post; round creation creates its conversation.

| Record / fields | Class and audience | Current reader/check and required change |
|---|---|---|
| Board `id`; `rule.scalars.{exists,archived,edits}` | C | Lookup/archive check `packages/mcp/src/forum.ts:75-79,133,163-169`; guide-only transitions `packages/rules/src/board.ts:8-16` |
| Board `name`, `description` | E / J | Display only `packages/mcp/src/forum.ts:151-170`. Replace server-created clear `General` (`:43-47`) with client-encrypted default descriptor; an uninitialised board shows its id |
| Topic `id`, `slot`, `boardId?` | C | Routing, board-open check and board filter, `packages/mcp/src/forum.ts:20-34,128-134,175` |
| Topic `target?` (one of `{projectId}`, `{itemId}`, `{roundId}`); Journey `targets[]` | C | Target existence/private-item access and attached-topic deduplication, `packages/mcp/src/forum.ts:48-74,128-130,182-186` |
| Topic `title` | E / topic audience | `packages/mcp/src/forum.ts:86,143-145,182-186` copies target names. Replace name-producing `targetName` with an authorization-only target check. An attached conversation uses A(item), J for project/round, or T for a new task conversation |
| Topic `createdAt`, `updatedAt` | C | Server ordering/activity cursor `packages/mcp/src/forum.ts:176,207,219`; server-generated, not arbitrary caller prose |
| Journey `topics.scalars.selected`, `maps.{Topics,Authors,Locked,TargetTopics}` | C | Unique attachment, lock/edit authority and topic-open check, `packages/rules/src/topic.ts:11-28`; host `packages/mcp/src/forum.ts:107-109,128-134,203-206` |
| Post `id`, `topic`, `createdAt`, `updatedAt` | C | Route, same-topic reply and thread association/activity, `packages/mcp/src/forum.ts:20-34,85,93,115-122` |
| Post `rule.scalars.{exists,author,authorKind,replyTo,edits,hidden}` | C | Author-only editing, reply integrity, hide visibility, `packages/rules/src/post.ts:10-25`; `packages/mcp/src/forum.ts:92-100,115-119,208-219` |
| Post body at `['forumBody', postId]` | E / topic audience | Served at `packages/mcp/src/forum.ts:96-100`, written at `:187-199,216`. Store an envelope reference, never a JSON-encoded plaintext string |
| Derived `authorName`, topic title and snippets | E / same audience, or compute locally | `packages/mcp/src/forum.ts:80-88`; `packages/mcp/src/backend.ts:105-121` enriches names. Remove server-side name enrichment, search snippets and notification excerpts |

Private-item conversations inherit the item's access checks **and** its cryptographic audience. A visibility change must not leave a thread encrypted with the old shared key. Hidden posts remain hidden in server reads, but a device that cached the clear body can retain it.

### Library items, versions and legacy artifacts

Declarations: `packages/mcp/src/library.ts:6-12`; legacy shape `packages/mcp/src/journey.ts:19`.

| Record / fields | Class and audience | Current reader/check and required change |
|---|---|---|
| Item `id`; rule `at`, `owner`, `visibility`, `project`, `version`, `edits` | C | `readableItem/visibleItem/requireItem`, `packages/mcp/src/library.ts:51-59`; valid project `:66-71`; base-version check `packages/rules/src/item.ts:17-27` |
| Item `name`, `type` (MIME), `description`, `labels[]`, `url?` | E / A(item) | Kind inference, label/text filtering and link validation at `packages/mcp/src/library.ts:109-124`; move inference/filtering/URL validation to proxy. Do not preserve clear URLs just for link previews |
| Item `summary?` | E / A(item); remove unused member | Declared at `packages/mcp/src/library.ts:9`, removed at `:160`, but actual link summary is stored in version text at `:124,136` |
| Item `rule.kind` | E / A(item), after rule revision | Currently a clear enum, `packages/rules/src/item.ts:14-15,32`; used only for kind integrity/filter/display (`packages/mcp/src/library.ts:61,110`). Move semantic kind immutability to decrypted schema validation; remove this semantic enum from server rule state, rather than hiding only its duplicate MIME field |
| Item `size` | C, ciphertext bytes only | Today body length `packages/mcp/src/library.ts:77,144`; replace with observed encrypted length/quota accounting. Do not trust caller-declared plaintext length |
| Item `storage` | C format discriminator, fixed `sealed-v1` | Branches at `packages/mcp/src/library.ts:112,137,141`; `packages/mcp/src/journey.ts:375`. Remove plaintext `server` alternative; `isLibraryArtifact` needs an explicit format discriminator |
| Item `versions[].{version,chunks}` | C version/chunk addressing; encrypted chunks | Lookup/deletion `packages/mcp/src/library.ts:80-91,158`; replace text chunks with bounded ciphertext objects and lengths. No clear old-version fallback |
| Version text/summary at `['libraryText',id,version,chunk]` | E / A(item) | Search/get `packages/mcp/src/library.ts:112,136-137`; rounds read/copy/append `packages/mcp/src/rounds.ts:62,157-176`. All these readers move to devices |
| Legacy artifact `id`, `size`, `rule.{at,creator,version,renames}` | C, size becomes encrypted length | Routing/version/deletion at `packages/mcp/src/journey.ts:369-376,502-516`; owner resolution `:405-407`; base-version step `packages/rules/src/artifact.ts:43-51` |
| Legacy artifact `name`, `type`, proxy metadata `name,type,size` | E / J or P(owner); plaintext size E | Current journey metadata leaks at `packages/proxy/src/proxy.ts:143-146`; only personal metadata is carried inside MLS today |
| Legacy `rule.artifactType` | C only as existing opaque interned artifact slot; not content type | Host supplies `state.artifacts.length + 1`, not MIME, at `packages/mcp/src/journey.ts:503`. Rename/document it as an opaque type token or remove it in the format reset; never populate it with a sealed semantic kind |

Private items can be visible to the server as owner-scoped routing records; other members must not receive their ids, envelopes or associated conversations. Moving/copying decrypts at source, creates a fresh destination encryption and, for a move, deletes source only after destination commit. A change to private visibility cannot revoke previously shared versions. In either direction the owner device must stage envelopes for the destination audience and all retained item versions/conversation posts, then atomically commit their manifest with the visibility rule step. Private-to-members needs P-to-J resealing; members-to-private needs J-to-P resealing for retained access and fresh P encryption for future writes. An id-only console may request a pending visibility change but cannot complete it without the owner's enrolled device. Missing keys or partial upload leaves the old visibility and refs unchanged.

### Rounds, interviews and contributions

Declarations: `packages/mcp/src/rounds.ts:10-14`.

| Record / fields | Class and audience | Current reader/check and required change |
|---|---|---|
| Round `id`, `previousRoundId?`, `conversationId` | C | Round routing `packages/mcp/src/rounds.ts:19-24`; closed predecessor `:109-113`; conversation association `:57,130` |
| Round `title`, `goal`, `format` | E / J | Summary and document/title generation `packages/mcp/src/rounds.ts:55,124-130`; device builds encrypted defaults and conversation descriptor |
| Round `guidanceItemId`, `documentItemId`, `relatedItemIds[]` | C | Same-journey shared-item checks and document association `packages/mcp/src/rounds.ts:48-52,114-117,169`. Existence/visibility stay server-checked; text/link/content shape becomes device-checked |
| Round `rule.scalars.{exists,facilitator,status,contributions,lastContributor}` and `maps.{Participants,Shared,Contributions}` | C | Facilitator/status/participant/share/attribution laws `packages/rules/src/round.ts:13-45`; host `packages/mcp/src/rounds.ts:39-44,137-138,163-176` |
| Interview `person`, `itemId?`, `version`, `chunks` | C participant/source/version/encrypted chunk addressing | Private-reader check `packages/mcp/src/rounds.ts:135-141`, assignment guard `:153-156`, addressing `:74,85-93`. Add I group id + shared-copy revision refs; do not expose private sources in journey-wide summaries |
| Interview notes at `['roundInterview',roundId,person,version,chunk]` | E / I(round,person) | `packages/mcp/src/rounds.ts:75-93,158,161`; nobody on the server needs the text |
| Shared interview material | E / J as an explicit published copy | `Shared` currently authorises **any journey reader**, including future members, not only round participants (`packages/mcp/src/rounds.ts:137-138`). See publication semantics below |
| Contribution text | E / J | Not a separate baseline record: server appends it into the document text and versions that item, `packages/mcp/src/rounds.ts:169-176` |
| Contribution count, credited person and per-person counts | C | Attribution uses person even for agents, `packages/rules/src/round.ts:42-45`; host `packages/mcp/src/rounds.ts:33-37,69-70,167-176` |

Replace server append with immutable sealed contribution records `{id,roundId,personId,sequence,createdAt,envelopeRef}`. The server assigns person and sequence while stepping `contribute`; the device composes the document from its base and ordered contributions. It must not accept an arbitrary replacement document under `round.contribute`, which would let a participant overwrite other contributions without `artifact.write`. A separately edited synthesis remains a versioned library item. No CRDT is needed for append-only contributions.

`interview_assign` becomes a source-reference assignment, not a server-side copy. The participant's device fetches the authorised source version and seals the initial notes into I. The facilitator may nominate a source but never receives I's keys. State distinguishes assigned-but-not-materialised from an existing interview; facilitator cannot replace a materialised/shared interview. Source plaintext and future interview edits stay separate.

Keep the irreversible `Shared` mark. A share requires a participant-side encrypted publication to J and commits its reference with the rule step, not a boolean-only change that exposes undecryptable content. Later edits after sharing update both the private record and its shared publication so existing “shared interview” reads remain current. Already published revisions cannot be unshared. A lost second publication must leave both versions unchanged or retry the same prepared bytes, not report a partial successful edit.

### Tasks and requests

Declarations: `packages/mcp/src/tasks.ts:5-9`. This covers ordinary tasks as well as offered requests.

| Record / fields | Class and audience | Current reader/check and required change |
|---|---|---|
| Task `id`, `assignee?`, `deadline`, `createdAt`, `updatedAt` | C | Route/assignee/deadline checks `packages/mcp/src/tasks.ts:22-23,41,53-56`; expiry alarms `packages/mcp/src/journey.ts:267-284` |
| Task `name` | E / T | Display only `packages/mcp/src/journey.ts:144-151`; no clear status-message fallback with the name |
| Task `rule.scalars.{status,creator,claimant,roundsUsed,cap}` | C | Claim, work, cancellation, finality, deadline and round-cap guards `packages/rules/src/task.ts:57-101` |
| Task `offer?.{id,version,agentId,owner,requesterPersonId,requesterIsAgent,agentDefined,admitted}` | C | Offer/version reservation `packages/mcp/src/tasks.ts:29-39`; requester/decider visibility and runnable check `packages/mcp/src/journey.ts:117-130`; settings clamp `packages/mcp/src/tasks.ts:39` + `packages/mcp/src/accounts.ts:214-224` |
| Task `content?.{input,output,reason,outputSchema,resource}` | E / T | Input and output validation currently server-side `packages/mcp/src/tasks.ts:33,40,64-65`; move to both endpoints. Resource **label** is fixed by the offer snapshot, not chosen by requester |
| New questions, answers, failure details and task conversation bodies/titles | E / T | Not implemented at baseline; do not describe them as existing. See section 3 |
| MCP task result, inbox preview and audit descriptions | E / T, or C ids/status only | Existing result reconstructs clear content through `taskView`, `packages/mcp/src/journey.ts:143-151,304-309`; move result decoding to proxy |

Currently admitted offer tasks become visible to every journey reader (`packages/mcp/src/journey.ts:123-126`), while held requests are narrow. **Change that:** metadata allowed by the journey may remain listed, but request/result envelopes and their conversation remain T-only after approval, completion and expiry. Ordinary unassigned tasks start with the requester's devices; claim adds the claimant before any content delivery/work, using an authenticated T admission. Claimants must not be able to join other tasks by guessing ids.

### Agents, account profile and personal group

| Record / fields | Class and audience | Current reader/check and required change |
|---|---|---|
| Account `subject`, `personId`, `live`; `clients[]`; `bindings` | C | Subject lookup/client-bound actor and removal tombstone `packages/mcp/src/accounts.ts:153-189`; binding rule `packages/rules/src/binding.ts:11-34` |
| Account `name`, `nickname?`, `email` | E / P(owner), with minimised routing index | `name/nickname` are display at `packages/mcp/src/accounts.ts:135-145`; email equality invitation at `:148-149`, called after guide check `packages/mcp/src/backend.ts:226-232`. Replace persisted email with keyed HMAC of the same normalised email for invite routing; the encrypted profile holds the real value. WorkOS still knows identity. Do not log/store the raw fetched profile or derive public display names from email |
| Account `group.maps.{Members,Belongs}` and owner/slot parameters | C | Owned-live identity check `packages/mcp/src/accounts.ts:349-352`, personal membership rule `packages/rules/src/personalGroup.ts:19-45` |
| Account `identities[].{id,kind}` and array order | C | Registered live package owner/relay member `packages/mcp/src/accounts.ts:349-360,381-396` |
| Account `identities[].name` | E / P(owner) | Display only; creation `packages/mcp/src/accounts.ts:388`; never use a user label as an authenticated device identity |
| AccountAgent `id`, `live`, `clientId?`, `journeys[]?`, `authorizationPending?`, `pendingConsentId?` | C | OAuth binding/liveness/incomplete-consent refusal `packages/mcp/src/oauth-store.ts:18-22,61-71,82-86`; journey sync `packages/mcp/src/backend.ts:60-93` |
| AccountAgent `name`, `clientName?` | E / P(owner), with authorised J descriptor copies | Actor display currently requires `name`, `packages/mcp/src/agents.ts:7,22`; consent stores it at `packages/mcp/src/oauth-store.ts:64-67`. Use id-only internal actor data; do not keep a duplicate clear `name` to satisfy that type. Unenrolled consent uses id labels, then an enrolled device may set encrypted names |
| AccountAgent `createdAt?`, `lastUsedAt?` | C | Account activity/audit metadata; last-use update `packages/mcp/src/accounts.ts:164-173`. Server-generated timestamps only |
| AccountAgent `card` | C | `signed,allowed,Caps` (plus defaults); live person's current authority intersected on every call, `packages/mcp/src/agents.ts:43-55`, `packages/rules/src/card.ts:11-28`. Binding snapshot `actsAs,asAgent,allowed,Bound,Agents,Revoked` stays C, `packages/rules/src/binding.ts:12-34` |
| Card descriptive name/description/notes, if added | E / P(owner), selected J copies | Only agent name exists now. Do not invent clear optional descriptions while refactoring |
| AccountAgent `offers?`, `offerSettings?`, `standingReceipts?` | C containers / fields below | Ownership and own-agent-only guard `packages/mcp/src/agent-offers.ts:5-18`; standing idempotency `packages/mcp/src/accounts.ts:239-249` |
| Account `agents`, `passkeys`, `assertions` arrays | C structure, nested classification below | Never serialize an enriched object containing content back into Accounts |

Provisioning precedes device enrollment (`packages/mcp/src/accounts.ts:108-111`). It must store only subject/person id, live authority and the email routing HMAC; discard fetched name/email after deriving that index, without logging or temporarily persisting them. Before P exists there is no encrypted profile and no custom display name. The first enrolled device supplies its profile and seals it to P; it does not ask Worker to encrypt without keys. Replace the current passkey registration userName with an opaque person id when no device profile is available.

Profile/name publication is explicit. Owner profile is P; only a public nickname/agent descriptor chosen for a journey is resealed to J. Private email, device labels and passkey labels never go to J. HMAC email indexing is data minimisation, not protection against the live server: that server receives invite addresses and holds the HMAC key. Removing email invitations entirely would reduce metadata further but changes the agreed product.

### Offers, settings, admission and reservations

Declarations: `packages/mcp/src/offers.ts:7-19,90-109`.

| Record / fields | Class and audience | Current reader/check and required change |
|---|---|---|
| Offer `id`, `version`, `status`, `createdAt`, `updatedAt`, `agentDefined?` | C | Lookup/version race/publication and clamp `packages/mcp/src/agent-offers.ts:20-36`; reservation `packages/mcp/src/accounts.ts:211-224`. Replace human-readable slug ids for new offers with opaque ids; a user title must not become an id |
| Offer `content.{name,description,tags,examples,inputSchema,outputSchema?,resource?,instructions?}` | E / P(owner) draft; J copy for each enabled journey | Currently schema checks/display/discovery `packages/mcp/src/offers.ts:88-103`, `packages/mcp/src/journey.ts:359-362`; replace with envelopes and device discovery |
| Offer `journeys` (`'all'` or `string[]`) | C, replaced | Visibility checked both Journey and Accounts, `packages/mcp/src/tasks.ts:32`, `packages/mcp/src/accounts.ts:213`; replace wildcard with explicit journey settings in section 6 |
| Offer `admission.{rules[],default}`; each rule `who`, `journeys?`, `decision`, `limit?.{count,per}` | C | First-match admission `packages/mcp/src/offers.ts:124-129`; same-actor/offer/window count `packages/mcp/src/accounts.ts:215-224`. Person/agent ids clear, no free-text admission reasons |
| Agent-wide settings `publishWithoutReview`, `maxAdmission`, `maxRequestsPerDay` | C | Owner-only, passkey for raising `packages/mcp/src/agent-offers.ts:10-16`, `packages/mcp/src/offers.ts:120-123`; serialized allowance decision `packages/mcp/src/accounts.ts:214-224` |
| Allowance receipt `taskId,agentId,offerId,version,journeyId,requesterId,requesterPersonId,isAgent,isGuide,createdAt,decision` | C | Identity-bound idempotent reservation and rolling counters `packages/mcp/src/accounts.ts:201-229`. Host copies these named fields; requester cannot submit `isGuide`/owner facts |
| Standing decision / `offerOutbox[]`: `id,owner,agentId,offerId,who (person or agent),decision` | C | Created from authenticated creator/decider, `packages/mcp/src/tasks.ts:69-71`; idempotent policy update `packages/mcp/src/accounts.ts:239-249`; durable retry `packages/mcp/src/journey.ts:135-141,257-272` |
| Agent `standingReceipts[]` | C | Duplicate delivery guard `packages/mcp/src/accounts.ts:243,249` |

### Authentication records and transport storage

These are required to authenticate/route, not user content. They are not MLS application secrets. Confidential protocol tokens still need storage access controls, expiry and log redaction.

| Record / every field | Classification and reader |
|---|---|
| AccountsState `rulesHash,accounts,journeys,oauth?,allowances?` | C containers; rules-stamp/load and journey directory `packages/mcp/src/accounts.ts:30-45,117-126`; nested values follow tables above |
| Passkey `{id,publicKey,counter,aaguid?,name?,createdAt?,lastUsedAt?}` | C: credential id/public verification key/counter, registration and last-use timestamps; verified at `packages/mcp/src/agents.ts:35-42`, `packages/mcp/src/console/passkeys.ts:34-43`. E/P: user `name` and optional AAGUID/provider display metadata; AAGUID is currently only rendered, not used to authorise (`packages/mcp/src/console/passkeys.ts:10-11`). Provider mapping moves to browser |
| PendingAssertion `{challenge,digest,expiresAt}` | C, short-lived single-use assertion binding, `packages/mcp/src/accounts.ts:74-90,301-317`; digest binds exact sealed descriptor/version as well as authority change after refactor |
| OAuth clients `{client_id,client_name,redirect_uris,token_endpoint_auth_method,grant_types,response_types}` | C: id, redirects, protocol options for registration/exchange. `client_name` is descriptive, not routing: drop persisted clear custom labels, render origin/id before device enrollment, optionally seal an owner label in P. Current storage writer `packages/mcp/src/oauth-store.ts:37-40`; redirect validation `packages/mcp/src/oauth.ts` |
| OAuth requests `{id,request:{clientId,clientName,redirectUri,challenge,state?,expiresAt}}` | C except descriptive `clientName` (remove/drop). PKCE, exact pending request and expiry are checked at `packages/mcp/src/accounts.ts:73-86`, `packages/mcp/src/oauth-store.ts:44-57,82-90`; OAuth state remains a bounded protocol correlation value, never a content carrier |
| OAuth code `{subject,personId,clientId,agentId,hash,redirectUri,challenge,expiresAt}` | C. Hash comparison, redirect/PKCE and single-use exchange `packages/mcp/src/oauth-store.ts:87-100` |
| OAuth access/refresh `{subject,personId,clientId,agentId,hash,expiresAt,family,used?}` | C. Live bound actor/family rotation/reuse checks `packages/mcp/src/oauth-store.ts:18-32,102-118`. Raw MCP bearer tokens do not persist |
| `console:records` is a map keyed by record id; OAuth value `{kind,state,verifier,returnTo?,expiresAt}`; session value `{kind,subject,clientId,csrf,signedInAt?,expiresAt}` | C, cookie/session/PKCE/CSRF protocol state. Strict shapes `packages/mcp/src/console/contract.ts:18-20`, cleanup/one-use retrieval `packages/mcp/src/accounts.ts:48-65`, cookie validation `packages/mcp/src/console/session.ts:18-39`. Upstream PKCE verifier is a server-required secret, not a content key; bound return route cannot carry arbitrary descriptions |
| `passkey-registration:<personId>` `{challenge,expiresAt}` | C, 5-minute registration check `packages/mcp/src/console/passkeys.ts:28-36` |
| `['keyPackage',personId,deviceId]` public package bytes/null | C opaque public verification/admission material; live owned identity, single-consumption and 64 KiB check `packages/mcp/src/accounts.ts:355-373`. Never store its private half here |
| Relay log `{sequence,epoch,messages[]}`; each message `{sequence,epoch,kind,sender,key,size}` | C routing/order/byte accounting; `packages/mcp/src/relay.ts:30-31,48-75`. R2 `key` is opaque, not a name |
| R2 `['mls',groupId,sequence]` application bytes; `['artifact',groupId,artifactId,version]` bytes | E / group's audience. Handshake commits/Welcome are MLS protocol bytes, not clear application data; `packages/mcp/src/relay.ts:59-64,82-97` |
| `['artifactVersions',groupId,artifactId]` version-number array | C version cleanup `packages/mcp/src/relay.ts:36-42,91-96` |
| New group registry `{groupId,kind,owner/parentId,rosterRevision,epoch,sequence,eligibleDevices,activeDevices,ready,state,supersedes?,generation}` | C proposed routing/revocation/fencing data; derived from existing ownership/membership/task/round checks, not free caller rosters |

### Device-only storage (never uploaded as clear records)

Existing proxy state is `{version,personId,groups}`; a saved group has `mls,deviceId,cursor,own,keys,artifacts,members,blocked`; members have `personId,deviceId,keyPackage`; artifacts have `artifactId,name,type,size,version,deleted` (`packages/proxy/src/proxy.ts:8-19`). These are local recovery/ratchet/content records, not server metadata. Local secret state includes exported MLS bytes and AES content keys. Preserve atomic persistence and one-writer locking. Browser storage wraps these records; plaintext indexes must not escape the device, telemetry or backup exports. Local caches are deleted/locked on account switch and purged for revoked audiences on next synchronization; this cannot erase an adversary's earlier copy.

## 2. MLS groups and lifecycle

### What exists today

The proxy supports `personal_<personId>` and a generic group whose id equals a journey id. `access` routes only those two forms (`packages/proxy/src/proxy.ts:50-54`). The personal group exists as an account coordination roster even before a device creates the cryptographic group. Journey creation/admit does **not** create/join an MLS group automatically.

A device manually calls create/prepare/add/sync (`packages/proxy/src/server.ts:20-24`). Each prepared group registers an owned personal device, generates a key package locally, and persists its private half locally (`packages/proxy/src/proxy.ts:56-73`). Another member consumes its public package, commits Add, and delivers Welcome (`:84-92`). Accounts stores one public package per device and consumes it on fetch (`packages/mcp/src/accounts.ts:355-373`). The current Basic MLS credential is only a label, not proof of account ownership (`packages/proxy/src/mls/group.ts:9-12`).

Artifact bytes use independent AES-256-GCM keys, with group/artifact/version authenticated data (`packages/proxy/src/crypto.ts:3-14`); MLS distributes the keys and artifact metadata (`packages/proxy/src/proxy.ts:17-19,130-135,140-167`). The current key is reused on version update (`:163-164`): removing a leaf alone does not revoke its knowledge of that key. This reuse must end before the new design ships.

The proxy already removes departed leaves before resharing, persists consumed ratchets before network I/O and fails closed on ambiguous delivery (`packages/proxy/src/proxy.ts:75-79,119-127`). Keep these properties. The relay only refuses epoch regression; it accepts any non-regressing epoch and has a 128-message PoC log cap (`packages/mcp/src/relay.ts:53-56`). That is not a sufficient membership/epoch protocol for this design.

### Proposed audiences

| Group | Who is eligible | Creation and closure |
|---|---|---|
| P(person) | Owner's explicitly enrolled devices, and explicitly authorised own agent devices | Owner's first unlocked device bootstraps it. Passkey-confirmed enrollment; removing a device/agent removes its leaves before further content |
| J(journey) | Live person's eligible devices; live journey agents with `device.keys` plus the relevant live journey read authority | Founding device creates it; joining membership marks crypto admission pending. Guide membership admission is not key admission. Last-guide law remains independent of MLS availability |
| T(task) | Requester person's devices and acting requester agent; assignee's devices (for an offered task, offering agent's enrolled client); offering owner's devices; explicitly enrolled owner agents with current `offer.decide` | Requester device prepares it and adds authenticated packages before content submission. Unassigned ordinary task starts requester-only; claim admits the verified claimant. Retain read history for entitled parties while task is retained; terminal status forbids further work, not historical reads |
| I(round,participant) | Participant devices and their explicitly authorised own agents, intersected with live journey access | Participant device creates it on first write/materialisation. Facilitator/guide has no implicit membership. Shared copies go to J, not an Add of the whole journey to I |

Round public descriptors, contributions and ordinary round conversations use J. There is no need for a separate round-wide group while all journey readers can see them. A private library item and its conversation use P(owner), not J. Offer drafts use P; enabled publications use one J envelope each, not one ciphertext with a list of unrelated audiences.

An agent may not obtain keys merely by being named on a task/card or joining a journey. `device.keys` on its live card remains necessary for package publication/consumption, device enrollment and group join. The server also intersects task/round/journey authority; `device.keys` alone is insufficient. Revoking that capability must revoke affected crypto leaves, not merely block future package requests. Direct remote clients without a device implementation receive metadata only. They cannot ask the server to decrypt for them.

Personal-group access is broader than task access. An agent admitted to T does not thereby join P or read its owner's profile, private library or other tasks. The current `personal_group_add` path must bind a registered device to the authenticated principal/agent and its scoped purpose; a device label supplied by an agent is not proof it is a human-owned device.

### Public packages and admission

1. Device generates signing/HPKE keys locally. Keep private packages, signing keys, group state and recovery material on that device. Accounts may keep public packages, owner/device/agent binding, expiry and consumed markers only.
2. Replace unrestricted package consumption by audience-authorised package reservation: `{groupId,deviceId,keyPackageId}`. Host derives the person/agent owner and eligible group from live state. A caller must not drain unrelated packages or substitute another account's package. Reserve/consume a package once per Add; replenish a bounded queue for multiple independent groups.
3. A current member authenticates that binding before Add. For an agent, check bound agent id, owner, live card and group-specific authority. Clients compare the MLS credential/signature key to the endorsed device binding; they must not trust Basic credential text or a plain personId inside an unauthenticated handshake wrapper.
4. The group registry serializes bootstrap, Add/Remove/update commits by expected sequence, epoch and roster revision. Devices validate the actual MLS commit/Welcome, group identity, sender and expected roster change. Server CAS protects ordering; it does not prove opaque MLS bytes are valid. A hostile member can send invalid ciphertext and cause a visible fault, never a new clear fallback.
5. Record membership admitted-but-not-key-ready separately from live application membership. An offline new member does not block existing writers. No content is sent to that device until it processes its Welcome and required commits. An existing authorised device must be online to admit or share history. Server alone cannot recover a lost group.

For an offered T, the requester device is the initial committer. Before finalise it reserves authenticated packages and stages Welcome for requester, offering agent, owner and current explicitly enrolled decider agents; a required missing package leaves creation pending/refused, never a content-bearing task with no decider access. Additional deciders join through a live T member, not by the server reading input. Ordinary-task claim first records a pending claimant admission; the next online requester device commits Add and transfers the task content, then an acknowledged key-ready transition permits work. The claimant sees metadata while pending and the deadline still expires. Being the claimant cannot self-authorise an MLS Add.

If a group is wedged by an invalid opaque commit, irrecoverable state or an expired checkpoint, freeze its writes and mark it faulted. An eligible owner/guide (task requester or offering owner for T; participant for I) authorises a fresh successor group with a new random groupId and registry supersedes link. An honest online device reconstructs the eligible roster, re-admits devices with fresh packages, and transfers only readable cached history into the successor. Commit a new group generation and move record-audience refs atomically before resuming writes; old group stays read-only and its log is not rewritten. If no honest readable device survives, historic content is unrecoverable; starting empty is an explicit owner decision, never server reconstruction. While all remaining devices are offline, the removal fence intentionally stops new writes. Preserve that liveness cost rather than accepting the old epoch.

### Removal, epochs and concurrency

Membership/card/device removal first changes server authority and closes subscriptions immediately. Atomically mark every affected group as needing roster reconciliation. Until an eligible device commits the required removals and the current roster fence is satisfied, refuse new application writes/keys at the old epoch. Read denial alone is not cryptographic revocation.

For each group, commit Remove for every affected leaf, including all removed person's agents/devices, before any new application or history-key share. Update `rosterRevision` and the accepted epoch under CAS; do not allow jumps, stale-epoch applications or a device claiming an invented “current epoch.” Each device processes commits in sequence before applications of that epoch. Concurrent committer losers synchronize, rebuild the membership commit from current state and persist it before delivery. Never replay a consumed ratchet from an old snapshot.

Removal in Accounts affects P and potentially many J/T/I groups; membership removal affects the journey and its child T/I groups. Maintain reverse device/group references and durable revocation jobs. Since DOs have no cross-object transaction, each content-write authorization must consult/fence the current authoritative eligibility revision before publishing. Cached old rosters are not authority. Missing/unreachable authority means refuse; a queued revocation alone is not enough. Reads and notifications also recheck live actor access.

### 2.1 Durable write permits and revocation

A stale actor, card or roster must not let a caller publish after revocation has completed. Accounts owns account liveness, client bindings and agent/card authority. Journey owns membership and journey authority. Neither a cached Actor nor an MLS epoch proves either authority. These write permits are separate from the admission permits in section 6.

**Permit and clocks.** Accounts issues agents a random, single-use permit bound to `personId`, target Journey, intent digest, authority epoch and an absolute expiry. The TTL is 30,000 ms, never renewed. The issuer resolves the authenticated client again and compares the agent/card used for the domain checks with current authority. Journey checks membership and capabilities in its serial turn. For a member acting as a person, that local turn and its atomic transaction are the membership permit: they serialize publication against membership changes without a remote permit or a separate prepare receipt. Personal-group writes similarly re-resolve the client/card and publish within Accounts' own serial turn. Accounts' coarse per-person epoch covers all of that person's agents and bindings. A change to any live/card/binding field advances the epoch. This deliberately drains more writes than a per-capability scheme would.

**Durable ordering for cross-object agent writes.** Journey evaluates a command into a private storage/blob write set before asking for a permit. Refusal publishes neither that write set nor notifications. Permit issuance is the durable `issued` row in Accounts. Journey persists a `prepared` receiver record before requesting redemption. Redemption atomically changes Accounts' row from `issued` to `redeemed`, only while its epoch is current and its TTL has not elapsed. This is the authority-side commit decision. A freeze that wins before redemption refuses the write, even if its earlier capability checks passed. A redemption that wins first is an in-flight earlier write: revocation must drain it, not pretend it did not exist.

Journey publishes the command's storage changes, next alarm, result and `committed` receipt in one local transaction. This is the receiver-side publication point. It checks the expiry before upload and within that transaction. MLS message and artifact uploads use fresh immutable R2 keys; only the transactional log/version index makes them readable. An upload whose transaction aborts is an unreachable orphan, not a published message. Deletions run only after publication; a crash can leave unreferenced bytes, so this protocol does not claim a physical wipe. The existing content format is unchanged.

**Freeze then drain.** Accounts saves authority changes and the epoch advance atomically. All old `issued` permits become `cancelled`; new redemption at the old epoch is impossible. Old `redeemed` permits remain durable and block revocation completion. Journey handles a cancellation request under the same serial turn as writes: it returns the existing `committed` receipt or durably records `cancelled`. Even an as-yet-unknown permit gets a cancellation tombstone, so a delayed prepare cannot revive it. Accounts accepts only a matching terminal receipt for the exact permit, target and digest. Repeated delivery is idempotent; conflicting outcomes are refused. It never waits for Journey while holding its own serial lock. This avoids an Accounts→Journey→Accounts deadlock. Backend drains before and after commands and after console authorization changes, then recovers again on a later request. A drain observes concurrent cancellation RPCs for at most 1,000 ms; a stalled receiver returns pending to the caller. The observation deadline does not cancel the receiver or turn uncertainty into completion.

**Expiry is not a remote cancellation receipt.** Unredeemed permits cannot start after 30 seconds. A caller that vanishes between issuance and redemption therefore stops blocking without a receiver RPC. Redeemed permits must stop publication at expiry, but an uncertain receiver may already have committed. Accounts does not infer an outcome or announce completion just because its clock reached the deadline. It queries/cancels at the receiver and waits for a durable terminal receipt. During a partition that wait has no finite upper bound: a bounded lease cannot prove that a suspended remote transaction stopped. TTL bounds authority to start/finish a new write, not network or crash recovery. This is an explicit safety-over-availability decision. Missing authority, an expired permit, an unknown replay, or an unavailable drain fails closed.

**Crash and replay rules.** On eviction all pending rows and receipts survive. Issuance without prepare is safe because cancellation may create the first receiver record. Prepare without redemption cannot publish; after TTL or an epoch change it is cancelled. Redemption with no publication is cancelled by the receiver after restart. Publication with a lost acknowledgment is recovered as `committed`, never cancelled or executed a second time. Retrying commit with the same permit and intent returns the stored result; a different target, person or digest is refused. Each receipt has its own storage key. The authority index contains at most 128 unresolved permits; terminal authority receipts and receiver receipts have separate immutable keys and are retained without time-based deletion. This bounds the hot index without mistaking age for a receipt. No old ratchet snapshot or newly generated operation is used to resolve an uncertain write.

**User-visible state.** A successful drain means revocation is `complete`. If a receiver is unavailable, the authority change is already frozen and read access is revoked, but the caller sees `revocation: {state: 'pending', retryAt}` rather than a completed removal. Retry/status recovery runs on subsequent backend requests. New writes under that person's authority are refused until the old redeemed permits are drained. `retryAt` is a retry hint, not a completion promise. Cancellation after a recovered commit reports that the earlier write committed. A timeout is never described as proof of erasure or cryptographic roster reconciliation.

The implementation keeps the existing Accounts and Journey class identities/bindings. This protocol is the prerequisite for later group/roster publication, not implementation of the sealed group registry, client MLS enrollment, or content sealing.

Use a fresh per-revision content key for large objects. Do not reshare a prior content key for a new version after removal. Newcomers may receive entitled live/history data only through an explicit history transfer at their current epoch, excluding deleted/private/hidden material they cannot read. MLS does not give a new member old decryption keys automatically. Old devices retain encrypted-at-rest history/cache to read past applications after ratchet erasure; a new device gets resealed history from a live entitled device. Never export raw MLS state as a new-device onboarding shortcut.

Device-local artifact keys are indexed by artifact id and revision, not just one mutable artifact slot. Preparing a fresh key must preserve the key for the last readable revision. Persist the fresh revision key before network delivery; a failed upload must not make the previous revision unreadable. Rotate keys for every revision, even when the MLS epoch is unchanged.

Loss/ambiguity is fail-closed: persist exact outbound bytes and operation id before transmission. After an ambiguous delivery, retry those identical bytes or query the authenticated operation receipt; do not reseal until non-commit is definite. A definite stale-epoch refusal that atomically confirms no committed receipt is different: synchronize commits, keep the same logical operation id/intent, and reseal with a fresh current-epoch ratchet generation. Persist that replacement and revalidate authority/ticket expiry before retry. Never reseal from a restored old ratchet snapshot. A committed operation remains immutable; a different hash is a conflict, not a second operation. The receipt/status response supplies the committed hash and revision so the device can reconcile its journal without duplicating content. Replace the current 128-entry log with bounded per-message records, paged reads, checkpoints and explicit retention/acknowledgment. Pruning cannot strand an offline enrolled device silently; it must rejoin with a new package and explicit history transfer if its checkpoint has expired.

## 3. Server boundary, APIs and search

### Envelope v1

Every content-bearing operation carries a strict sealed envelope:

```text
{ groupId, epoch, ciphertext, contentType, size }
```

- `groupId`: opaque, bounded id (1–200 characters), looked up in the registry and checked against this record's **server-derived** audience. A private interview/task cannot choose J. Route parent/record id and expected revision remain separate clear arguments.
- `epoch`: integer in [0, 2^53), exactly the accepted epoch, plus current roster fence. Handshakes use their own expected-epoch transition contract.
- `ciphertext`: canonical base64, decoded once after encoded-length precheck. It contains an MLS application message. Server never decodes its plaintext. JSON storage contains a blob reference and envelope metadata, not an unbounded base64 value.
- `contentType`: a closed format allowlist, initially `application/vnd.wayfinding.sealed+json;v=1`. This is an encryption format, not MIME of the hidden artifact. Content kind, file name, MIME and schema version of the inner content stay encrypted.
- `size`: decoded ciphertext byte length, recomputed by server and required to match. It is not an assertion about plaintext length or validity.

Proposed bounds: 1 MiB decoded MLS application/handshake envelope; 64 KiB public key package; 10 MiB encrypted blob; 4 MiB decoded bytes total per list/fetch response, at most 100 items. These retain existing relay byte ceilings (`packages/mcp/src/relay.ts:57,70,90`) but remove the whole-log-in-one-value layout. Limit metadata pages below the DO value size. A single content record cannot grow the `journey` JSON toward the 128 KiB limit: store envelopes/messages individually, with opaque refs/version counters in coordination records. Set per-group/member write quotas and retained-byte caps before deployment; reject before allocating blobs or reserving task allowance. Section 8 records the unresolved product retention budgets.

For large artifacts, the MLS application contains an encrypted manifest `{blobId,hash,key,plaintextType,plaintextSize,...}`; the referenced blob uses fresh AES-256-GCM key/nonce per revision. Server sees only the random blob id, encrypted length and parent link. This keeps all content keys distributed through MLS, reuses the current Web Crypto boundary, and does not claim the raw AES blob is an MLS wire message.

Bind inner payload to `{format,groupId,parentId,recordId,recordType,revision,operationId,authorId,epoch}` in authenticated data or the authenticated MLS plaintext. The device compares those fields to the outer route/version and the verified MLS sender binding before use. A server moving an envelope to another post/version/group, replaying an older revision or forging attribution must cause device refusal. Resource instructions cannot come from the outer untrusted envelope.

### Creation, concurrency and side effects

Content is encrypted against a known record id. Add bounded, expiring `content_prepare` tickets for authorised create operations: server allocates the routable id and expected revision, binds it to actor/parent/group and records no live content/task or allowance yet. It returns metadata only. Finalise accepts that ticket, operation id, clear coordination fields and envelope. Validate bytes, audience, authority, revision and expiry before any live write/reservation. Refusal must not consume a live task slot, leak private ids or change rules.

Commit coordination transition + envelope reference + idempotency receipt atomically in the owning DO. Store large immutable blobs before the transaction with unreachable pending refs; reap abandoned uploads separately. A failed commit leaves no readable version. A duplicate finalise returns the prior receipt only when the operation id and exact named fields/ciphertext hash match; mismatched reuse is refused with an authenticated committed-receipt/hash response, never treated as a second create. Check existing receipts after identity authorization but before current-epoch validation so a committed older-epoch retry can resolve. A definite non-commit response permits replacing only the uncommitted ciphertext after synchronization while preserving bound intent; add operation-status lookup so clients reconcile ambiguity without guessing. Network loss after commit must not double-create a post/task or double-count a request.

For offered tasks, retain the Accounts reservation protocol, extended to both cap scopes. Accounts reserves by task id under the same serial authority as offer/settings edits. Journey transaction commits task, ciphertext refs and alarm. Release only after a definite precommit failure; uncertain delivery/release keeps reservation. A postcommit notification failure is not an undo. The server can no longer promise that encrypted input was schema-valid: a hostile endpoint can create bounded invalid ciphertext. It cannot make the receiver execute it.

### Tool changes

Keep friendly local MCP tools accepting plaintext; proxy owns local validation, encryption and decryption. Remote Worker schemas accept only explicit routing/coordination fields plus envelopes. Reject legacy clear fields rather than silently stripping them. `packages/proxy/src/server.ts:25-29` currently forwards coordination tools unchanged: replace that path for **every** content tool, otherwise plaintext will bypass sealing.

| Tool family | Remote contract change |
|---|---|
| `journey_create/read/list`, `project_create/update` | Name/purpose become descriptor envelope; role/policy/status/ids remain clear. `project_join/leave` unchanged. No clear cached member names |
| `board_create/update`, `topic_create`, `post_create/edit`, `conversation_post` | Descriptors/body become envelope; board/topic/target/reply ids remain. `forum_boards`, `topic_list/read`, `conversation_read` return metadata + authorised envelopes. Lock/hide operations remain coordination-only |
| `library_add/version/update/get/search`, legacy `artifact_create/version/rename` and blob tools | All descriptive fields, URL/summary/text become encrypted payload/manifest; fixed sealed format, base revision and visibility/project ids stay clear. Remove `storage:'server'` from new APIs; clear `kind` inference/filter moves local |
| `round_create/next/read`, `interview_write/read/assign/share`, `round_contribute` | Devices prepare/encrypt guidance/document/default descriptors. Assignment carries source id/version only; private device materialises it. Share carries J publication and I reference; contribution carries immutable J envelope. Status/participants stay server-checked |
| `offer_set/list/search/publish/retire` | Definition is P envelope + enabled-J copies at a fixed content revision; metadata/admission/toggles clear. Publish checks required J envelopes exist and audience matches, not schemas inside them |
| `task_create`, `task_step`, `tasks/get`, `tasks/update`, `tasks/cancel`, task inbox resources | Input/output/reason/name and conversation become T envelopes. Status, assignee, deadline, counters, offer reference remain clear. Result and inbox return no clear previews; bound Task extension checks remain unchanged |
| `account_update/read`, agent naming/card consent, personal group/device labels, passkey labels | Descriptive updates are P envelopes; explicit J publication where intended. Card capability sets and verification/challenge material remain clear. Pending authorization binds envelope hash + exact authority choices; encrypted rename cannot widen a card |
| `mls_*` | Explicit group routing/roster authorization, package reservation and expected epoch/sequence. `device.keys` gates all agent key operations, not merely personal relay |

### Schema validation and task exchange

Move `validateJsonSchema`, `validateData`, JSON depth/size limits and link/MIME checks into a shared endpoint-only validator used by proxy and browser. Preserve the currently supported bounded schema subset (`packages/mcp/src/offers.ts:20-87`), reject remote `$ref`, unknown keywords and malicious nesting. Do not fetch schemas or resource URLs while validating.

Requester decrypts the exact published offer revision, validates input, and seals a snapshot of that revision's instructions/input/output schema/resource with the input. Offering agent independently verifies the authenticated publication/snapshot and input before starting work. It never trusts a requester-provided alternate schema or resource. Keep versioned encrypted definitions available for tasks that pin them; changing offer definition cannot rewrite an in-flight contract. Both sides validate output against that snapshot. Server validates envelope shape/bytes only **for content**; it still validates admission, versions, ownership and laws.

The draft offers spec describes `needsInput`, questions/answers and `failed`, but baseline task code has none of them (`packages/mcp/src/commands.ts:65-66`, `packages/rules/src/task.ts:18,58-59`). Implement an explicit terminal failure operation for claimant-side invalid input/output with an encrypted reason and MCP `failed` mapping; never misuse `expired` or `declined`. Add `needsInput`/`askInput`/`answer` if delivering the full exchange stage: claimant asks, only authenticated creator answers, neither consumes an extra round, deadline alarm still runs, and final tasks never reopen. Task conversation bodies use T. No output, schema or reason can grant a capability or trigger a server-side subprocess.

### Search and browsing

Remove server-side full-text/name/tag/label/schema search and clear search queries. Proxy/browser builds a device-local index after authorised decryption. `offer_search` and `library_search` remain local friendly search tools; their remote replacements/list modes accept only ids, clear project/status scope and `(createdAt/sequence,id)` cursor/time bounds. Do not send `query`, tags, kinds or labels upstream. There is no server-side “encrypted search” token index.

Server returns only authorised ciphertexts and metadata by id/time, in bounded pages; it checks private item, interview and task audiences before listing as well as fetching. Proxy decrypts, validates, indexes and filters. A partial/offline index must say it is incomplete and offer sync; an empty local result is not proof no remote record exists. Remove cached entries on revocation/deletion as best effort, and never index another account's cache. Invitations still use their narrow email routing index, not content search.

Released MCP Apps URIs remain registered and byte-stable. Those views currently receive an allowlisted metadata boundary, not content (`packages/apps/src/contract.ts`, `packages/mcp/src/apps.ts`). New decrypting UI needs a new versioned resource; no MLS state/key material enters MCP App metadata. Until a trusted device-backed host path exists, views show ids/status and link to proxy/browser, not decrypted artifacts or access URLs.

## 4. Console browser device

Until the browser device is built, server-rendered console pages show only ids, status, authority toggles, counters and timestamps. Remove plaintext offer/card editing, task inputs/results, forum/library/round text and hidden-field/HTML copies of names. An unauthorised or unenrolled browser cannot ask a server rendering helper to recover content. Use “sealed: enrol this browser to read”. Authority controls continue to work with explicit id/origin labels.

Enrollment requires a fresh user-verified passkey assertion bound to person, browser public device keys and the enrollment operation. WorkOS authentication alone is not device enrollment. Browser runs the same pinned MLS adapter and endpoint validator. Derive a wrapping key from WebAuthn PRF output with HKDF and domain separation for account/origin/device/format; never send PRF output or wrapping key to Worker. Wrap device secrets, private pending packages, ratchet state and encrypted local content cache in IndexedDB using authenticated encryption. Persist state transitions atomically before network I/O; use a browser single-writer lock across tabs/workers. Exported MLS state must never go into cookies, server session records, DOM attributes or logs.

If the passkey lacks PRF, show a generated high-entropy recovery code once and require confirmation before enrollment completes. Derive a separate wrapping key from that code with a documented KDF/domain salt; store only wrapped device state and non-secret KDF parameters. Do not use the account password, a server-held key or a WebAuthn signature as a wrapping key. Recovery unlocks locally; a new browser still generates new device packages and joins groups through a live member. Losing all devices plus recovery material loses content, not account login. Changing/removing passkeys needs rewrapping or revoking the affected browser device; it must not pretend an old wrapper is invalid while its recovery code remains usable.

Use one versioned, reproducible browser bundle, pinned dependencies and a SHA-256 manifest published in the repository/release. Show its expected build hash and provide out-of-band comparison instructions. Serve with a CSP that forbids inline/eval script and third-party script; start from `default-src 'none'`, permit only the pinned same-origin script/style assets, same-origin API connections, and narrowly required local display resources. Include `base-uri 'none'`, `object-src 'none'`, `frame-ancestors 'none'`, restricted `form-action`, no third-party telemetry, and `Cache-Control: no-store` on decrypted responses. Render decrypted text with safe DOM operations; sandbox untrusted HTML/app artifacts and never execute decrypted instructions as page script.

A hash shown by the same server is not independent verification. Self-hosted/local proxy UI is the higher-assurance option; do not promise that SRI/CSP stops a compromised origin replacing both page and policy. Before real data, review bundle distribution, XSS, browser recovery, passkey/PRF compatibility and device enrollment together.

## 5. PoC reset and Durable Objects

**Choose wipe/recreate, not reseal.** Dan identifies live PoC content as synthetic test data. Existing plaintext appears in main JSON, text side keys, old versions, derived conversation titles and console/auth naming fields. Resealing would add a large migration without retracting disclosure. This design authorises no deployment or deletion in this run.

Current bindings are `JourneyV2` and `AccountsV2`, exported from `packages/mcp/src/worker.ts:7`, with v1/v2 creation migrations in `packages/mcp/wrangler.jsonc:16-25`. Decision 32 preserved those classes for an additive capability; this content-format reset is not that compatible case.

Implementation should introduce new explicit classes (proposed `JourneySealedV1`, `AccountsSealedV1`) with a new append-only Wrangler migration tag and new SQL namespaces. Preserve historical migration entries. Bind both new classes together; never route new Journey records against old Accounts identities/allowance state. Give relay objects a new storage generation/prefix (or a fresh PoC bucket), so old object keys cannot collide with new id/epoch logs. All old OAuth grants/sessions reauthorise; all device stores recognise a changed server generation and re-enrol with new packages instead of restoring old ratchets. Passkeys/profile routing are recreated deliberately rather than copied through an unverified Accounts migration.

Cutover procedure: block writes; inventory old classes/bucket prefixes and confirm synthetic-only scope; deploy gate-green new classes/bindings/format; recreate staging identities/devices/journeys; run smoke and raw-storage scan; remove old synthetic namespaces/blobs and obsolete tokens via a separately authorised destructive step. A binding change by itself does **not** delete old plaintext. Do not claim a wipe until old DO data, side records, R2 prefixes and known exported fixtures/backups have been handled under their retention policy. Do not silently delete unrelated legacy data preserved by decision 1; identify it separately.

New loaders require an explicit sealed storage format/generation **and** current rule stamp; no lazy read/write conversion and no accepted predecessor hash that can keep plaintext content alive. If rules change for hidden semantic kinds or task statuses, regenerate all modules/lock, re-prove from any state, cross-check and run broken variants. Keep the server read-only refusal for unknown formats/stamps. Production-like cutover tests must show old records are unreachable and new records cannot accept old clear inputs.

Rollback means restoring the last safe sealed deployment/namespace or staying unavailable. It must not repoint a supposedly sealed service at the plaintext V2 store. Privacy notices change only when the content boundary has passed its full storage/API/log scan; independent review remains required even after synthetic cutover.

## 6. Offers: per-journey switches and limits

Replace `journeys:'all'|string[]` with explicit per-offer entries. New offers are off everywhere, including journeys joined later. No wildcard or absent-entry default-on behavior.

```text
offer: {
  id, version, contentRevision, status, admission, createdAt, updatedAt,
  privateDefinition: envelope(P),
  journeySettings: {
    [journeyId]: { enabled: boolean, maxRequestsPerDay?: positiveInteger,
                   definition?: envelope(J), contentRevision?: integer }
  }
}
agent.offerSettings: { publishWithoutReview, maxAdmission, maxRequestsPerDay }
```

Map entries are bounded by the supported journey count (currently 128), strict named fields only. They contain no name or tag. Owner's P definition is the editable source; the same logical definition is separately encrypted to each enabled J at the same `contentRevision`. Policy/toggle changes bump `version`, while content edits bump both; this distinguishes stale publication from policy-only changes. A hidden content digest is computed over the encrypted publication, not a public hash of plaintext that would permit dictionary guesses.

Effective availability is: published AND this entry enabled AND current-J envelope at matching content revision AND offering agent is a live journey member with live `task.manage` authority AND its endpoint is key-ready. An agent that lost membership/capability cannot remain discoverable by cached publication. Disable affects discovery and **new** requests immediately at the authoritative Accounts check; existing admitted work keeps its pinned definition and deadline. Pending held requests may be declined/cancelled, but approving after disable/retire/removal is refused until a valid re-enable/review. No historical ciphertext can be clawed back.

`offer_set` handles encrypted definition + explicit entries with `expectedVersion`; add `offer_journey_set {agentId,offerId,journeyId,expectedVersion,enabled,maxRequestsPerDay?}` for a one-row change. Enabling supplies a current publication or references an already staged matching envelope. Optional limit omission on create means inherit; on update use an explicit clear-limit action, not ambiguous omission. Retain `offer_settings` as owner-only agent ceiling control. An agent with `offer.manage` may narrow/disable its own publication within its owner-approved scope, not enable a new journey or raise an owner-set journey limit without owner approval. Every server path, including console, uses the same validation and passkey-bound owner ceiling widening.

Console: one row per live journey on an offer, an On/Off control, “inherit agent cap” or positive per-day limit, current usage/held counts, and agent-wide ceiling always visible. Unenrolled console can change routing switches/limits by ids, but cannot edit/decrypt the definition. No automatic enable on membership addition. Turning on must not turn on another offer or journey.

### Limit semantics and the hard cap

- Agent ceiling covers **all offers across all journeys**, never one counter per journey. A journey limit is for this **offer + journey**, across all requesters. Existing per-requester admission limits remain requester + offer across every journey. The effective decision intersects all three scopes; it does not take the maximum.
- Keep the existing agent `maxRequestsPerDay = 0` meaning unlimited for compatibility of settings (`packages/mcp/src/offers.ts:13-15,120-123`). The new optional journey limit is a positive integer or absent/inherit; zero is invalid. The legacy/API name `maxRequestsPerDay` is retained in this draft, but under the admission-permit proposal it counts admitted work, not every saved held request; console labels must say admitted tasks per rolling 24 hours. Keep the API name for settings compatibility, and document that admitted-work meaning explicitly. With a finite agent ceiling, reject a higher journey value; with an unlimited agent ceiling any bounded positive journey value narrows it. Lowering the agent ceiling automatically clamps effective journey limits, without resetting usage.
- Accounts serializes offer edits, publication state, toggle edits and reservations. Reserve checks the current offer version and enabled entry. It decides allow/hold from the per-requester created-request receipt window and the agent-wide + offer/journey admission-permit windows; only allow or later approval issues a permit. Repeated identical task id returns the same decision; mismatched identity, group, journey, content revision or ciphertext receipt binding is refused. Retain one week of request receipts so policy edits/disable/re-enable cannot reset counts.
- Current code counts created requests, including held/completed/cancelled, and turns overflow into hold (`packages/mcp/src/accounts.ts:219-225`). Deny/invalid envelope creates no task/receipt. Do not refund committed cancelled work or lost replies. Preserve this request-counting rule for per-requester policy; ciphertext prevents server proof of semantic input validity, so receiver-refused malformed requests still count.
- **Hard-cap proposal:** no automatic allow, standing allow **or manual approval** can bypass a finite owner cap. Baseline approval only checks the offering agent is runnable (`packages/mcp/src/tasks.ts:58-61`) and does not recheck quota. That must change. Overflow stays held, rather than being silently accepted because a decider clicked Approve.
- To avoid counting a held request twice, keep request receipts distinct from admission permits. A task obtains one idempotent admission permit under Accounts serialization when entering claimed: immediately on allow or later on approve. Finite agent and offer/journey caps bound permits issued in the preceding rolling 24 hours; existing per-requester created-request limits still use request receipts. Cancel/completion does not refund a permit. Held requests without permits cannot execute. Permit ambiguity consumes capacity until expiry; definite Journey precommit failure can release it using the existing conservative protocol. Approval and cap reduction race in the same authority; current lower cap governs new permits. A cap reduction below already-issued usage blocks further permits until the window clears, not retroactive cancellation.

**Approval accounting chosen for this design:** daily owner/journey ceilings count admission permits, not held task rows. This replaces the daily created-request counter in decision 33; per-requester policy retains created-request receipts. The dispatching session confirmed that both ceilings are checked at reservation, journey limits cannot raise the agent ceiling, and approval cannot exceed it: excess stays held. Reserve issues one permit only for allow; approve issues one only after checking both current permit windows. The same task can never obtain two permits. A hold caused by owner-review policy may be manually approved within caps; an exhausted finite cap cannot be overridden. No claim is made that Dan selected the implementation's counting mechanism.

## 7. Ordered build stages and proofs

These are implementation slices and acceptance checks, not permission to build in this run. Proposed test names/paths below are specifications for future tests, **not existing green evidence**. Keep the production cutover behind the full slice set; individual merges may remain synthetic-only or feature-gated. Each slice runs the root named gates after its last edit: `npm run check:rules`, `npm run typecheck`, `npm test` (exit 0 required). Model changes also run `npm run build:rules` and commit generated bytes/lock; prove steps with `{from:'any'}` and require `proven && checked && !assumes`, crossCheck and interpreter/generated equivalence. Never use reachable-only `gate()` on stored data.

| Order | Deliverable and acceptance criterion | Proving test (to add) and failure case |
|---|---|---|
| 1 | Freeze field contract, format generation, envelope bounds and audience registry; server cannot accept a content field outside its envelope | `packages/mcp/test/sealing-contract.test.ts`: `sealing rejects every legacy clear content field without writes`; matrix covers all tools/console aliases, wrong/unknown fields, noncanonical base64, wrong size/type/group, stale revision/epoch, oversized pages. Assert storage, blobs and allowance counts unchanged |
| 2 | Scoped device binding, single-use package reservation, P/J lifecycle and revocation fence; removal prevents new decryptable content | `packages/proxy/test/sealing-groups.test.ts`: `sealing admit remove rotates every device before new content`; three devices including owner/agent, malicious credential/package substitution, drained/replayed package, device.keys revoked, offline removed leaf, concurrent commits, guessed group. Add revoke-between-check-and-commit/crash schedules, invalid commit→successor recovery, and no-surviving-device blocking cases. Removed device attempts decryption of a NEW version of an OLD artifact and must fail with honest remaining devices |
| 3 | Ratchet-safe immutable storage, fresh large-object revision keys, bounded history transfer/paging and idempotent writes | `packages/proxy/test/sealing-recovery.test.ts`: `sealing lost replies never reuse ratchets or duplicate records`; crash before/after persistence/post/commit, reordered/replayed messages, stale snapshot, missing checkpoint, new device history, hidden/deleted/private exclusions, swapped group/version/context, bad tag/hash. Verify byte-identical retries and no nonce/key reuse |
| 4 | Seal profiles/agent/device/passkey labels and journey/project/forum/library descriptors and bodies; proxy replaces pass-through for these tools | `packages/mcp/test/sealing-content.test.ts` + `packages/proxy/test/sealing-content.test.ts`: `sealing content and names never reach server stores or results`. Unique canary in EACH inventoried content field, old version and derived title; scan DO/R2/result/error/log captures. Stranger/private-item/locked-topic/baseVersion tests stay negative; local kind/URL/schema malicious-input tests go red if validation is removed; pre-enrollment provisioning must persist no name/email, and both visibility directions require complete destination item/thread manifests |
| 5 | Seal round/interview/contribution workflows without widening delegated effects | `packages/proxy/test/sealing-rounds.test.ts`: `sealing facilitator cannot decrypt private interview`; participant materialises assigned source, share/update atomic copies to J, future member gets only published history; removed participant cannot write. Two concurrent contributions remain ordered/attributed without overwrites; round.contribute cannot replace synthesis or another person's contribution; round_next only from closed |
| 6 | Explicit offer journey switches, revisioned encrypted publication and subordinate limit reservations | `packages/mcp/test/offer-journeys.test.ts`: `offers disabled journey cannot discover reserve or approve`; default-off/future-join/off-one-of-two journeys, wrong audience/missing publication/stale version, agent scope widening denied. `offers simultaneous journeys share one hard ceiling`: concurrent Journey DOs, several offers/requesters, cap reduction/toggle race, boundary at exactly 24h, standing/manual approval at ceiling, cancel/no-refund, idempotent lost reply/release; prove no extra permit. Assert one permit per task and no double count on approval |
| 7 | Seal T task input/output/reasons/conversation, pin definition version; endpoint schema checks and explicit failed/needsInput transitions | `packages/proxy/test/sealing-tasks.test.ts`: `sealing hostile requester cannot replace schema resource or task audience`; malformed input rejected locally and independently by receiver, bad output not presented as valid, stale definition isolated, nondecider/other member cannot decrypt held OR admitted task. New rule laws/broken variants test creator-only answers, no round consumed by question/answer, no work before permit, failure finality and expiry after DO eviction. Keep Task extension `-32021` tests |
| 8 | Device-local discovery and metadata-only console/MCP Apps fallback across all routes | `packages/proxy/test/sealing-search.test.ts`: `sealing queries tags and snippets never cross remote boundary`; encrypted fixture decrypts/searches locally, paged sync, partial index disclosed, account switch/revoke purges local result. `packages/mcp/test/sealing-console.test.ts`: `sealing unenrolled console and apps expose ids status only`; scan HTML/forms/structured results/notifications for canaries, legacy URIs byte-stable |
| 9 | Browser device, passkey PRF/recovery wrapping, safe rendering and reproducible bundle | `packages/mcp/test/sealing-browser.test.ts` plus browser integration: `sealing browser enrollment needs exact fresh passkey binding`; wrong origin/account/replay/no-UV refused; supported PRF unlock, unsupported PRF recovery confirmation, wrong code/tampered wrapper, reload/tab race/logout, no key in HTTP/log/DOM, XSS canary inert, CSP forbids inline/eval, built hash matches published manifest. No server decryption fallback |
| 10 | Staging reset with sealed-only classes/generation, reauthorization and end-to-end rehearsal | `packages/mcp/test/sealing-cutover.test.ts`: `sealing old format and tokens cannot enter new generation`; bind new Accounts/Journey pair, old body/URL/title keys cannot load; revoked device old cache cannot write; new-user two-device offer→request→interview→share→remove rehearsal; storage and log scan sees ciphertext/allowlisted metadata only. Dry-run Worker bundle and explicit staging smoke; inventory proves authorised old synthetic storage removal before claiming wipe |
| 11 | Launch review and documentation | Independent security review covers group binding/revocation, envelope substitution, host JS trust, recovery, schema trust, metadata leakage and ceilings; Dan reviews rules. A checked launch-gate fixture refuses real-data mode when either review is missing. Update decisions/ontology/privacy guide and new Apps resources together; a red gate, unresolved security gap or incomplete storage scan keeps synthetic-only |

Negative controls are required: remove each audience/size/schema/permit check in a test variant and require the corresponding hostile-input test to fail. A positive roundtrip or a mock echo alone is not proof of privacy or authority. Capture failures without logging plaintext. A storage scan does not replace MLS/library security review.

Dependency note: stages 4/5 and 6 can be developed independently after 1–3; stage 7 needs 6; search/metadata fallback should land before any sealed-only deployment; browser work follows stable device/group contracts. Do not expose a half-plaintext rolling deployment as sealed.

## 8. Declared gaps and handoff questions

1. **Cross-object revocation:** the normative protocol is specified in section 2.1. Existing Journey commands and relay publication use the fence before any content sealing. Future J/T/I group registries must use the same receipt/drain boundary; a roster outbox or a revision preflight is not a substitute.
2. **Recovery policy:** proposed default is no server escrow; loss of all devices/recovery loses content. Confirm recovery UX, code custody and supported PRF browsers/passkey providers with a real browser compatibility test. Account recovery is not key recovery.
3. **Device trust and agent isolation:** implement authenticated device/signature-key binding, purpose-scoped enrollment and live authority fencing. MLS Basic labels and today's personal-device registration are insufficient for hostile callers. A compromised server substituting initial device bindings remains a key-transparency/out-of-band verification gap; independent review must decide the launch requirement.
4. **History/retention budgets:** define per-group retained bytes/messages, upload lifetime, offline checkpoint lifetime and which live history newcomers get. Proposal is entitlement-filtered live retained history, consistent with today's proxy reshare. No unbounded one-value DO log. Do not silently evict key history or claim deletion of a member's copies.
5. **Sharing semantics:** this draft preserves irreversible journey-wide interview sharing, including future readers and subsequent shared updates; only its private workspace stays in I. Confirm that UX before implementing multi-envelope atomic writes. A change to snapshot-only sharing would be a separate explicit product change.
6. **Synthetic reset scope:** dispatching session must verify exact old classes/bucket prefixes/exported fixtures, staging-only authority and any retention obligations before destructive cleanup. No deletion, deployment, secret change or live data migration is authorised by this document alone.
7. **Capability-only authors:** current post-only/create-only agents can write without read. A device with a shared MLS epoch can decrypt that audience's new content cryptographically, even if API read is blocked. This draft requires read authority for J key enrollment; such agents must gain explicit owner-approved read + device.keys or remain metadata-only. Do not silently grant read. If write-without-decrypt must be retained, it needs a distinct sender-only encryption design and review, not ordinary J membership.
8. **Review/assurance:** ts-mls audit status, browser distribution integrity and full threat-model review remain launch blockers. No claim here that tests prove a malicious authorized member cannot disclose plaintext.

These gaps block the affected implementation stages, not completion of this design draft. Split them into the owning tracker before implementation rather than copying progress state into this file.

## Decision entry draft (copy into `docs/decisions.md` during implementation)

### 35. Seal all non-routing content; scope offers per journey

- **Decided by:** Dan (2026-11-11) set the encryption boundary and per-journey offer switches. This draft proposes the group/API/browser/reset details; unresolved choices are listed in `.work/drafts/sealing.md`.
- **What:** content not needed for server routing, authorization, admission, bounded storage or coordination laws is encrypted at the device using MLS audiences. This includes post/topic/board text, interviews, contributions, library metadata and versions, project/journey names and purposes, account/card descriptions, offer schemas/instructions and task requests/results/conversations. Descriptive copies and search queries stay off the server too. Authority/capabilities, ownership, memberships, lifecycle/version counters, deadlines, admission policy and byte accounting remain clear and enforced server-side.
- **Groups:** journey material uses the journey group; private interviews and task exchange use narrower groups; private account material uses the personal group. Removing a device/person/agent revokes its leaves before new content. New versions never reuse keys known to a removed member. `device.keys` still needs explicit passkey-confirmed consent and never grants unrelated authority.
- **Offers:** each offer has explicit on/off settings per journey and may set a lower journey limit. No journey override or approval may bypass the agent-wide hard ceiling. Daily ceilings count idempotent admission permits issued on allow/approve in a rolling 24-hour window; held requests without a permit cannot execute. Both scopes are checked at reservation and approval, while per-requester policy retains created-request receipts.
- **Clients:** proxy/browser validate decrypted content and schemas. The server accepts bounded envelopes, never plaintext content. Search is device-side. Until the browser MLS device is enrolled/unlocked, the console shows ids/status only. A PRF passkey or recovery code protects browser keys; the hosted JavaScript trust limit is disclosed.
- **PoC:** use a sealed-only storage generation and reset synthetic PoC data rather than migrating plaintext. Separately verify and authorise deletion of old synthetic copies; changing bindings alone is not a wipe. ts-mls remains unaudited and the rule/security review gate still blocks real confidential data.
- **Supersedes:** `.work/drafts/v2.md` design item 9 and decision 27's server-readable PoC privacy exception; decision 33's plaintext content boundary and wildcard offer-journey scope. Decision 9's numeric bound, decision 20's person-only grants and decision 32's explicit device authority remain.
- **Source:** Dan's sealing/per-journey-offers brief (2026-11-11); `.work/drafts/sealing.md`. Do not mark the implementation complete when copying this decision.
