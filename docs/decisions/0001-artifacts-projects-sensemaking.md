# 0001. Artifacts, projects, sensemaking rounds, and public and private journeys

- **Date:** 2026-09-30
- **Status:** Accepted. Terms are provisional until the journey ontology (`docs/ontology.md`) is approved; where they differ, the ontology wins and this record is updated.
- **Decider:** Dan Blah

## Context

A journey currently holds text items (title, body, tags, type, versions, comments). Every member holds the one journey key, so every member can read everything, and nothing is private to one member. The server stores encrypted records only and has no file storage. Search and filtering run in the browser.

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
6. **An agent has the same access as the member who added it** and follows that member's access when it changes. It can hold no more than that member.
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

15. **A private artifact** can be read only by its author and the author's agents. The author can later share it with the journey or with one named person, such as a facilitator. Neither the server nor other members can read it; they can see that it exists, its size and date. It always shows whose it is.

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
26. **Contributing.** The member's agent follows the round's instructions and adds findings to the shared sensemaking document, which is collaborative. The interview itself stays private. Each addition is marked with its contributor and round, and the member confirms each addition before it is saved.

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
- Hardening: key-bound sessions, log rollback, signed records, expiry.
- Second independent security review.

## Naming (settled 2026-09-30)

- **Member** (kinds: person, agent); **guide**; **facilitator**; **author** for the member who can read a private artifact. "Owner" and "wayfinder" are not used in the app.
