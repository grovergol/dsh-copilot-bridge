// Client half of copilot-bridge: watch the selected workspace in the GUI, tell
// the Host to switch its agent roster, and nudge the picker to refresh.
// Headless — no UI. No `inject` list, so it cannot hang waiting for a service
// that loads later; it polls until both are present instead.
window.__ModuleLoader__.load({
  id: 'dsh-copilot-bridge',
  factory() {
    return {
      apply(ctx) {
        let started = false
        let stopSubscriptions = () => {}
        let timer

        const tryStart = () => {
          if (started) return
          const workspaces = ctx.get('workspaces')
          const ui = ctx.get('uiWorkspace')
          if (!workspaces?.list || !ui?.selection) return
          started = true
          clearInterval(timer)
          stopSubscriptions = start(ctx, workspaces, ui)
        }

        tryStart()
        timer = setInterval(tryStart, 400)
        ctx.effect(() => () => {
          clearInterval(timer)
          stopSubscriptions()
        })
      },
    }
  },
})

function start(ctx, workspaces, ui) {
  // Current workspace path = the workspace whose session list contains the
  // selected main-view session.
  const currentPath = () => {
    const sessionId = ui.selection.getSnapshot?.()?.sessionId
    const snapshot = workspaces.list.getSnapshot?.()
    if (!sessionId || !snapshot?.items) return undefined
    const item = snapshot.items.find(
      (workspace) => Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId),
    )
    return item?.path
  }

  let lastPath
  const push = () => {
    const path = currentPath()
    if (path === undefined || path === lastPath) return
    lastPath = path
    fetch('/api/copilot-bridge/workspace', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path }),
    })
      .then(() => {
        // The picker refreshes on this client-local event; the Host has already
        // finished switching when the response arrives.
        try {
          ctx.emit('connection/reset')
        } catch {
          /* best-effort */
        }
      })
      .catch(() => {
        /* switching must never throw into the UI */
      })
  }

  const off = []
  if (typeof workspaces.list.subscribe === 'function') off.push(workspaces.list.subscribe(push))
  if (typeof ui.selection.subscribe === 'function') off.push(ui.selection.subscribe(push))
  push()
  return () => {
    for (const remove of off) if (typeof remove === 'function') remove()
  }
}
