// Stable ids are the keys in card.Caps. Only these entries are assignable.
// Account actions require a live account; journey authorities are checked live
// by the host. owner/lead/facilitator include the relevant object's identity.
export type CapabilityScope = 'account' | 'journey'
export type BaseAuthority = 'member' | 'write' | 'guide' | 'owner' | 'lead' | 'facilitator'
export const capabilities = [
  {id: 0, name: 'journey.create', scope: 'account', authority: 'member'},
  {id: 1, name: 'account.nickname', scope: 'account', authority: 'member'},
  {id: 2, name: 'agent.remove', scope: 'account', authority: 'member'},
  {id: 3, name: 'read', scope: 'journey', authority: 'member'},
  {id: 4, name: 'artifact.write', scope: 'journey', authority: 'write'},
  {id: 5, name: 'artifact.delete', scope: 'journey', authority: 'owner'},
  {id: 6, name: 'post', scope: 'journey', authority: 'member'},
  {id: 7, name: 'topic.create', scope: 'journey', authority: 'member'},
  {id: 8, name: 'board.manage', scope: 'journey', authority: 'guide'},
  {id: 9, name: 'project.create', scope: 'journey', authority: 'write'},
  {id: 10, name: 'project.edit', scope: 'journey', authority: 'lead'},
  {id: 11, name: 'task.manage', scope: 'journey', authority: 'write'},
  {id: 12, name: 'round.create', scope: 'journey', authority: 'write'},
  {id: 13, name: 'round.run', scope: 'journey', authority: 'facilitator'},
  {id: 14, name: 'round.contribute', scope: 'journey', authority: 'member'},
  {id: 15, name: 'member.invite', scope: 'journey', authority: 'guide'},
  {id: 16, name: 'member.admit', scope: 'journey', authority: 'guide'},
  {id: 17, name: 'member.remove', scope: 'journey', authority: 'guide'},
  {id: 18, name: 'journey.policy', scope: 'journey', authority: 'guide'},
  {id: 19, name: 'grant.issue', scope: 'journey', authority: 'member'},
] as const satisfies readonly {id: number, name: string, scope: CapabilityScope, authority: BaseAuthority}[]
export type Capability = typeof capabilities[number]['name']
export const capabilityCount = capabilities.length
// These actions have no capability id and therefore cannot enter Caps.
export const neverAssignable = ['agent.add', 'client.bind', 'card.change', 'passkey.manage'] as const
