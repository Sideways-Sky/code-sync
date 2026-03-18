import * as Y from 'yjs'
import { tables } from '../module_bindings'
import { YjsFile, YjsUpdate } from '../module_bindings/types'
import { getConnection, uuidTou128 } from '.'

export class SpacetimeDocProvider {
	readonly guid: bigint
	readonly doc: Y.Doc

	private _unsubs: Array<() => void> = []
	private _updatesSinceCompact = 0
	private _lastUpdateId = 0n

	constructor(doc: Y.Doc, path: string) {
		this.doc = doc
		this.guid = uuidTou128(doc.guid)
		this._init(path)
	}

	private async _init(path: string) {
		const conn = getConnection()
		if (!conn) throw new Error('Connection not set')

		const sub = conn
			.subscriptionBuilder()
			.onApplied(() => {
				console.log('Doc: subscribed', this.guid)
			})
			.onError((err) => {
				console.error('Doc: subscription error', this.guid, err)
			})
			.subscribe([
				tables.YjsFile.where((d) => d.guid.eq(this.guid)),
				tables.YjsUpdate.where((d) => d.guid.eq(this.guid)),
			])
		this._unsubs.push(sub.unsubscribe)

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

		// Local doc → remote
		this.doc.on('update', this._onLocalUpdate)
		this._unsubs.push(() => this.doc.off('update', this._onLocalUpdate))
		await conn.reducers.addFile({
			guid: this.guid,
			path,
			snapshot: Y.encodeStateAsUpdate(this.doc),
		})
		this.doc.emit('sync', [true, this.doc])
		this._unsubs.push(() => conn.reducers.removeFile({ guid: this.guid }))
		this.doc.on('destroy', this.destroy)
		this._unsubs.push(() => this.doc.off('destroy', this.destroy))
	}

	destroy(): void {
		this._updatesSinceCompact = 0
		this._lastUpdateId = 0n
		this._unsubs.forEach((unsub) => unsub())
		this._unsubs = []
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
			conn.reducers.pushUpdate({
				guid: this.guid,
				update,
				clientId: this.doc.clientID,
			})
		}
	}

	private _onRemoteUpdate = (_ctx: any, row: YjsUpdate) => {
		if (row.guid !== this.guid) return
		if (row.id <= this._lastUpdateId) return
		this._lastUpdateId = row.id
		console.log(
			'Doc: received update',
			this._lastUpdateId,
			this._updatesSinceCompact,
		)
		if (row.senderClientId === this.doc.clientID) return
		this._applyUpdate(row.update)
	}

	private _onRemoteFile = (_ctx: any, row: YjsFile) => {
		if (row.guid !== this.guid) return
		console.log('Doc: received snapshot', row)
		this._applyUpdate(row.snapshot)
		this._updatesSinceCompact = 0
	}

	// Helpers ----------------------------------------------------------------

	private _compactDoc() {
		const conn = getConnection()
		if (!conn) throw new Error('Connection not set')
		const snapshot = Y.encodeStateAsUpdate(this.doc)
		conn.reducers.saveSnapshot({
			guid: this.guid,
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
