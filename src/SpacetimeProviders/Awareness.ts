import * as Y from 'yjs'
import * as YA from 'y-protocols/awareness'
import { tables } from '../module_bindings'
import { YjsAwareness } from '../module_bindings/types'
import { getConnection, uuidTou128 } from '.'

export class SpacetimeAwarenessProvider {
	readonly guid: bigint
	readonly awareness: YA.Awareness

	private _unsubs: Array<() => void> = []

	constructor(doc: Y.Doc) {
		this.guid = uuidTou128(doc.guid)
		this.awareness = new YA.Awareness(doc)

		const conn = getConnection()
		if (!conn) throw new Error('Connection not set')

		const sub = conn
			.subscriptionBuilder()
			.onApplied(() => {
				console.log('Awareness: subscribed', this.guid)
			})
			.onError((err) => {
				console.error('Awareness: subscription error', this.guid, err)
			})
			.subscribe([tables.YjsAwareness])
		this._unsubs.push(sub.unsubscribe)

		// Remote awareness → local
		const _onRemoteAwarenessUpdate = (
			_ctx: any,
			_old: YjsAwareness,
			newRow: YjsAwareness,
		) => this._onRemoteAwareness(_ctx, newRow)
		conn.db.YjsAwareness.onInsert(this._onRemoteAwareness)
		conn.db.YjsAwareness.onUpdate(_onRemoteAwarenessUpdate)
		conn.db.YjsAwareness.onDelete(this._onRemoteAwarenessRemoved)
		this._unsubs.push(() => {
			conn.db.YjsAwareness.removeOnInsert(this._onRemoteAwareness)
			conn.db.YjsAwareness.removeOnUpdate(_onRemoteAwarenessUpdate)
			conn.db.YjsAwareness.removeOnDelete(this._onRemoteAwarenessRemoved)
		})

		// Local awareness → remote
		this.awareness.on('change', this._onLocalAwareness)
		this._unsubs.push(() =>
			this.awareness.off('change', this._onLocalAwareness),
		)
	}

	destroy(): void {
		this._unsubs.forEach((unsub) => unsub())
		this._unsubs = []
		YA.removeAwarenessStates(
			this.awareness,
			Array.from(this.awareness.getStates().keys()).filter(
				(client) => client !== this.awareness.clientID,
			) as number[],
			'connection closed',
		)
	}

	// Events -----------------------------------------------------------------

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
		if (origin === this) return
		const changedClients = [...added, ...updated, ...removed]
		if (!changedClients.includes(this.awareness.clientID)) return
		const conn = getConnection()
		if (!conn) throw new Error('Connection not set')
		const state = YA.encodeAwarenessUpdate(this.awareness, [
			this.awareness.clientID,
		])

		conn.reducers.pushAwareness({
			guid: this.guid,
			state,
			clientId: this.awareness.clientID,
		})
	}

	private _onRemoteAwareness = (_ctx: any, row: YjsAwareness) => {
		if (row.guid !== this.guid) return
		if (row.clientId === this.awareness.clientID) return
		YA.applyAwarenessUpdate(this.awareness, row.state, this)
	}

	private _onRemoteAwarenessRemoved = (_ctx: any, row: YjsAwareness) => {
		if (row.guid !== this.guid) return
		YA.removeAwarenessStates(this.awareness, [row.clientId], this)
	}
}
