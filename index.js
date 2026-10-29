// @local/dsh-copilot-bridge — Host plugin for DeepSeek Harness.
//
// Bridges the agents and skills a VS Code Copilot setup already keeps on disk,
// so no parallel copy has to be maintained:
//
//   global: <globalRoot>/agents/*.agent.md   <globalRoot>/skills/<name>/SKILL.md
//   local : <projectRoot>/.github/agents/*   <projectRoot>/.github/skills/*
//
// * Skills join the shared `ctx.skills` catalog, so the ordinary `skill` tool
//   advertises and loads them with the calling agent's workspace in force.
//   Local skills outrank global ones on a name clash (lower rank wins).
// * Every agent file becomes a real harness Agent Preset (persona + the tools
//   its `tools:` frontmatter maps to). Global agents register at startup; a
//   workspace's own agents register the first time a session runs there.
// * `list_copilot_agents` / `call_agent` let an orchestrator agent delegate to any
//   visible agent — global or local — honouring its `agents:` allowlist and its
//   `agent/runSubagent` tool grant.
//
// Only node builtins are imported: the plugin runs inside the harness Host
// process, where the platform's own packages are the only resolvable ones.

import { appendFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const tracePath = join(fileURLToPath(new URL('.', import.meta.url)), 'bridge.log')

export const name = 'copilot-bridge'
// Only the two registries this plugin publishes into are hard dependencies.
// `agentPresets`, `subagents`, `workingDirectory` and `systemPrompt` are looked
// up lazily, so startup order cannot leave the plugin half-mounted.
export const inject = ['tools', 'skills']

const LOCAL_RANK = 100
const GLOBAL_RANK = 400
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const PRESET_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const FILE_LIMIT = 512 * 1024

const AGENT_NOTE = [
  '[DeepSeek Harness] You are running inside DeepSeek Harness on the user\'s machine.',
  'Copilot tool names map to harness tools: `read/*` -> `read`, `search/*` -> `glob` and `grep`,',
  '`edit` -> `write` and `edit`, `execute` -> `pwsh` (Windows PowerShell), `todo` -> `todo_write`,',
  '`web/fetch` -> `web_fetch`, `agent/runSubagent` -> `call_agent` with `list_copilot_agents`.',
  'Copilot skills from the project and the global folder are in your `skill` catalog; load one by name.',
].join(' ')

export function apply(ctx, config = {}) {
  const settings = resolveSettings(config)
  const workspaceCache = new Map() // projectRoot -> { at, agents }
  const presetsByKey = new Map() // scope key -> { id, dispose }
  const agentByPresetId = new Map() // preset id -> agent definition
  const live = new Set() // scope keys currently registered

  const log = (message) => {
    trace(message)
    try {
      ctx.logger?.warn?.(`copilot-bridge: ${message}`)
    } catch {
      /* logging must never break discovery */
    }
  }

  /** Append to bridge.log beside the plugin; keeps the last ~2000 lines. */
  const trace = (message) => {
    try {
      const line = `${new Date().toISOString()} ${message}\n`
      if (existsSync(tracePath) && statSync(tracePath).size > 512 * 1024) writeFileSync(tracePath, '')
      appendFileSync(tracePath, line)
    } catch {
      /* a log failure never affects behaviour */
    }
  }

  const service = (serviceName) => {
    try {
      return ctx.get(serviceName)
    } catch {
      return undefined
    }
  }

  // ---------------------------------------------------------------- skills --

  ctx.skills.registerProvider(() => ({
    name: settings.providerName,
    async list(options = {}) {
      const candidates = await discoverSkills(
        settings.globalSkillsDir,
        'copilot-global',
        GLOBAL_RANK,
        settings.providerName,
      )
      if (options.cwd !== undefined) {
        const projectRoot = await findProjectRoot(resolve(options.cwd), settings)
        candidates.push(
          ...(await discoverSkills(
            join(projectRoot, settings.localSkillsDir),
            'copilot-project',
            LOCAL_RANK,
            settings.providerName,
          )),
        )
      }
      return candidates
    },
    async get(candidate) {
      const path = candidate?.locator?.path
      if (typeof path !== 'string') return undefined
      const raw = await readTextFile(path)
      if (raw === undefined) return undefined
      const parsed = parseSkillFile(raw, path)
      if (parsed === undefined) return undefined
      return {
        name: parsed.name,
        description: parsed.description,
        ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
        invocation: parsed.invocation,
        source: candidate.source,
        provider: settings.providerName,
        resourceBase: { kind: 'directory', path: candidate.locator.directory },
        path: parsed.path,
        content: parsed.content,
      }
    },
  }))

  // --------------------------------------------------------------- presets --

  let agentPresets
  let lastPresetError = ''

  const cwdOf = (agent) => {
    const session = agent?.session
    if (session === undefined) return undefined
    const workingDirectory = service('workingDirectory')
    if (workingDirectory !== undefined && typeof workingDirectory.get === 'function') {
      try {
        const value = workingDirectory.get(session)
        if (typeof value === 'string' && value.length > 0) return value
      } catch {
        /* fall back to the session header */
      }
    }
    const header = session.header
    return typeof header?.cwd === 'string' ? header.cwd : undefined
  }

  const catalogue = async (cwd) => {
    const globalAgents = await discoverAgents(settings.globalAgentsDir, 'global', undefined, log)
    const projectRoot = cwd === undefined ? undefined : await findProjectRoot(resolve(cwd), settings)
    let localAgents = []
    if (projectRoot !== undefined) {
      const cached = workspaceCache.get(projectRoot)
      if (cached !== undefined && Date.now() - cached.at < settings.cacheMs) {
        localAgents = cached.agents
      } else {
        localAgents = await discoverAgents(join(projectRoot, settings.localAgentsDir), 'local', projectRoot, log)
        workspaceCache.set(projectRoot, { at: Date.now(), agents: localAgents })
      }
    }
    const byName = new Map()
    for (const agent of globalAgents) byName.set(agent.name, agent)
    for (const agent of localAgents) byName.set(agent.name, agent) // the workspace wins a clash
    return { projectRoot, globalAgents, localAgents, byName }
  }

  const presetIdFor = (agent) =>
    agent.scope === 'global'
      ? makeId(agent.name)
      : makeId(`${agent.workspace ?? 'workspace'}-${agent.name}`)

  const keyOf = (agent) =>
    `${agent.scope}:${agent.scope === 'local' ? `${agent.workspace}:` : ''}${agent.name}`

  // project root -> preset keys registered for that workspace
  const workspacePresets = new Map()

  // [{ agent, root }] in creation order; the newest entry is the current workspace
  const createdOrder = []

  const remember = (agent, root) => {
    if (root === undefined) return
    for (let index = createdOrder.length - 1; index >= 0; index -= 1) {
      if (createdOrder[index].agent === agent) createdOrder.splice(index, 1)
    }
    createdOrder.push({ agent, root })
  }

  /** A workspace marked current without an agent, e.g. by a brand-new blank session. */
  const rememberRoot = (root) => {
    for (let index = createdOrder.length - 1; index >= 0; index -= 1) {
      const entry = createdOrder[index]
      if (entry.agent === undefined && entry.root === root) createdOrder.splice(index, 1)
    }
    createdOrder.push({ agent: undefined, root })
  }

  const selectedPresetOf = (session) => {
    if (session === undefined) return undefined
    try {
      const projections = service('sessionProjections')
      const value = projections?.stateOf?.(session, 'agentPreset')
      if (typeof value === 'string') return value
    } catch {
      /* fall back to the header */
    }
    const header = session.header
    return typeof header?.agentPreset === 'string' ? header.agentPreset : undefined
  }

  const composedPresetIds = () =>
    [...new Set([...presetsByKey.values()].map((entry) => entry.id))].sort()

  /**
   * The client picker only re-reads the preset roster on the forwarded
   * `settings/document-updated` event for the agent-preset-registry namespace,
   * so emit one whenever the composed set may have changed.
   */
  const notifyRosterChanged = () => {
    try {
      const root = ctx.root ?? ctx
      root.emit('settings/document-updated', 'agent-preset-registry', Date.now())
    } catch {
      /* best-effort; the client half also refreshes via connection/reset */
    }
  }

  const disposeAgentPreset = async (key) => {
    const entry = presetsByKey.get(key)
    if (entry === undefined) return
    try {
      await entry.dispose?.()
    } catch {
      /* a failing teardown must not block the remaining work */
    }
    presetsByKey.delete(key)
    agentByPresetId.delete(entry.id)
    live.delete(key)
    trace(`withdrew ${entry.id}`)
  }

  const registerAgent = async (agent) => {
    if (agentPresets === undefined) return undefined
    const key = keyOf(agent)
    const current = presetsByKey.get(key)
    if (current !== undefined && live.has(key)) return current.id
    if (current !== undefined) {
      try {
        await current.dispose?.()
      } catch {
        /* retiring the previous revision must not block the new one */
      }
      agentByPresetId.delete(current.id)
      live.delete(key)
      presetsByKey.delete(key)
    }
    const id = presetIdFor(agent)
    let dispose
    try {
      dispose = await agentPresets.register({
        id,
        name: agent.scope === 'local' ? `${agent.name} (${agent.workspace})` : agent.name,
        description: agent.description,
        order: agent.scope === 'global' ? 20 : 40,
        plugins: presetRows(agent),
      })
    } catch (error) {
      const message = errorMessage(error)
      // A reload can leave this id registered by the previous revision. The
      // definition is identical, so adopt that revision instead of failing.
      if (!/duplicate agent preset/i.test(message)) {
        lastPresetError = message
        log(`cannot register the agent preset "${id}": ${message}`)
        return undefined
      }
      log(`agent preset "${id}" was already registered; reusing that revision`)
      presetsByKey.set(key, { id, dispose: undefined })
      agentByPresetId.set(id, agent)
      live.add(key)
      return id
    }
    presetsByKey.set(key, { id, dispose })
    agentByPresetId.set(id, agent)
    live.add(key)
    trace(`registered ${id} (${agent.scope})`)
    return id
  }

  const registerAll = async (agents) => {
    for (const agent of agents) await registerAgent(agent)
  }

  const registerWorkspace = async (cwd) => {
    if (cwd === undefined) return undefined
    const projectRoot = await findProjectRoot(resolve(cwd), settings)
    const localAgents = await discoverAgents(
      join(projectRoot, settings.localAgentsDir),
      'local',
      projectRoot,
      log,
    )
    const keys = new Set()
    for (const agent of localAgents) {
      const id = await registerAgent(agent)
      if (id !== undefined) keys.add(keyOf(agent))
    }
    if (keys.size > 0) workspacePresets.set(projectRoot, keys)
    return projectRoot
  }

  /**
   * Keep only the workspace the user is actually in. The harness keeps every
   * session resident for the whole run, so "has an open session" is not a usable
   * signal: the newest agent is. A workspace is also kept while a live session
   * still has one of its agent presets selected, because withdrawing that would
   * break that session.
   */
  /** Client-facing workspace switch: compose this workspace, prune the rest. */
  const switchWorkspace = async (cwd) => {
    if (typeof cwd !== 'string' || cwd.length === 0) return undefined
    const root = await registerWorkspace(cwd)
    if (root === undefined) return undefined
    rememberRoot(root)
    await pruneWorkspaces()
    notifyRosterChanged()
    trace(`switchWorkspace: current workspace = ${basename(root)}`)
    return root
  }

  const pruneWorkspaces = async () => {
    if (settings.presetScope !== 'workspace' || workspacePresets.size === 0) return
    const agentsService = service('agents')
    if (agentsService === undefined || typeof agentsService.list !== 'function') return

    const liveAgents = agentsService.list()
    const liveSet = new Set(liveAgents)
    for (let index = createdOrder.length - 1; index >= 0; index -= 1) {
      const entry = createdOrder[index]
      if (entry.agent !== undefined && !liveSet.has(entry.agent)) createdOrder.splice(index, 1)
    }

    const keep = new Set()
    const newest = createdOrder[createdOrder.length - 1]
    if (newest !== undefined) keep.add(newest.root)

    const ownerOf = new Map()
    for (const [root, keys] of workspacePresets) {
      for (const key of keys) {
        const entry = presetsByKey.get(key)
        if (entry !== undefined) ownerOf.set(entry.id, root)
      }
    }
    for (const agent of liveAgents) {
      const selected = selectedPresetOf(agent.session)
      const owner = selected === undefined ? undefined : ownerOf.get(selected)
      if (owner !== undefined) keep.add(owner)
    }

    for (const [root, keys] of [...workspacePresets]) {
      if (keep.has(root)) continue
      for (const key of keys) await disposeAgentPreset(key)
      workspacePresets.delete(root)
      log(`left ${basename(root)}: withdrew ${keys.size} agent preset(s)`)
      notifyRosterChanged()
    }
  }

  // The preset registry is another Host row, so wait for it instead of assuming
  // it is already mounted when this bundle activates.
  ctx.inject(['agentPresets'], (presetCtx) => {
    agentPresets = presetCtx.get('agentPresets')
    if (agentPresets === undefined) {
      log('the agent-presets service is unavailable; Copilot agents cannot become presets')
      return
    }

    void (async () => {
      await registerAll(await discoverAgents(settings.globalAgentsDir, 'global', undefined, log))
      // Start scoped to the profile's default workspace. Anything else arrives
      // with the `agent/created` of the session the user actually opens, which is
      // the only reliable "current workspace" signal — the order of the live
      // session registry is not creation order.
      const initial = service('workingDirectory')?.defaultDirectory
      if (typeof initial === 'string' && initial.length > 0) {
        const root = await registerWorkspace(initial)
        if (root !== undefined) createdOrder.push({ agent: undefined, root })
      }
      await pruneWorkspaces()
    })().catch((error) => log(`initial registration failed: ${errorMessage(error)}`))

    /** Make one agent's workspace the current one and prune the rest. */
    const switchTo = async (agent, why) => {
      if (createdOrder[createdOrder.length - 1]?.agent === agent) return
      const cwd = cwdOf(agent)
      const root = await registerWorkspace(cwd)
      if (root === undefined) {
        trace(`${why}: no workspace for ${cwd ?? '(no cwd)'}`)
        return
      }
      remember(agent, root)
      await pruneWorkspaces()
      notifyRosterChanged()
      trace(`${why}: current workspace = ${basename(root)}`)
    }

    /** Make one workspace current from a bare cwd (no agent yet). */
    const switchToRoot = async (cwd, why) => {
      if (typeof cwd !== 'string' || cwd.length === 0) return
      const root = await registerWorkspace(cwd)
      if (root === undefined) return
      const newest = createdOrder[createdOrder.length - 1]
      if (newest?.agent === undefined && newest.root === root) return
      rememberRoot(root)
      await pruneWorkspaces()
      notifyRosterChanged()
      trace(`${why}: current workspace = ${basename(root)}`)
    }

    ctx.on('session/created', (session) => {
      void switchToRoot(session?.header?.cwd, 'session/created').catch((error) =>
        log(`workspace registration failed: ${errorMessage(error)}`),
      )
    })

    ctx.on('agent/created', ({ agent }) => {
      void switchTo(agent, 'agent/created').catch((error) =>
        log(`workspace registration failed: ${errorMessage(error)}`),
      )
    })

    // Opening an already-live session emits no `agent/created`; running a step in
    // it is the next best signal that its workspace is the current one.
    ctx.on('agent/status', ({ agent, status }) => {
      if (status !== 'running') return
      void switchTo(agent, 'agent/status').catch((error) =>
        log(`workspace registration failed: ${errorMessage(error)}`),
      )
    })

    // A human message in a session definitely means its workspace is current.
    ctx.on('api-session/activity', (sessionId) => {
      const agent = service('agents')?.get?.(sessionId)
      if (agent === undefined) return
      void switchTo(agent, 'api-session/activity').catch((error) =>
        log(`workspace registration failed: ${errorMessage(error)}`),
      )
    })

    ctx.on('agent/disposed', () => {
      void pruneWorkspaces().catch((error) => log(`workspace pruning failed: ${errorMessage(error)}`))
    })
  })

  // Unloading the plugin releases the presets it created; without this a later
  // install would collide with its own previous revision.
  ctx.effect(() => () => {
    for (const entry of presetsByKey.values()) {
      try {
        void entry.dispose?.()
      } catch {
        /* teardown must never throw */
      }
    }
    presetsByKey.clear()
    agentByPresetId.clear()
    live.clear()
  })

  // ------------------------------------------------------------- the tools --

  const callerAgent = (session) => {
    const presetId = session?.header?.agentPreset
    return typeof presetId === 'string' ? agentByPresetId.get(presetId) : undefined
  }

  const callAgent = {
    name: 'call_agent',
    description:
      'Delegate a self-contained task to one of the Copilot agents configured for this workspace: the ' +
      'agent definitions in `.github/agents` plus the global agent folder. The child runs with that ' +
      'agent\'s own instructions and tool set, in its own context, and you are notified when it ' +
      'finishes. Call `list_copilot_agents` first when you are unsure which agents exist. The child does not see ' +
      'this conversation, so pass everything it needs — a full spec, not a pointer to one.',
    // ctx.tools.register() takes a registry-ready definition, so `parameters` is
    // raw JSON Schema — the `{ property: { type, required } }` authoring form is
    // only compiled by defineTool(), which platform packages do not let us import.
    parameters: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: 'Agent name as returned by `list_copilot_agents` (for example `seniordev`, `auditor`, `librarian`).',
        },
        task: {
          type: 'string',
          description: 'The complete, self-contained task for that agent, including any spec it must follow.',
        },
        description: {
          type: 'string',
          description: 'A short (3-5 word) description of the delegated task, for display.',
        },
        cwd: {
          type: 'string',
          description: 'Optional working directory for the child; the current one is inherited when omitted.',
        },
      },
      required: ['agent', 'task'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'agent', 'subagentId'],
        properties: {
          kind: { type: 'string', const: 'activation' },
          agent: { type: 'string' },
          subagentId: { type: 'string' },
        },
      },
      render: (_args, value) => [
        { type: 'text', text: `started ${value.agent} as subagent ${value.subagentId}` },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const caller = exec.agent
      if (caller === undefined) throw new Error('call_agent requires a calling agent session')
      const subagents = service('subagents')
      if (subagents === undefined) throw new Error('call_agent requires the subagent runtime')

      const catalogued = await catalogue(cwdOf(caller))
      const target = catalogued.byName.get(args.agent)
      if (target === undefined) {
        const names = [...catalogued.byName.keys()].sort()
        throw new Error(
          `unknown Copilot agent "${args.agent}"; visible here: ${names.length === 0 ? '(none)' : names.join(', ')}`,
        )
      }

      const self = callerAgent(caller.session)
      if (self !== undefined && !self.canDelegate) {
        throw new Error(
          `agent "${self.name}" may not delegate: its tools list does not grant agent/runSubagent`,
        )
      }
      if (Array.isArray(self?.agents) && self.agents.length > 0 && !self.agents.includes(target.name)) {
        throw new Error(
          `agent "${self.name}" may only delegate to: ${self.agents.join(', ')} — "${target.name}" is not in its agents list`,
        )
      }

      const presetId = await registerAgent(target)
      if (presetId === undefined) {
        throw new Error(
          `agent "${target.name}" could not be composed as a preset${lastPresetError === '' ? '' : `: ${lastPresetError}`}`,
        )
      }
      if (catalogued.projectRoot !== undefined) {
        remember(caller, catalogued.projectRoot)
        await pruneWorkspaces()
      }

      const request = {
        prompt: [{ type: 'text', text: args.task }],
        parent: caller,
        agentPreset: presetId,
      }
      if (args.cwd !== undefined) request.cwd = args.cwd
      const activation = await subagents.startActivation({
        provider: settings.provider,
        label: args.description ?? `delegate to ${target.name}`,
        request,
        signal: exec.signal,
        delivery: 'parent',
      })
      return { kind: 'activation', agent: target.name, subagentId: activation.childId }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Call ${args.agent}`,
      kind: 'other',
      rawInput: { agent: args.agent, task: args.task },
    }),
  }

  const listAgents = {
    name: 'list_copilot_agents',
    description:
      'List the Copilot agents visible to this session: this workspace\'s `.github/agents` plus the global ' +
      'agent folder that applies to every workspace. Shows each agent\'s scope, description, and whether ' +
      'this agent is allowed to call it.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['workspace', 'agents', 'presets'],
        properties: {
          workspace: { type: 'string' },
          presets: { type: 'array', items: { type: 'string' } },
          agents: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'scope', 'description', 'callable', 'preset', 'registered'],
              properties: {
                name: { type: 'string' },
                scope: { type: 'string' },
                description: { type: 'string' },
                callable: { type: 'boolean' },
                preset: { type: 'string' },
                registered: { type: 'boolean' },
              },
            },
          },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            (value.agents.length === 0
              ? `No Copilot agents found for ${value.workspace}.`
              : value.agents.map(
                  (entry) =>
                    `- ${entry.name} [${entry.scope}]${entry.registered ? ` preset:${entry.preset}` : ' (preset not composed yet)'}${entry.callable ? '' : ' (not in your agents list)'}: ${entry.description}`,
                ).join('\n')) +
            (value.presets.length === 0 ? '' : `\n\nComposed presets: ${value.presets.join(', ')}`),
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      const caller = exec.agent
      if (caller === undefined) throw new Error('list_copilot_agents requires a calling agent session')
      const cwd = cwdOf(caller)
      await registerWorkspace(cwd)
      const catalogued = await catalogue(cwd)
      if (catalogued.projectRoot !== undefined) {
        remember(caller, catalogued.projectRoot)
        await pruneWorkspaces()
      }
      const self = callerAgent(caller.session)
      const allow = Array.isArray(self?.agents) && self.agents.length > 0 ? self.agents : undefined
      const agents = [...catalogued.byName.values()]
        .sort((left, right) => left.name.localeCompare(right.name))
        .map((agent) => ({
          name: agent.name,
          scope: agent.scope,
          description: agent.description,
          callable: allow === undefined || allow.includes(agent.name),
          preset: presetIdFor(agent),
          registered: live.has(keyOf(agent)),
        }))
      return { workspace: catalogued.projectRoot ?? cwd ?? '(unknown)', agents, presets: composedPresetIds() }
    },
    presentCall: () => ({ card: 'generic', title: 'List Copilot agents', kind: 'other' }),
  }

  ctx.tools.register(callAgent)
  ctx.tools.register(listAgents)

  // --------------------------------------------------------- client endpoint --

  // The GUI's workspace dropdown is client-side state with no Host event, so the
  // client half POSTs the selected workspace here and the roster is switched.
  // Registered through the connection Fetch registry so it keeps cookie auth.
  const connection = service('connection')
  if (connection?.fetch !== undefined && typeof connection.fetch.register === 'function') {
    connection.fetch.register({
      path: '/api/copilot-bridge/workspace',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          let parsed = {}
          try {
            parsed = await request.json()
          } catch {
            /* empty or malformed body: no-op */
          }
          const path = typeof parsed.path === 'string' ? parsed.path : ''
          trace(`client endpoint hit: path=${path || '(empty)'}`)
          const root = await switchWorkspace(path)
          notifyRosterChanged()
          return new Response(
            JSON.stringify({ ok: root !== undefined, workspace: root ?? null, presets: composedPresetIds() }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        } catch (error) {
          return new Response(JSON.stringify({ ok: false, error: errorMessage(error) }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          })
        }
      },
    })
    trace('registered POST /api/copilot-bridge/workspace (authenticated)')
  }

  // -------------------------------------------------------- prompt section --

  const systemPrompt = service('systemPrompt')
  if (systemPrompt !== undefined && typeof systemPrompt.section === 'function') {
    systemPrompt.section({
      name: 'copilot-bridge:agents',
      order: 120,
      text: (context) => {
        const agent = context?.agent
        if (agent === undefined) return ''
        const self = callerAgent(agent.session)
        const allowed = Array.isArray(self?.agents) && self.agents.length > 0 ? self.agents : undefined
        const local = [...agentByPresetId.values()].some((candidate) => candidate.scope === 'local')
        if (allowed === undefined && !local) return ''
        const parts = [
          'Copilot agents are delegation targets here: `list_copilot_agents` shows them and `call_agent` runs one.',
        ]
        if (allowed !== undefined) parts.push(`Your agents list permits: ${allowed.join(', ')}.`)
        return parts.join(' ')
      },
    })
  }
}

// -------------------------------------------------------------------- config --

function resolveSettings(config) {
  const globalRoot =
    typeof config.globalRoot === 'string' && config.globalRoot.length > 0
      ? resolve(expandHome(config.globalRoot))
      : join(homedir(), '.copilot')
  const local = (value, fallback) =>
    typeof value === 'string' && value.length > 0 ? value.replace(/^\.[\\/]+/, '').replace(/^[\\/]+/, '').replace(/[\\/]+/g, '/') : fallback
  return {
    globalRoot,
    globalAgentsDir: absolute(config.globalAgentsDir) ?? join(globalRoot, 'agents'),
    globalSkillsDir: absolute(config.globalSkillsDir) ?? join(globalRoot, 'skills'),
    localAgentsDir: local(config.localAgentsDir, '.github/agents'),
    localSkillsDir: local(config.localSkillsDir, '.github/skills'),
    providerName:
      typeof config.providerName === 'string' && config.providerName.length > 0 ? config.providerName : 'copilot',
    provider: typeof config.provider === 'string' && config.provider.length > 0 ? config.provider : 'spawn',
    cacheMs: Number.isFinite(config.cacheMs) ? Number(config.cacheMs) : 5000,
    // 'workspace' (default): a workspace's agents are on the roster only while one
    // of its sessions is open. 'all': they stay for the rest of the app run.
    presetScope: config.presetScope === 'all' ? 'all' : 'workspace',
  }
}

function absolute(value) {
  return typeof value === 'string' && value.length > 0 ? resolve(expandHome(value)) : undefined
}

function expandHome(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

function makeId(value) {
  const slug = String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug.length === 0) return 'copilot-agent'
  return PRESET_ID.test(slug) ? slug : `copilot-${slug}`
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

// ------------------------------------------------------------- project root --

const projectRootCache = new Map()

async function findProjectRoot(cwd, settings) {
  const cached = projectRootCache.get(cwd)
  if (cached !== undefined) return cached
  let current = cwd
  let found = cwd
  for (let depth = 0; depth < 64; depth += 1) {
    if (
      (await pathExists(join(current, '.git'))) ||
      (await pathExists(join(current, settings.localAgentsDir))) ||
      (await pathExists(join(current, settings.localSkillsDir)))
    ) {
      found = current
      break
    }
    const parent = parentOf(current)
    if (parent === current) break
    current = parent
  }
  projectRootCache.set(cwd, found)
  return found
}

function parentOf(value) {
  const trimmed = value.endsWith(sep) ? value.slice(0, -1) : value
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return index <= 0 ? trimmed : trimmed.slice(0, index)
}

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

// ------------------------------------------------------------------- agents --

async function discoverAgents(dir, scope, projectRoot, log) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const agents = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) continue
    const path = join(dir, entry.name)
    const raw = await readTextFile(path)
    if (raw === undefined) continue
    const parsed = parseAgentFile(raw, path)
    if (parsed === undefined) {
      log(`${path} ignored: frontmatter needs a name and a description`)
      continue
    }
    agents.push({
      ...parsed,
      path,
      scope,
      root: scope === 'local' ? projectRoot : undefined,
      workspace: scope === 'local' && projectRoot !== undefined ? basename(projectRoot) : undefined,
    })
  }
  return agents
}

function parseAgentFile(raw, path) {
  const parsed = parseFrontmatter(raw)
  if (parsed === undefined) return undefined
  const declaredName = stringField(parsed.data, 'name')
  const description = stringField(parsed.data, 'description')
  if (description === undefined) return undefined
  const name = declaredName ?? nameFromPath(path)
  if (name === undefined) return undefined
  const tools = stringList(parsed.data.tools)
  return {
    name,
    description,
    tools,
    agents: stringList(parsed.data.agents),
    canDelegate: tools.length === 0 || tools.some((tool) => /^(agent|subagent|delegate)(\/|$)/.test(tool.toLowerCase())),
    body: parsed.body.trim(),
  }
}

function nameFromPath(path) {
  const base = basename(path)
    .replace(/\.agent\.md$/i, '')
    .replace(/\.md$/i, '')
  return base.length === 0 ? undefined : base
}

// -------------------------------------------------------------------- tools --

function presetRows(agent) {
  const declared = new Set((agent.tools ?? []).map((tool) => String(tool).toLowerCase()))
  const any = (predicate) => [...declared].some((tool) => predicate(tool))
  const open = declared.size === 0
  const canRead = open || any((tool) => tool.startsWith('read'))
  const canWrite = any((tool) => tool === 'edit' || tool.startsWith('edit/'))
  const canRun = any(
    (tool) => tool === 'execute' || tool.startsWith('execute/') || tool.startsWith('terminal'),
  )
  const canSearch = open || any((tool) => tool.startsWith('search'))
  const canWeb = open || any((tool) => tool.startsWith('web'))
  const wantTodo = open || declared.has('todo')

  const rows = [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: personaBody(agent.body) } },
    {
      id: 'agent-instructions',
      name: '@deepseek-ai/dsh-agent-instructions',
      config: { maxBytes: 65536 },
    },
    { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
    {
      id: 'tool-fs',
      name: '@deepseek-ai/dsh-tool-fs',
      config: { read: canRead, readImage: canRead, write: canWrite, edit: canWrite },
    },
  ]
  if (canSearch) {
    rows.push({
      id: 'tool-fs-search',
      name: '@deepseek-ai/dsh-tool-fs-search',
      config: { sampleOverCapGlobResults: false },
    })
  }
  if (canRun) {
    const shell = process.platform === 'win32' ? 'tool-pwsh' : 'tool-bash'
    rows.push({ id: shell, name: `@deepseek-ai/dsh-${shell}` })
    rows.push({ id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' })
  }
  if (canWeb) {
    rows.push({
      id: 'tool-web',
      name: '@deepseek-ai/dsh-tool-web',
      config: { fetch: true, searchTimeoutMs: 60000 },
    })
  }
  if (wantTodo) {
    rows.push({
      id: 'tool-todo',
      name: '@deepseek-ai/dsh-tool-todo',
      config: { allowParallelInProgress: true },
    })
  }
  rows.push(
    { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
    { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
    { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
    {
      id: 'compaction',
      name: 'cordis:group',
      group: true,
      isolate: { compaction: true, toolResultPruner: true },
      config: [
        { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
        { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
        {
          id: 'tool-result-pruner',
          name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
          config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
        },
      ],
    },
  )
  return rows
}

/** The persona prefix is a prompt template, so literal `{{` would be resolved as a variable. */
function personaBody(body) {
  const safe = String(body ?? '').replace(/\{\{/g, '{ {')
  return `${AGENT_NOTE}\n\n${safe}`.trim()
}

// ------------------------------------------------------------------- skills --

async function discoverSkills(dir, source, rank, provider) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const skills = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    let locator
    if (entry.isDirectory()) {
      locator = { path: join(dir, entry.name, 'SKILL.md'), directory: join(dir, entry.name) }
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      locator = { path: join(dir, entry.name), directory: dir }
    }
    if (locator === undefined) continue
    const raw = await readTextFile(locator.path)
    if (raw === undefined) continue
    const parsed = parseSkillFile(raw, locator.path)
    if (parsed === undefined) continue
    skills.push({
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
      invocation: parsed.invocation,
      provider,
      source,
      rank,
      locator,
      resourceBase: { kind: 'directory', path: locator.directory },
      path: parsed.path,
    })
  }
  return skills
}

function parseSkillFile(raw, path) {
  const parsed = parseFrontmatter(raw)
  if (parsed === undefined) return undefined
  const name = stringField(parsed.data, 'name')
  const description = stringField(parsed.data, 'description')
  if (name === undefined || description === undefined || !SKILL_NAME.test(name)) return undefined
  return {
    name,
    description,
    whenToUse: stringField(parsed.data, 'whenToUse') ?? stringField(parsed.data, 'when_to_use'),
    invocation: {
      modelInvocable: parsed.data['disable-model-invocation'] !== true,
      userInvocable: parsed.data['user-invocable'] !== false,
    },
    path,
    content: parsed.body.trim(),
  }
}

// ----------------------------------------------------------------- file I/O --

async function readTextFile(path) {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size > FILE_LIMIT) return undefined
    return await readFile(await realpath(path), { encoding: 'utf8' })
  } catch {
    return undefined
  }
}

// -------------------------------------------------------------- frontmatter --

/**
 * Parse the YAML subset Copilot writes into `*.agent.md` and `SKILL.md`
 * frontmatter: `key: scalar`, `key: [a, b, "c"]`, quoted scalars, and `|`/`>`
 * blocks. Anything unrecognised is skipped rather than failing the whole file.
 */
function parseFrontmatter(raw) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '')
  const lines = text.split(/\r?\n/)
  if ((lines[0] ?? '').trim() !== '---') return undefined
  let end = -1
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === '---') {
      end = index
      break
    }
  }
  if (end < 0) return undefined

  const data = {}
  let index = 1
  while (index < end) {
    const line = lines[index]
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      index += 1
      continue
    }
    const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line)
    if (match === null) {
      index += 1
      continue
    }
    const key = match[1]
    const rawValue = match[2].trim()
    index += 1
    if (/^[|>][+-]?$/.test(rawValue)) {
      const folded = rawValue.startsWith('>')
      const block = []
      while (index < end) {
        const candidate = lines[index]
        if (candidate.trim() !== '' && !/^\s/.test(candidate)) break
        block.push(candidate)
        index += 1
      }
      data[key] = folded ? block.map((entry) => entry.trim()).join(' ').trim() : dedent(block).trim()
      continue
    }
    let value = rawValue
    if (!/^[[{'"]/.test(value)) {
      while (index < end) {
        const candidate = lines[index]
        if (candidate.trim() === '' || !/^\s/.test(candidate)) break
        if (/^[A-Za-z0-9_.-]+\s*:/.test(candidate.trim())) break
        value = `${value.trimEnd()} ${candidate.trim()}`
        index += 1
      }
    }
    data[key] = parseScalar(value)
  }
  return { data, body: lines.slice(end + 1).join('\n') }
}

function dedent(lines) {
  const widths = lines
    .filter((line) => line.trim() !== '')
    .map((line) => /^\s*/.exec(line)[0].length)
  const width = widths.length === 0 ? 0 : Math.min(...widths)
  return lines.map((line) => line.slice(Math.min(width, /^\s*/.exec(line)[0].length))).join('\n')
}

function parseScalar(value) {
  const trimmed = String(value ?? '').trim()
  if (trimmed === '') return ''
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return splitFlow(trimmed.slice(1, -1))
      .map((entry) => unquote(entry))
      .filter((entry) => entry.length > 0)
  }
  if (trimmed === 'true' || trimmed === 'yes' || trimmed === 'on') return true
  if (trimmed === 'false' || trimmed === 'no' || trimmed === 'off') return false
  if (trimmed === 'null' || trimmed === '~') return null
  return unquote(trimmed)
}

function splitFlow(value) {
  const parts = []
  let current = ''
  let quote = ''
  for (const character of value) {
    if (quote !== '') {
      current += character
      if (character === quote) quote = ''
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      current += character
      continue
    }
    if (character === ',') {
      parts.push(current)
      current = ''
      continue
    }
    current += character
  }
  if (current.trim() !== '') parts.push(current)
  return parts
}

function unquote(value) {
  const trimmed = String(value ?? '').trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\')
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'")
  }
  return trimmed
}

function stringField(data, key) {
  const value = data[key]
  if (typeof value === 'string') return value.length === 0 ? undefined : value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function stringList(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0)
  }
  if (typeof value === 'string' && value.length > 0) {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  }
  return []
}
