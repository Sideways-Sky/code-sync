import * as Y from 'yjs'
import * as YA from 'y-protocols/awareness'
import { DbConnection, tables } from './module_bindings'
import { YjsAwareness, YjsDocument, YjsUpdate } from './module_bindings/types'

export class SpacetimeDBProvider {
	readonly docId: string
	readonly doc: Y.Doc
	readonly awareness: YA.Awareness

	private readonly conn: DbConnection

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
		this.awareness = new YA.Awareness(yDoc)

		this._initSubscriptions()
	}

	destroy(): void {
		this._unsubs.forEach((unsub) => unsub())
		YA.removeAwarenessStates(
			this.awareness,
			Array.from(this.awareness.getStates().keys()).filter(
				(client) => client !== this.doc.clientID,
			) as number[],
			'connection closed',
		)
	}

	private _initSubscriptions() {
		// Subscribe local Yjs updates -> spacetimedb
		const sub = this.conn
			.subscriptionBuilder()
			.onApplied(() => {
				console.log('Subscribed to spacetimedb', this.docId)
				// Ensure the document row exists server-side
				this.conn.reducers.initDoc({
					docId: this.docId,
					snapshot: Y.encodeStateAsUpdate(this.doc),
				})
			})
			.onError((err) => {
				console.error(
					'Error subscribing to spacetimedb',
					this.docId,
					err,
				)
			})
			.subscribe([
				tables.YjsAwareness.where((r) => r.docId.eq(this.docId)),
				tables.YjsDocument.where((r) => r.docId.eq(this.docId)),
				tables.YjsUpdate.where((r) => r.docId.eq(this.docId)),
			])
		this._unsubs.push(sub.unsubscribe)

		// Watch spacetimedb updates -> local Yjs
		// Watch updates
		this.conn.db.YjsUpdate.onInsert(this._onRemoteUpdate)
		this._unsubs.push(() =>
			this.conn.db.YjsUpdate.removeOnInsert(this._onRemoteUpdate),
		)

		// Watch awareness
		const _onRemoteAwarenessUpdate = (
			_ctx: any,
			_old: YjsAwareness,
			newRow: YjsAwareness,
		) => this._onRemoteAwareness(_ctx, newRow)
		this.conn.db.YjsAwareness.onInsert(this._onRemoteAwareness)
		this.conn.db.YjsAwareness.onUpdate(_onRemoteAwarenessUpdate)
		this.conn.db.YjsAwareness.onDelete(this._onRemoteAwarenessRemoved)
		this._unsubs.push(() => {
			this.conn.db.YjsAwareness.removeOnInsert(this._onRemoteAwareness)
			this.conn.db.YjsAwareness.removeOnUpdate(_onRemoteAwarenessUpdate)
			this.conn.db.YjsAwareness.removeOnDelete(
				this._onRemoteAwarenessRemoved,
			)
		})

		// Watch Document
		const _onRemoteDocumentUpdate = (
			_ctx: any,
			_old: YjsDocument,
			newRow: YjsDocument,
		) => this._onRemoteDocument(_ctx, newRow)
		this.conn.db.YjsDocument.onInsert(this._onRemoteDocument)
		this.conn.db.YjsDocument.onUpdate(_onRemoteDocumentUpdate)
		this._unsubs.push(() => {
			this.conn.db.YjsDocument.removeOnInsert(this._onRemoteDocument)
			this.conn.db.YjsDocument.removeOnUpdate(_onRemoteDocumentUpdate)
		})

		// Local Yjs updates -> SpacetimeDB
		this.doc.on('update', this._onLocalUpdate)
		this.awareness.on('change', this._onLocalAwareness)
		this._unsubs.push(
			() => this.doc.off('update', this._onLocalUpdate),
			() => this.awareness.off('change', this._onLocalAwareness),
		)

		console.log(
			'SpacetimeDBProvider initialized',
			this.docId,
			this.doc.clientID,
		)
	}

	// Events -----------------------------------------------------------------

	private _onLocalUpdate = (update: Uint8Array, origin: unknown) => {
		if (origin === this) return // avoid echo
		// check if snapshot is needed TODO
		this.conn.reducers.pushUpdate({
			docId: this.docId,
			update,
			senderYid: this.doc.clientID,
		})
	}
	private _onLocalAwareness = (
		{
			added,
			updated,
			removed,
		}: {
			added: number[]
			updated: number[]
			removed: number[]
		},
		origin: unknown,
	) => {
		if (origin === this) return // avoid echo
		const changedClients = [...added, ...updated, ...removed]
		if (!changedClients.includes(this.doc.clientID)) return
		const state = YA.encodeAwarenessUpdate(this.awareness, [
			this.doc.clientID,
		])

		this.conn.reducers.pushAwareness({
			docId: this.docId,
			state,
			senderYid: this.doc.clientID,
		})
	}

	private _onRemoteUpdate = (_ctx: any, row: YjsUpdate) => {
		if (row.docId !== this.docId) return
		if (this.doc.clientID === row.senderYid) return
		this._applyUpdate(row.update)
	}
	private _onRemoteAwareness = (_ctx: any, row: YjsAwareness) => {
		if (row.docId !== this.docId) return
		if (row.senderYid === this.doc.clientID) return

		YA.applyAwarenessUpdate(this.awareness, row.state, this)
	}
	private _onRemoteAwarenessRemoved = (_ctx: any, row: YjsAwareness) => {
		if (row.docId !== this.docId) return
		YA.removeAwarenessStates(this.awareness, [row.senderYid], this)
	}
	private _onRemoteDocument = (_ctx: any, row: YjsDocument) => {
		if (row.docId !== this.docId) return
		console.log('Received document ----', row)
		this._applyUpdate(row.snapshot)
	}

	// Helpers ----------------------------------------------------------------

	private _compactDoc() {
		const snapshot = Y.encodeStateAsUpdate(this.doc)
		this.conn.reducers.saveSnapshot({
			docId: this.docId,
			snapshot,
		})
	}

	private _applyUpdate(update: Uint8Array): void {
		try {
			Y.applyUpdate(this.doc, update, this)
		} catch (err) {
			console.error('applyUpdate', err)
		}
	}
}
