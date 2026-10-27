import type { ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'

export type RpcId = number | string

/** A JSON-RPC error response, keeping the code so callers can tell "not found" from a flake. */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly code?: number
  ) {
    super(message)
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any -- protocol payloads are JSON; typed at the call sites */
type Params = any

/**
 * JSON-RPC over a child process's stdio, one JSON message per line — the
 * transport `codex-app-server` speaks by default. Codex leaves out the
 * "jsonrpc": "2.0" member, and so does this client. Three message flows:
 * our requests (answered by id), the server's notifications (events), and
 * the server's own requests (approvals, user-input questions), which must be
 * answered or the turn waits forever.
 */
export class CodexRpc {
  private nextId = 1
  private pending = new Map<RpcId, { resolve: (v: Params) => void; reject: (e: Error) => void; method: string }>()
  private closedWith: Error | null = null
  onNotification: (method: string, params: Params) => void = () => {}
  onRequest: (id: RpcId, method: string, params: Params) => void = () => {}

  constructor(private readonly proc: ChildProcess) {
    if (!proc.stdout || !proc.stdin) throw new Error('codex-app-server needs piped stdio')
    createInterface({ input: proc.stdout }).on('line', (line) => this.receive(line))
    // Writes after the process died would otherwise throw EPIPE asynchronously.
    proc.stdin.on('error', () => {})
  }

  request<T = Params>(method: string, params: Params = {}): Promise<T> {
    if (this.closedWith) return Promise.reject(this.closedWith)
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.send({ id, method, params })
    })
  }

  notify(method: string, params: Params = {}): void {
    this.send({ method, params })
  }

  respond(id: RpcId, result: Params): void {
    this.send({ id, result })
  }

  respondError(id: RpcId, code: number, message: string): void {
    this.send({ id, error: { code, message } })
  }

  /** Fail every in-flight request — the process is gone. */
  close(reason: Error): void {
    this.closedWith = reason
    for (const { reject } of this.pending.values()) reject(reason)
    this.pending.clear()
  }

  private send(message: object): void {
    if (!this.closedWith) this.proc.stdin?.write(JSON.stringify(message) + '\n')
  }

  private receive(line: string): void {
    let msg: Params
    try {
      msg = JSON.parse(line)
    } catch {
      return // not protocol output
    }
    const isResponse = msg.id !== undefined && msg.method === undefined
    if (isResponse) {
      const call = this.pending.get(msg.id)
      if (!call) return
      this.pending.delete(msg.id)
      if (msg.error) call.reject(new RpcError(`${call.method}: ${msg.error.message ?? 'failed'}`, msg.error.code))
      else call.resolve(msg.result)
    } else if (msg.id !== undefined) {
      this.onRequest(msg.id, msg.method, msg.params ?? {})
    } else if (typeof msg.method === 'string') {
      this.onNotification(msg.method, msg.params ?? {})
    }
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */
