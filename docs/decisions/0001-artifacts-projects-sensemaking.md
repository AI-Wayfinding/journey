# 0001. Artifacts, projects, sensemaking rounds, and public and private journeys

- **Date:** 2026-09-30
- **Status:** Accepted. Terms are provisional until the journey ontology (`docs/ontology.md`) is approved; where they differ, the ontology wins and this record is updated.
- **Decider:** Dan Blah

## Context

A journey currently holds text items (title, body, tags, type, versions, comments). Every member holds the one journey key, so every member can read everything, and nothing is private to one member. The server stores encrypted records and has no file storage. Agent links let it decrypt journey content while answering a live link (the explicit exception recorded in D31). Search and filtering run in the browser.

We want a journey to hold any kind of artifact, group work into projects, keep some material private to one member, and run sensemaking repeatedly. We also want journeys that anyone can read, so a member can publish an artifact from a private journey.

## Decisions

### Journeys

1. **A journey is private or public, chosen at creation.**
   - **Private** means end-to-end encrypted. Only members can read its content.
   - **Public** means not encrypted. The server stores content readably, and the journey is clearly labelled "Public: not encrypted".
2. **Listing.**
   - A private journey is either unlisted (reachable only by invite link) or listed to signed-in users. It starts unlisted.
   - A public journey is unlisted, listed to signed-in users, or listed to anyone.
   - Listing a private journey makes its name, short description and joining setting readable by the server. The creation form and settings warn about this. All other content stays encrypted.
3. **Joining** is open or invite only, for both types.
   - In a private journey only a member's browser can hand over the journey key. A join request is therefore approved by a guide. With open joining it is approved automatically the next time any guide opens the journey; until then the person sees "Waiting for a member to let you in".
4. **Default role for new members** is read-only or read-write, set per journey.

### Members and roles

5. **Every member is read-only or read-write.** Only guides can change a member's role.
6. **Amended by D45.** **An agent has the same access as the member who added it** and follows that member's access when it changes. It can hold no more than that member.
7. **Guide** is the name for a member who can manage members (today's `members.manage` grant). **Member** is the one word for anyone in a journey; its two kinds are **person** and **agent**. "Wayfinder" stays a website word and is not used in the app. A **facilitator** runs a sensemaking round and is not necessarily a guide.

### Artifacts

8. **Artifacts replace items.** A journey holds one kind of thing, the artifact. Today's item types (note, decision, question, learning, tension, practice, success, resource) become suggested tags. Existing journeys are migrated automatically.
9. **Artifact types:**
   - skill
   - prompt
   - document (Markdown)
   - image
   - file (any attachment)
   - HTML
   - applet
   - link: URL, title, summary and notes. The server never fetches the URL; the person or agent supplies the title and summary.
   - interview
   - sensemaking document
10. **Every artifact** has free tags, versions, and comments on the whole artifact. Comments on a selected passage come later.
11. **Files** are encrypted in the browser before upload (in private journeys). Limit 25 MB per file.
12. **HTML** opens in a locked-down frame on a separate web address. Scripts run, but cannot reach the network or the journey.
13. **Applets** run only in the browser, in the same locked-down frame. No server code. An applet that needs storage gets a small store the browser encrypts, shared with the whole journey.
14. **Visibility follows the journey.** An artifact is visible to exactly the people who can see its journey. To make something public, a member shares a copy into a public journey; the copy records where it came from.

### Private artifacts

15. **Amended by D45** for the person-vault audience of agent-created artifacts. **A private artifact** can be read only by its author and the author's agents. The author can later share it with the journey or with one named person, such as a facilitator. Neither the server nor other members can read it; they can see that it exists, its size and date. It always shows whose it is.

### Projects

16. **A project** is a grouping inside a journey with a purpose, members and a state: getting started, active, looking for others, or archived.
17. **Anyone in the journey can join or leave a project.** Any project member can edit its purpose and state.
18. **An artifact belongs to one project or none.** Project artifacts are available to everyone in the journey but hidden from the main list unless someone filters for them.
19. **Archived projects** stay readable and can be reopened.
20. **Agents** have the same project access as the member who added them.

### Sensemaking rounds

21. **Sensemaking never stops.** A journey runs sensemaking rounds regularly, in different formats. The round done so far is "initial position and heading".
22. **A round has:** a purpose; interview guidance (script, crib notes, guidance); a sensemaking document; instructions for contributing to it; related artifacts; and a status.
23. **Round states:** planning, gathering, making sense, complete.
24. **A round belongs to the journey or to one project.**
25. **Interviews** belong to one round and one member. They are private by default and labelled with the member they are about. The interview is run by the member's own agent or by a facilitator; if a facilitator runs it, the facilitator can read it by default and the member is told before it starts.
26. **Amended by D45**: an authenticated member agent may confirm with its person's authority; there is no extra person-only confirmation. **Contributing.** The member's agent follows the round's instructions and adds findings to the shared sensemaking document, which is collaborative. The interview itself stays private. Each addition is marked with its contributor and round, and the member confirms each addition before it is saved.

### Interfaces

27. **Three interfaces stay in step:** the web app, the client (CLI and MCP), and the agent link. Shared read logic (overview, list, filter, search, show, comments) lives in `core` and all three use it. A parity test runs one journey through the client and the agent link.
28. **The agent link stays read-only.** It can create drops.
29. **Drops.** An agent asks the agent link for a drop, giving title, type, tags and filename. The server returns a single-use drop URL (24 hours), a status URL, and a line the agent can pass to the person. The person opens it, signs in, reviews the agent's proposed details as plain text, uploads or pastes the content, and adds it. Their browser encrypts and signs it as them, marked "suggested by <agent>". The proposal's metadata passes through the server in plain text and is deleted once used or expired.

### Compatibility

30. **Clients 0.1.3 and older must update.** The new features need new log entry types. Only Dan and Reset use the client so far.

## Order of work

Each stage ships on its own:

0. Journey settings and member roles (read-only and read-write, guides, agents inheriting access).
1. Artifacts and file storage (includes migrating items).
2. Projects.
3. Private artifacts.
4. Sensemaking rounds.
5. HTML and applets.
6. Public journeys, listing, joining and sharing copies.
7. Agent-link parity and drops.

The journey ontology comes before all of them. Workspecs stay drafts until it is approved.

## Separate backlog

- Account deletion.
- Hardening: key-bound sessions, log rollback/checkpoints, signed records and expiry. Historical wraps for authenticated member agents are required by D45.
- Second independent security review.

## Naming (settled 2026-09-30)

- **Member** (kinds: person, agent); **guide**; **facilitator**; **author** for the member who creates an artifact (amended by D38). "Owner" and "wayfinder" are not used in the app.

## Amendments 2026-09-30

These decisions replace the earlier rules where they differ. Unchanged rules still apply. They record the agreed model, not shipped behavior.

31. **Agent links are an explicit encryption exception.** Amends D1 and clarifies D28. When a member deliberately creates a live agent link, the server may decrypt the content available through it while answering. Private artifacts never appear through agent links, including their existence.
32. **Guides change journey settings.** Amends D2–D4 and D7 by assigning settings authority to guides.
33. **Amended by D45.** **Personal controls are separate from content roles.** Amends D5 and D7. Read-only members can manage their own profile, manage their own agents and leave. Person guides may be read-only or read-write. Agents cannot be guides. Leaving or removing a member must preserve at least one person guide.
34. **Amended by D45.** **An agent follows its adding member's access, with one limit.** Amends D6. Its access is always that member's access, limited by the read-only or read-write setting chosen when the agent was added. There are no other agent-specific access rules. A read-only agent never gains writes when its member gains them; a read-write agent cannot write while its member is read-only. D28's read-only agent links remain read-only.
35. **Agents follow their adding member into projects.** Amends D17 and D20 to settle participation as well as access.
36. **Amended by D45** for the person-vault audience and uncapped agent authority. **Artifacts are shared between journeys, not directly between members.** Amends D14–D16, D18 and D25. The author may share an artifact into another journey they belong to. A private artifact stays private in the destination. A non-private artifact takes the destination journey's visibility; in a public journey it is public. The author remains its author. Private artifacts are invisible to everyone else, including their existence. The author's agents act within that author's access under D34; no separate recipient grants exist. This replaces named-person sharing and D25's default read grant to a facilitator who is not the author. Projects remain groupings, not sharing destinations or new access boundaries. Shared copies still record their origin under D14; public disclosure of that origin is the one remaining decision for Dan.
37. **Read-write members create rounds and assign facilitators.** Amends D7 and D21–D24. A round includes all journey members by default. Its creator may choose a subset at creation. The facilitator moves it forward and may skip a stage, go back or reopen it. Complete ends that round, not sensemaking.
38. **Amended by D45** for agent-created private artifacts; agent authorship remains distinct. **The creator of an artifact is its author.** Amends D15, D25 and Naming. The author is separate from the member an interview is about. A facilitator may mark an artifact as a given member's interview document for the round. This label does not change its author or grant access. A private interview created by a facilitator is that facilitator's private artifact, not automatically the interview subject's.
39. **Data is an artifact type, and applets can use it.** Amends D9 and D12–D13. Data includes JSON, CSV, SQLite, TOML, YAML and similar formats, with a data view. Public and private applets may read any data available to the user viewing them. This explicitly replaces D12's "no journey access" rule for applet data reads. No network access remains the rule. Applets still run only in the browser; D13's small encrypted, journey-shared store remains separate from access to data artifacts.
40. **Journey visibility type is fixed in this release.** Amends D1. The model and storage must allow conversion to be added later. This release offers no private-to-public or public-to-private conversion.
41. **Each journey chooses one of three joining policies.** Amends D2–D3 and D7, for both private and public journeys: anyone may request and a guide approves; anyone joins immediately; or invitation only. Guides issue and cancel invites, and may refuse join requests. This replaces D3's automatic approval on the next guide visit. Immediate private joining must not depend on a guide opening their browser; how to deliver keys safely is for the build.
42. **Drops are general-purpose delivery links.** Amends D28–D29. The member who creates a drop gets a URL that anyone with a web browser, or an agent, can use to deliver content. The drop's creator always approves inclusion into the journey. Delivering content is not a journey write and gives no membership. Agent links can still propose drops, but drops are not limited to agent-link proposals. Single use, 24-hour expiry, a status URL, plain-text review of proposed details, browser encryption of private content and deletion of proposal metadata after use or expiry remain from D29. Approval does not itself grant content-write authority under D5. The build must enforce both the creator's approval and authorized inclusion, including when the creator is read-only. Suggested-by attribution is retained when there is a suggestion.

43. **Each member chooses their public visibility.** Settles the public-origin question left open by D36. Each person member has a visibility setting: **public** or **journeys only**. Public: in public journeys, artifacts they author show their display name and profile picture. Journeys only: in public journeys, their artifacts say "a member", with no name or picture. Other members of the journey still see them as usual. A private source journey is never named publicly. The profile holds only display name and profile picture for now.

44. **Amended by D45**: the subject's agents have the subject's read access. **The member an interview is about can read it.** Amends D36 and D38. When a facilitator marks an artifact as a member's interview document, that member can read it. The author does not change, and nobody else gains access. The subject can read it but cannot edit it, unless they are also its author. This is the one exception to "private artifacts are invisible to everyone but their author".


## Amendment 2026-10-07

45. **A member agent has exactly its adding person's live capabilities.** Amends D6, D15, D26, D33, D34, D36, D38 and D44 wherever they impose an agent-only limit. Every authority check uses the adding person's current role, guide authority, participation and private access. If the person can do it, the agent can do it. An agent never exceeds or outlives the person; removal, expiry or loss of a capability applies immediately. The setting chosen when an agent was added is no longer a limit. Old stored read-only/read-write agent settings are accepted and ignored.

    The agent remains a distinct identity only for attribution as author/writer, its credentials and keys, and addition/removal by its person. It signs as itself, never with the person's keys. Agents have no vault: agent-created private artifacts live in the person's vault and are readable and writable by the person and all of that person's live authenticated agents, subject to the person's current access. Agent authorship remains visible. The same audience and authority apply to vault initialization, signed headers, key delivery, backups and cross-journey copies.

    D28/D31 URL agent links are a different credential and are unchanged: read-only, no private content or existence, no member-control or vault access. This decision does not bypass credential possession, format/signature checks, last-person-guide preservation or limits that apply equally to the person.

46. **Read-only members fetch private vaults without padding writes.** Amends D36's private-vault traffic policy. Operator decision by Dan Blah, 2026-10-07: on open and each five-minute sync, read-only people and their agents only GET the signed header and two slots; they do not PUT. They cannot create private content, so skipping the padding write reveals nothing. Read-write members still GET and PUT the signed header and exactly two slots even when nothing changed. First-open whole-vault fetch, verification and rollback checks are unchanged; this grants no read-only write authority.
