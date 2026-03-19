import * as Y from 'yjs'
import { tables } from '../module_bindings'
import { YjsFile, YjsUpdate } from '../module_bindings/types'
import { getConnection } from '.'
import { SpacetimeAwarenessProvider } from './Awareness'

export class SpacetimeDocProvider {
	readonly id: bigint
	readonly doc: Y.Doc

	private _unsubs: Array<() => void> = []
	private _updatesSinceCompact = 0
	private _lastUpdateId = 0n
	private readonly awarenessProvider: SpacetimeAwarenessProvider

	constructor(doc: Y.Doc, id: bigint) {
		this.id = id
		this.doc = doc
		this._init()
		this.awarenessProvider = new SpacetimeAwarenessProvider(this)
	}

	private _init() {
		const conn = getConnection()
		if (!conn) throw new Error('Connection not set')

		const sub = conn
			.subscriptionBuilder()
			.onApplied(() => {
				console.log('Doc: subscribed', this.id)
				this.doc.emit('sync', [true, this.doc])
				// Local doc → remote
				this.doc.on('update', this._onLocalUpdate)
				this._unsubs.push(() =>
					this.doc.off('update', this._onLocalUpdate),
				)
			})
			.onError((err) => {
				console.error('Doc: subscription error', this.id, err)
			})
			.subscribe([
				tables.YjsFile.where((d) => d.id.eq(this.id)),
				tables.YjsUpdate.where((d) => d.fileId.eq(this.id)),
			])
		this._unsubs.push(() => {
			if (conn.isActive) {
				sub.unsubscribe()
			}
		})

		// Remote update → local doc
		conn.db.YjsUpdate.onInsert(this._onRemoteUpdate)
		this._unsubs.push(() =>
			conn.db.YjsUpdate.removeOnInsert(this._onRemoteUpdate),
		)

		// Remote snapshot → local doc
		const _onRemoteFileUpdate = (
			_ctx: any,
			_old: YjsFile,
			newRow: YjsFile,
		) => this._onRemoteFile(_ctx, newRow)
		conn.db.YjsFile.onInsert(this._onRemoteFile)
		conn.db.YjsFile.onUpdate(_onRemoteFileUpdate)
		this._unsubs.push(() => {
			conn.db.YjsFile.removeOnInsert(this._onRemoteFile)
			conn.db.YjsFile.removeOnUpdate(_onRemoteFileUpdate)
		})

		this.doc.on('destroy', this.destroy)
		this._unsubs.push(() => this.doc.off('destroy', this.destroy))
	}

	destroy(): void {
		console.log('Doc: destroying', this.id)
		this._updatesSinceCompact = 0
		this._lastUpdateId = 0n
		this._unsubs.forEach((unsub) => unsub())
		this._unsubs = []
		this.awarenessProvider.destroy()
	}

	get awareness() {
		return this.awarenessProvider.awareness
	}

	// Events -----------------------------------------------------------------

	private _onLocalUpdate = (update: Uint8Array, origin: unknown) => {
		if (origin === this) return
		const conn = getConnection()
		if (!conn) throw new Error('Connection not set')
		this._updatesSinceCompact++
		if (this._updatesSinceCompact > 10) {
			this._compactDoc()
			this._updatesSinceCompact = 0
		} else {
			// console.log('Doc: sending update', this._updatesSinceCompact)
			conn.reducers.pushUpdate({
				fileId: this.id,
				update,
				clientId: this.doc.clientID,
			})
		}
	}

	private _onRemoteUpdate = (_ctx: any, row: YjsUpdate) => {
		if (row.fileId !== this.id) return
		if (row.id <= this._lastUpdateId) return
		this._lastUpdateId = row.id
		// console.log(
		// 	'Doc: received update',
		// 	this._lastUpdateId,
		// 	this._updatesSinceCompact,
		// )
		if (row.senderClientId === this.doc.clientID) return
		this._applyUpdate(row.update)
	}

	private _onRemoteFile = (_ctx: any, row: YjsFile) => {
		if (row.id !== this.id) return
		// console.log('Doc: received snapshot', row)
		this._applyUpdate(row.snapshot)
		this._updatesSinceCompact = 0
	}

	// Helpers ----------------------------------------------------------------

	private _compactDoc() {
		const conn = getConnection()
		if (!conn) throw new Error('Connection not set')
		const snapshot = Y.encodeStateAsUpdate(this.doc)
		// console.log('Doc: sending snapshot', this._updatesSinceCompact)
		conn.reducers.saveSnapshot({
			fileId: this.id,
			snapshot,
			pruneBeforeId: this._lastUpdateId,
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
