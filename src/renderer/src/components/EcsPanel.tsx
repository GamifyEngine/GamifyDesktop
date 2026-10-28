import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { EcsNode } from '../../../shared/types'

/**
 * ECS viewer: entities / components / systems as three linked columns, with
 * edges drawn from each entity and system to the components it `uses` (per
 * the parsed `#=== gamifydesktop ===` file headers). Hover previews a node's
 * connections and header; click pins it. Files whose kind is outside the ECS
 * trio appear in a strip below the graph.
 */

const COLUMNS = [
  { kind: 'entity', title: 'Entities' },
  { kind: 'component', title: 'Components' },
  { kind: 'system', title: 'Systems' }
] as const

const ECS_KINDS = new Set<string>(COLUMNS.map((c) => c.kind))

interface Edge {
  from: string
  to: string
}

interface Anchor {
  left: { x: number; y: number }
  right: { x: number; y: number }
}

export function EcsPanel(): React.JSX.Element {
  const [nodes, setNodes] = useState<EcsNode[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pinned, setPinned] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const result = await window.api.scanEcs()
    if (result.ok) {
      setNodes(result.data)
      setError(null)
    } else {
      setError(result.error)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])
  // Re-scan when the AI edits project files (same debounced signal the file
  // and git panels use).
  useEffect(() => window.api.onChatFilesChanged(() => void refresh()), [refresh])

  const graph = useMemo(() => {
    const byKind: Record<string, EcsNode[]> = { entity: [], component: [], system: [] }
    const others: EcsNode[] = []
    for (const n of nodes ?? []) (byKind[n.kind] ?? others).push(n)
    for (const list of Object.values(byKind)) list.sort((a, b) => a.name.localeCompare(b.name))

    const componentIds = new Set(byKind.component.map((c) => c.id))
    const edges: Edge[] = []
    const neighbors = new Map<string, Set<string>>()
    const link = (a: string, b: string): void => {
      if (!neighbors.has(a)) neighbors.set(a, new Set())
      neighbors.get(a)!.add(b)
    }
    for (const n of [...byKind.entity, ...byKind.system]) {
      for (const use of n.uses) {
        if (componentIds.has(use) && use !== n.id) {
          edges.push({ from: n.id, to: use })
          link(n.id, use)
          link(use, n.id)
        }
      }
    }
    const byId = new Map((nodes ?? []).map((n) => [n.id, n]))
    return { byKind, others, edges, neighbors, byId }
  }, [nodes])

  // ---- edge geometry: measure node cards relative to the scroll content ----
  const graphRef = useRef<HTMLDivElement>(null)
  const nodeRefs = useRef(new Map<string, HTMLElement>())
  const [anchors, setAnchors] = useState<Map<string, Anchor>>(new Map())
  const [svgSize, setSvgSize] = useState({ width: 0, height: 0 })

  const measure = useCallback(() => {
    const container = graphRef.current
    if (!container) return
    const cRect = container.getBoundingClientRect()
    const next = new Map<string, Anchor>()
    for (const [id, el] of nodeRefs.current) {
      const r = el.getBoundingClientRect()
      const y = r.y - cRect.y + container.scrollTop + r.height / 2
      const x = r.x - cRect.x + container.scrollLeft
      next.set(id, { left: { x, y }, right: { x: x + r.width, y } })
    }
    setAnchors(next)
    setSvgSize({ width: container.scrollWidth, height: container.scrollHeight })
  }, [])

  useLayoutEffect(measure, [measure, nodes])
  useEffect(() => {
    const container = graphRef.current
    if (!container) return
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    return () => observer.disconnect()
  }, [measure])

  const nodeRef = useCallback(
    (id: string) =>
      (el: HTMLElement | null): void => {
        if (el) nodeRefs.current.set(id, el)
        else nodeRefs.current.delete(id)
      },
    []
  )

  // ---- focus model: hover previews, click pins ----
  const focusId = hovered ?? pinned
  const focusNode = focusId ? (graph.byId.get(focusId) ?? null) : null
  // Only dim the network when the focused node participates in it.
  const dimming = focusNode !== null && ECS_KINDS.has(focusNode.kind)
  const related = focusId ? graph.neighbors.get(focusId) : undefined
  const isDim = (id: string): boolean => dimming && id !== focusId && !related?.has(id)

  const edgePath = (edge: Edge): string | null => {
    const from = anchors.get(edge.from)
    const to = anchors.get(edge.to)
    if (!from || !to) return null
    // Components sit in the middle column: entities connect to their left
    // side, systems to their right. Pick the source/target sides by x-order.
    const a = from.right.x < to.left.x ? from.right : from.left
    const b = from.right.x < to.left.x ? to.left : to.right
    const bend = Math.max(24, Math.abs(b.x - a.x) / 2)
    const dir = b.x >= a.x ? 1 : -1
    return `M ${a.x} ${a.y} C ${a.x + dir * bend} ${a.y}, ${b.x - dir * bend} ${b.y}, ${b.x} ${b.y}`
  }

  const nodeProps = (n: EcsNode): React.HTMLAttributes<HTMLElement> => ({
    onMouseEnter: () => setHovered(n.id),
    onMouseLeave: () => setHovered((h) => (h === n.id ? null : h))
  })

  if (error) {
    return (
      <div className="ecs-panel">
        <div className="ecs-empty">
          <h2>Couldn&apos;t scan the project</h2>
          <p className="muted">{error}</p>
        </div>
      </div>
    )
  }

  const total = graph.byKind.entity.length + graph.byKind.component.length + graph.byKind.system.length
  if (nodes !== null && total === 0 && graph.others.length === 0) {
    return (
      <div className="ecs-panel">
        <div className="ecs-empty">
          <h2>No ECS files yet</h2>
          <p className="muted">
            This view maps your game&apos;s entities, components and systems from the
            <code> #=== gamifydesktop ===</code> headers the assistant puts at the top of every code
            file. Ask it to build a feature — or to refactor existing code to the ECS structure —
            and the network will appear here.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="ecs-panel">
      <div className="ecs-graph" ref={graphRef} onClick={() => setPinned(null)}>
        <svg className="ecs-edges" width={svgSize.width} height={svgSize.height}>
          {graph.edges.map((edge) => {
            const d = edgePath(edge)
            if (!d) return null
            const active = focusId === edge.from || focusId === edge.to
            const cls = active ? 'ecs-edge active' : dimming ? 'ecs-edge faded' : 'ecs-edge'
            return <path key={`${edge.from}->${edge.to}`} d={d} className={cls} />
          })}
        </svg>
        <div className="ecs-columns">
          {COLUMNS.map((col) => (
            <div className="ecs-col" key={col.kind}>
              <div className="ecs-col-header">
                <span className={`ecs-dot kind-${col.kind}`} />
                {col.title}
                <span className="ecs-col-count">{graph.byKind[col.kind].length}</span>
              </div>
              {graph.byKind[col.kind].length === 0 && (
                <div className="ecs-col-empty">None yet</div>
              )}
              {graph.byKind[col.kind].map((n) => (
                <div
                  key={n.id}
                  ref={nodeRef(n.id)}
                  className={[
                    'ecs-node',
                    `kind-${n.kind}`,
                    isDim(n.id) ? 'dim' : '',
                    focusId === n.id ? 'focus' : '',
                    pinned === n.id ? 'pinned' : ''
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  {...nodeProps(n)}
                  onClick={(e) => {
                    e.stopPropagation() // container click clears the pin
                    setPinned((p) => (p === n.id ? null : n.id))
                  }}
                >
                  <span className="ecs-node-name">{n.name}</span>
                  <span className="ecs-node-file">{n.path.slice(n.path.lastIndexOf('/') + 1)}</span>
                </div>
              ))}
            </div>
          ))}
        </div>

        {graph.others.length > 0 && (
          <div className="ecs-others">
            <span className="ecs-others-label">Other files</span>
            <div className="ecs-others-list">
              {graph.others.map((n) => (
                <button
                  key={n.path}
                  className={`ecs-other-chip${focusId === n.id ? ' focus' : ''}`}
                  {...nodeProps(n)}
                  onClick={(e) => {
                    e.stopPropagation()
                    setPinned((p) => (p === n.id ? null : n.id))
                  }}
                >
                  <span className={`ecs-dot kind-${n.kind}`} />
                  {n.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="ecs-detail">
        {focusNode ? (
          <>
            <div className="ecs-detail-head">
              <span className={`ecs-kind-badge kind-${focusNode.kind}`}>{focusNode.kind}</span>
              <span className="ecs-detail-name">{focusNode.name}</span>
              <span className="ecs-detail-path">{focusNode.path}</span>
            </div>
            {focusNode.summary && <p className="ecs-detail-summary">{focusNode.summary}</p>}
            {focusNode.extra.map((line, i) => (
              <p key={i} className="ecs-detail-extra">
                {line}
              </p>
            ))}
            {focusNode.uses.length > 0 && (
              <div className="ecs-detail-uses">
                <span className="ecs-uses-label">uses</span>
                {focusNode.uses.map((u) => (
                  <span key={u} className="ecs-use-chip">
                    {u}
                  </span>
                ))}
              </div>
            )}
          </>
        ) : (
          <span className="ecs-detail-hint muted">
            Hover a node to preview its connections and description — click to pin it.
          </span>
        )}
      </div>
    </div>
  )
}
