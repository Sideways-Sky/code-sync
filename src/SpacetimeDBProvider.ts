import * as Y from 'yjs'
import {
	Awareness,
	encodeAwarenessUpdate,
	applyAwarenessUpdate,
} from 'y-protocols/awareness'
import { DbConnection } from './module_bindings'
import yjs_update_type from './module_bindings/yjs_update_type'
import yjs_document_type from './module_bindings/yjs_document_type'
import yjs_awareness_type from './module_bindings/yjs_awareness_type'
import { Identity } from 'spacetimedb'

export class SpacetimeDBProvider {
	readonly docId: string
	readonly doc: Y.Doc
	readonly awareness: Awareness

	private readonly conn: DbConnection

	private _synced = false
	private _destroyed = false

	private _unsubs: Array<() => void> = []

	constructor(conn: DbConnection, docId: string, yDoc: Y.Doc) {
		this.docId = docId
		this.doc = yDoc
		if (!conn.isActive) {
			throw new Error('Connection is not active')
		} else if (!conn.identity) {
			throw new Error('Connection identity is not set')
		}
		this.conn = conn
		this.doc.clientID = this._toClientId(conn.identity)
		this.awareness = new Awareness(yDoc)

		this._init()
	}

	get synced(): boolean {
		return this._synced
	}

	destroy(): void {
		if (this._destroyed) return
		this._destroyed = true

		console.log('removeAwareness')
		this.conn.reducers.removeAwareness({
			docId: this.docId,
		})

		// Unsubscribe from local Yjs events
		this._unsubs.forEach((unsub) => unsub())

		this._synced = false
	}

	private async _init(): Promise<void> {
		// Ensure the document row exists server-side
		this.conn.reducers.initDoc({
			docId: this.docId,
			snapshot: Y.encodeStateAsUpdate(this.doc),
		})

		// Subscribe local Yjs updates -> spacetimedb
		const sub = this.conn
			.subscriptionBuilder()
			.onApplied(() => {
				console.log('onApplied')
			})
			.onError((err) => {
				console.error('onError', err)
			})
			.subscribe([
				`SELECT * FROM yjs_document WHERE docId = '${this._escapeSql(this.docId)}'`,
				`SELECT * FROM yjs_update WHERE docId = '${this._escapeSql(this.docId)}'`,
				`SELECT * FROM yjs_awareness WHERE docId = '${this._escapeSql(this.docId)}'`,
			])
		this._unsubs.push(() => sub.unsubscribe())
		// Watch spacetimedb updates -> local Yjs
		this._watchUpdates()
		this._watchAwareness()
		this._watchDocument()

		// Local Yjs updates -> SpacetimeDB
		const onLocalUpdate = (update: Uint8Array, origin: unknown) => {
			if (origin === this) return // avoid echo
			console.log('pushing update', update)
			this.conn.reducers.pushUpdate({
				docId: this.docId,
				update,
			})
		}
		this.doc.on('update', onLocalUpdate)
		this._unsubs.push(() => this.doc.off('update', onLocalUpdate))

		// Local awareness changes -> SpacetimeDB
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
					console.log('upsertAwareness', state)
					this.conn.reducers.upsertAwareness({
						docId: this.docId,
						state: JSON.stringify(state),
					})
				}
			}
			if (removed.length > 0) {
				console.log('removeAwareness')
				this.conn.reducers.removeAwareness({
					docId: this.docId,
				})
			}
		}
		this.awareness.on('change', onLocalAwareness)
		this._unsubs.push(() => this.awareness.off('change', onLocalAwareness))
	}

	private _watchDocument() {
		const handler = (_ctx: any, row: typeof yjs_document_type.type) => {
			if (row.docId !== this.docId) return
			console.log('watchDocument', row)
		}
		const updateHandler = (
			_ctx: any,
			_old: typeof yjs_document_type.type,
			newRow: typeof yjs_document_type.type,
		) => handler(_ctx, newRow)

		this.conn.db.yjsDocument.onInsert(handler)
		this.conn.db.yjsDocument.onUpdate(updateHandler)
		this._unsubs.push(() => {
			this.conn.db.yjsDocument.removeOnInsert(handler)
			this.conn.db.yjsDocument.removeOnUpdate(updateHandler)
		})
	}

	private _watchUpdates() {
		const handler = (_ctx: any, row: typeof yjs_update_type.type) => {
			if (row.docId !== this.docId) return
			console.log('watchUpdates', row.update)
			this._applyUpdate(row.update)
		}

		this.conn.db.yjsUpdate.onInsert(handler)
		this._unsubs.push(() => this.conn.db.yjsUpdate.removeOnInsert(handler))
	}

	private _watchAwareness() {
		const encodeAndApply = (identity: Identity, state: any) => {
			const clientId = this._toClientId(identity)
			const update = encodeAwarenessUpdate(
				this.awareness,
				[clientId],
				new Map([[clientId, state]]),
			)
			applyAwarenessUpdate(this.awareness, update, this)
		}
		const apply = (_ctx: any, row: typeof yjs_awareness_type.type) => {
			if (row.docId !== this.docId) return
			if (row.identity === this.conn.identity) return // skip self
			try {
				const state = JSON.parse(row.state)
				// Build a minimal awareness update and apply it
				encodeAndApply(row.identity, { clock: 0, state })
			} catch {
				console.warn('Invalid awareness state', row.state)
				// malformed state — ignore
			}
		}
		const remove = (_ctx: any, row: typeof yjs_awareness_type.type) => {
			if (row.docId !== this.docId) return
			encodeAndApply(row.identity, null)
		}
		const updateHandler = (
			_ctx: any,
			_old: typeof yjs_awareness_type.type,
			newRow: typeof yjs_awareness_type.type,
		) => apply(_ctx, newRow)
		this.conn.db.yjsAwareness.onInsert(apply)
		this.conn.db.yjsAwareness.onUpdate(updateHandler)
		this.conn.db.yjsAwareness.onDelete(remove)
		this._unsubs.push(() => {
			this.conn.db.yjsAwareness.removeOnInsert(apply)
			this.conn.db.yjsAwareness.removeOnUpdate(updateHandler)
			this.conn.db.yjsAwareness.removeOnDelete(remove)
		})
	}

	private _applyUpdate(update: Uint8Array): void {
		try {
			Y.applyUpdate(this.doc, update, this)
		} catch (err) {
			console.error('applyUpdate', err)
		}
	}

	private _escapeSql(s: string): string {
		return s.replace(/'/g, "''")
	}

	private _toClientId(identity: Identity): number {
		const id = identity.__identity__
		// XOR-fold the 128-bit identity into 32 bits
		const b0 = Number((id >> 96n) & 0xffffffffn)
		const b1 = Number((id >> 64n) & 0xffffffffn)
		const b2 = Number((id >> 32n) & 0xffffffffn)
		const b3 = Number(id & 0xffffffffn)

		return (b0 ^ b1 ^ b2 ^ b3) >>> 0 // >>> 0 ensures unsigned 32-bit
	}
}
