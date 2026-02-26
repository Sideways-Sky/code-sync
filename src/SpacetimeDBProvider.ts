import * as Y from 'yjs'
import * as YA from 'y-protocols/awareness'
import { DbConnection } from './module_bindings'
import yjs_update_type from './module_bindings/yjs_update_type'
import yjs_document_type from './module_bindings/yjs_document_type'
import yjs_awareness_type from './module_bindings/yjs_awareness_type'

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

		this._init()
	}

	destroy(): void {
		this._unsubs.forEach((unsub) => unsub())
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
				console.log('Subscribed to spacetimedb', this.docId)
			})
			.onError((err) => {
				console.error(
					'Error subscribing to spacetimedb',
					this.docId,
					err,
				)
			})
			.subscribe([
				`SELECT * FROM yjs_document WHERE docId = '${this._escapeSql(this.docId)}'`,
				`SELECT * FROM yjs_update WHERE docId = '${this._escapeSql(this.docId)}'`,
				`SELECT * FROM yjs_awareness WHERE docId = '${this._escapeSql(this.docId)}'`,
			])
		this._unsubs.push(sub.unsubscribe)

		// Watch spacetimedb updates -> local Yjs
		// Watch updates
		this.conn.db.yjsUpdate.onInsert(this._onRemoteUpdate)
		this._unsubs.push(() =>
			this.conn.db.yjsUpdate.removeOnInsert(this._onRemoteUpdate),
		)

		// Watch awareness
		// const _onRemoteAwarenessUpdate = (
		// 	_ctx: any,
		// 	_old: typeof yjs_awareness_type.type,
		// 	newRow: typeof yjs_awareness_type.type,
		// ) => this._onRemoteAwareness(_ctx, newRow)
		this.conn.db.yjsAwareness.onInsert(this._onRemoteAwareness)
		this._unsubs.push(() => {
			this.conn.db.yjsAwareness.removeOnInsert(this._onRemoteAwareness)
		})

		// Watch Document
		const _onRemoteDocumentUpdate = (
			_ctx: any,
			_old: typeof yjs_document_type.type,
			newRow: typeof yjs_document_type.type,
		) => this._onRemoteDocument(_ctx, newRow)
		this.conn.db.yjsDocument.onInsert(this._onRemoteDocument)
		this.conn.db.yjsDocument.onUpdate(_onRemoteDocumentUpdate)
		this._unsubs.push(() => {
			this.conn.db.yjsDocument.removeOnInsert(this._onRemoteDocument)
			this.conn.db.yjsDocument.removeOnUpdate(_onRemoteDocumentUpdate)
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
		console.log('sending update')
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
		if (changedClients.length === 0) return
		const update = YA.encodeAwarenessUpdate(this.awareness, changedClients)
		console.log('sending awareness', changedClients)
		this.conn.reducers.pushAwareness({
			docId: this.docId,
			update,
			senderYid: this.doc.clientID,
		})
	}

	private _onRemoteUpdate = (_ctx: any, row: typeof yjs_update_type.type) => {
		if (row.docId !== this.docId) return
		if (this.doc.clientID === row.senderYid) {
			console.log('received update — self')
			return
		} // skip self
		console.log('watchUpdates', row.senderYid)
		this._applyUpdate(row.update)
	}
	private _onRemoteAwareness = (
		_ctx: any,
		row: typeof yjs_awareness_type.type,
	) => {
		if (row.docId !== this.docId) return
		if (row.senderYid === this.doc.clientID) {
			console.log('received awareness — self')
			return
		} // skip self
		console.log('watchAwareness', row.senderYid)
		this._applyAwareness(row.update)
	}
	private _onRemoteDocument = (
		_ctx: any,
		row: typeof yjs_document_type.type,
	) => {
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

	private _applyAwareness(update: Uint8Array) {
		YA.applyAwarenessUpdate(this.awareness, update, this)
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
}
