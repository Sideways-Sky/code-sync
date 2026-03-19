import * as YA from 'y-protocols/awareness'
import { tables } from '../module_bindings'
import { YjsAwareness } from '../module_bindings/types'
import { getConnection } from '.'
import { SpacetimeDocProvider } from './Doc'

export class SpacetimeAwarenessProvider {
	readonly awareness: YA.Awareness
	private readonly docProvider: SpacetimeDocProvider
	private _unsubs: Array<() => void> = []

	constructor(docProvider: SpacetimeDocProvider) {
		this.awareness = new YA.Awareness(docProvider.doc)
		this.docProvider = docProvider

		const conn = getConnection()
		if (!conn) throw new Error('Connection not set')

		const sub = conn
			.subscriptionBuilder()
			.onApplied(() => {
				console.log('Awareness: subscribed', this.guid)

				// Local awareness → remote
				this.awareness.on('change', this._onLocalAwareness)
				this._unsubs.push(() =>
					this.awareness.off('change', this._onLocalAwareness),
				)
			})
			.onError((err) => {
				console.error('Awareness: subscription error', this.guid, err)
			})
			.subscribe([tables.YjsAwareness.where((d) => d.guid.eq(this.guid))])
		this._unsubs.push(() => {
			if (conn.isActive) {
				sub.unsubscribe()
			}
		})

		// Remote awareness → local
		conn.db.YjsAwareness.onInsert(this._onRemoteAwareness)
		conn.db.YjsAwareness.onUpdate(this._onRemoteAwarenessUpdate)
		conn.db.YjsAwareness.onDelete(this._onRemoteAwarenessRemoved)
		this._unsubs.push(() => {
			conn.db.YjsAwareness.removeOnInsert(this._onRemoteAwareness)
			conn.db.YjsAwareness.removeOnUpdate(this._onRemoteAwarenessUpdate)
			conn.db.YjsAwareness.removeOnDelete(this._onRemoteAwarenessRemoved)
		})
	}

	destroy(): void {
		console.log('Awareness: destroying', this.guid)
		this._unsubs.forEach((unsub) => unsub())
		this._unsubs = []
		this.awareness.destroy()
	}

	get guid(): bigint {
		return this.docProvider.guid
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

		console.log('Awareness: sending change', {
			guid: this.guid,
			state: this.awareness.getLocalState(),
			clientId: this.awareness.clientID,
		})

		conn.reducers.pushAwareness({
			guid: this.guid,
			state,
			clientId: this.awareness.clientID,
		})
	}

	private _onRemoteAwareness = (_ctx: any, row: YjsAwareness) => {
		if (row.guid !== this.guid) return
		if (row.clientId === this.awareness.clientID) return
		console.log('Awareness: received update', row)
		YA.applyAwarenessUpdate(this.awareness, row.state, this)
	}

	private _onRemoteAwarenessRemoved = (_ctx: any, row: YjsAwareness) => {
		if (row.guid !== this.guid) return
		console.log('Awareness: received remove', row)
		YA.removeAwarenessStates(this.awareness, [row.clientId], this)
	}

	private _onRemoteAwarenessUpdate = (
		_ctx: any,
		oldRow: YjsAwareness,
		newRow: YjsAwareness,
	) => {
		if (oldRow.guid !== this.guid) return
		if (oldRow.clientId === this.awareness.clientID) return
		console.log('Awareness: received update', oldRow, newRow)
		if (newRow.guid !== this.guid) {
			YA.removeAwarenessStates(this.awareness, [oldRow.clientId], this)
			return
		}
		YA.applyAwarenessUpdate(this.awareness, newRow.state, this)
	}
}
