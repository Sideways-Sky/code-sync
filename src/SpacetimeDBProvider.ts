/**
 * SpacetimeDBProvider.ts
 *
 * A y-webrtc–style provider that synchronises a Y.Doc through SpacetimeDB.
 *
 * Usage:
 *   import * as Y from 'yjs';
 *   import { DbConnection } from './module_bindings';
 *   import { SpacetimeDBProvider } from './SpacetimeDBProvider';
 *
 *   const ydoc = new Y.Doc();
 *   const provider = new SpacetimeDBProvider('file:/my/document', ydoc, {
 *     conn,                        // existing DbConnection (required)
 *     awareness: new Awareness(ydoc), // optional — creates one if omitted
 *     resyncInterval: 5_000,       // ms, default 5 s
 *     compactionThreshold: 40,     // local trigger (server also compacts at 50)
 *   });
 *
 *   provider.on('sync', (isSynced: boolean) => { ... });
 *   provider.on('peers', (peers: AwarenessState[]) => { ... });
 *
 *   // Tear down cleanly
 *   provider.destroy();
 *
 * Dependencies (install separately):
 *   yjs, y-protocols, lib0
 */

import * as Y from 'yjs'
import {
	Awareness,
	encodeAwarenessUpdate,
	applyAwarenessUpdate,
} from 'y-protocols/awareness'
import { DbConnection } from './module_bindings'

// ─── Options ─────────────────────────────────────────────────────────────────

export interface SpacetimeDBProviderOptions {
	awareness?: Awareness
	resyncInterval?: number
	compactionThreshold?: number
}

// ─── Internal state ──────────────────────────────────────────────────────────

interface ProviderState {
	/** Clock epoch we last synced from */
	syncedClock: bigint
	/** Deltas received but not yet compacted client-side */
	pendingUpdates: Uint8Array[]
	/** IDs of pending delta rows for the current clock (used for compaction) */
	pendingUpdateIds: bigint[]
}

// ─── Provider ────────────────────────────────────────────────────────────────

export class SpacetimeDBProvider {
	readonly docId: string
	readonly doc: Y.Doc
	readonly awareness: Awareness

	private readonly conn: DbConnection
	private readonly opts: Required<
		Omit<SpacetimeDBProviderOptions, 'awareness'>
	>

	private state: ProviderState = {
		syncedClock: -1n,
		pendingUpdates: [],
		pendingUpdateIds: [],
	}

	private _synced = false
	private _destroyed = false

	// Unsubscribe handles
	private _unsubs: Array<() => void> = []
	private _resyncTimer: ReturnType<typeof setInterval> | null = null

	constructor(
		conn: DbConnection,
		docId: string,
		ydoc: Y.Doc,
		options?: SpacetimeDBProviderOptions,
	) {
		this.docId = docId
		this.doc = ydoc
		this.conn = conn
		this.awareness = options?.awareness ?? new Awareness(ydoc)

		this.opts = {
			resyncInterval: options?.resyncInterval ?? 5_000,
			compactionThreshold: options?.compactionThreshold ?? 40,
		}

		this._init()
	}

	// ── Public API ─────────────────────────────────────────────────────────────

	get synced(): boolean {
		return this._synced
	}

	/** Force a full resync from the server snapshot + pending deltas. */
	resync(): void {
		this._applyCurrent()
	}

	destroy(): void {
		if (this._destroyed) return
		this._destroyed = true

		// Remove local awareness state
		this.conn.reducers.removeAwareness({
			docId: this.docId,
			clientId: BigInt(this.doc.clientID),
		})

		// Unsubscribe from local Yjs events
		this._unsubs.forEach((unsub) => unsub())

		if (this._resyncTimer !== null) clearInterval(this._resyncTimer)

		this._synced = false
	}

	// ── Initialisation ─────────────────────────────────────────────────────────

	private async _init(): Promise<void> {
		// 1. Subscribe to the SpacetimeDB tables
		this.conn
			.subscriptionBuilder()
			.subscribe([
				`SELECT * FROM yjs_document WHERE doc_id = '${this._escapeSql(this.docId)}'`,
				`SELECT * FROM yjs_update WHERE doc_id = '${this._escapeSql(this.docId)}'`,
				`SELECT * FROM yjs_awareness WHERE doc_id = '${this._escapeSql(this.docId)}'`,
			])

		// 2. Ensure the document row exists server-side
		this.conn.reducers.initDoc({ docId: this.docId })

		// 3. Watch for incoming updates from other clients
		this._watchUpdates()

		// 4. Watch for awareness changes
		this._watchAwareness()

		// 5. Watch for snapshot changes (compaction events)
		this._watchDocument()

		// 6. Apply whatever is already in the local cache (from subscription)
		//    We defer one tick so the subscription has a chance to populate.
		setTimeout(() => this._applyCurrent(), 0)

		// 7. Forward local Yjs updates to SpacetimeDB
		const onLocalUpdate = (update: Uint8Array, origin: unknown) => {
			if (origin === this) return // avoid echo
			this.conn.reducers.pushUpdate({
				docId: this.docId,
				update,
			})
		}
		this.doc.on('update', onLocalUpdate)
		this._unsubs.push(() => this.doc.off('update', onLocalUpdate))

		// 8. Forward local awareness changes to SpacetimeDB
		const onLocalAwareness = ({
			added,
			updated,
			removed,
		}: {
			added: number[]
			updated: number[]
			removed: number[]
		}) => {
			const changedClients = [...added, ...updated]
			if (changedClients.length > 0) {
				const state = this.awareness.getLocalState()
				if (state !== null) {
					this.conn.reducers.upsertAwareness({
						docId: this.docId,
						clientId: BigInt(this.doc.clientID),
						state: JSON.stringify(state),
					})
				}
			}
			if (removed.length > 0) {
				this.conn.reducers.removeAwareness({
					docId: this.docId,
					clientId: BigInt(this.doc.clientID),
				})
			}
		}
		this.awareness.on('update', onLocalAwareness)
		this._unsubs.push(() => this.awareness.off('update', onLocalAwareness))

		// 9. Optional periodic resync
		if (this.opts.resyncInterval > 0) {
			this._resyncTimer = setInterval(() => {
				if (!this._destroyed) this._applyCurrent()
			}, this.opts.resyncInterval)
		}
	}

	// ── SpacetimeDB table watchers ─────────────────────────────────────────────

	/**
	 * Watch the yjs_document table for snapshot changes (compaction events).
	 * When the clock advances we re-apply the snapshot and reset state.
	 */
	private _watchDocument() {
		const handler = (row: any) => {
			if (row.docId !== this.docId) return
			if (row.snapshotClock > this.state.syncedClock) {
				this._applySnapshot(row.snapshot, row.snapshotClock)
			}
		}

		this.conn.db.yjsDocument.onInsert(handler)
		this.conn.db.yjsDocument.onUpdate((_old: any, newRow: any) =>
			handler(newRow),
		)

		this._unsubs.push(() => {
			this.conn.db.yjsDocument.removeOnInsert(handler)
			this.conn.db.yjsDocument.removeOnUpdate((_old: any, newRow: any) =>
				handler(newRow),
			)
		})
	}

	/**
	 * Watch the yjs_update table for new deltas from other peers.
	 */
	private _watchUpdates() {
		const handler = (row: any) => {
			if (row.docId !== this.docId) return
			// Ignore our own updates (we already applied them locally)
			if (row.sender?.toHexString() === this.conn.identity?.toHexString())
				return
			// Only apply deltas belonging to the current snapshot epoch
			if (row.snapshotClock !== this.state.syncedClock) return

			this._applyRemoteUpdate(row.update, row.id)
		}

		this.conn.db.yjsUpdate.onInsert(handler)
		this._unsubs.push(() => this.conn.db.yjsUpdate.removeOnInsert(handler))
	}

	/**
	 * Watch the yjs_awareness table for peer presence changes.
	 */
	private _watchAwareness() {
		const apply = (row: any) => {
			if (row.docId !== this.docId) return
			if (row.clientId === BigInt(this.doc.clientID)) return // skip self

			try {
				const state = JSON.parse(row.state)
				// Build a minimal awareness update and apply it
				const update = encodeAwarenessUpdate(
					this.awareness,
					[Number(row.clientId)],
					new Map([[Number(row.clientId), { clock: 0, state }]]),
				)
				applyAwarenessUpdate(this.awareness, update, this)
				// this.emit('peers', [this._getRemotePeers()])
			} catch {
				// malformed state — ignore
			}
		}

		const remove = (row: any) => {
			if (row.docId !== this.docId) return
			const clientId = Number(row.clientId)
			// Mark client as gone
			const update = encodeAwarenessUpdate(
				this.awareness,
				[clientId],
				new Map([[clientId, { clock: 0, state: null }]]),
			)
			applyAwarenessUpdate(this.awareness, update, this)
			// this.emit('peers', [this._getRemotePeers()])
		}

		this.conn.db.yjsAwareness.onInsert(apply)
		this.conn.db.yjsAwareness.onUpdate((_old: any, newRow: any) =>
			apply(newRow),
		)
		this.conn.db.yjsAwareness.onDelete(remove)

		this._unsubs.push(() => {
			this.conn.db.yjsAwareness.removeOnInsert(apply)
			this.conn.db.yjsAwareness.removeOnUpdate((_old: any, newRow: any) =>
				apply(newRow),
			)
			this.conn.db.yjsAwareness.removeOnDelete(remove)
		})
	}

	// ── Sync helpers ───────────────────────────────────────────────────────────

	/**
	 * Re-apply the current snapshot + all pending deltas from the local
	 * subscription cache. Called on init and on periodic resync.
	 */
	private _applyCurrent(): void {
		// Fetch the document row from the local subscription cache
		const docRow = this._getDocRow()
		if (!docRow) return // subscription not yet populated

		this._applySnapshot(docRow.snapshot, docRow.snapshotClock)

		// Apply pending deltas on top
		const deltas = this._getDeltaRows(docRow.snapshotClock)
		for (const delta of deltas) {
			this._applyUpdate(toUint8Array(delta.update))
		}

		if (deltas.length > 0) {
			this.state.pendingUpdates = deltas.map((d: any) =>
				toUint8Array(d.update),
			)
			this.state.pendingUpdateIds = deltas.map((d: any) => d.id)
		}

		this._synced = true
		this._maybeCompact()
	}

	private _applySnapshot(
		snapshot: Uint8Array | number[],
		clock: bigint,
	): void {
		const bytes = toUint8Array(snapshot)
		if (bytes.byteLength > 0) {
			Y.applyUpdate(this.doc, bytes, this)
		}
		this.state.syncedClock = clock
		this.state.pendingUpdates = []
		this.state.pendingUpdateIds = []
	}

	private _applyRemoteUpdate(
		update: Uint8Array | number[],
		rowId: bigint,
	): void {
		const bytes = toUint8Array(update)
		this._applyUpdate(bytes)
		this.state.pendingUpdates.push(bytes)
		this.state.pendingUpdateIds.push(rowId)
		this._maybeCompact()
	}

	private _applyUpdate(update: Uint8Array): void {
		Y.applyUpdate(this.doc, update, this)
	}

	/**
	 * Client-side compaction: merge snapshot + all pending deltas into one
	 * blob and push it back via `compactDoc`.
	 */
	private _maybeCompact(): void {
		if (this.state.pendingUpdates.length < this.opts.compactionThreshold)
			return

		const docRow = this._getDocRow()
		if (!docRow) return

		// Merge everything into a single update
		const allUpdates = [
			toUint8Array(docRow.snapshot),
			...this.state.pendingUpdates,
		].filter((u) => u.byteLength > 0)
		const merged = Y.mergeUpdates(allUpdates)

		this.conn.reducers.compactDoc({
			docId: this.docId,
			mergedSnapshot: merged,
			baseClock: this.state.syncedClock,
		})
	}

	// ── Cache accessors ────────────────────────────────────────────────────────

	private _getDocRow() {
		// Access the local subscription cache via the generated bindings
		try {
			return this.conn.db.yjsDocument.docId.find(this.docId) ?? null
		} catch {
			return null
		}
	}

	private _getDeltaRows(clock: bigint) {
		try {
			const rows = this.conn.db.yjsUpdate.by_doc.filter(this.docId)
			const deltaRows = []
			for (const row of rows) {
				if (row.snapshotClock === clock) deltaRows.push(row)
			}
			return deltaRows
		} catch {
			return []
		}
	}

	// ── Misc ───────────────────────────────────────────────────────────────────

	private _escapeSql(s: string): string {
		return s.replace(/'/g, "''")
	}
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function toUint8Array(v: Uint8Array | number[] | null | undefined): Uint8Array {
	if (!v) return new Uint8Array(0)
	if (v instanceof Uint8Array) return v
	return new Uint8Array(v)
}
