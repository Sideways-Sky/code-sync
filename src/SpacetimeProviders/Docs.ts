import { getConnection, u128ToUuid } from '.'
import { tables } from '../module_bindings'
import { YjsFile } from '../module_bindings/types'
import { SpacetimeDocProvider } from './Doc'
import * as Y from 'yjs'

export class SpacetimeDocsProvider {
	private readonly _providers = new Map<string, SpacetimeDocProvider>()
	private _unsubs: Array<() => void> = []

	onChange: (() => void) | null = null

	constructor() {
		const conn = getConnection()
		if (!conn) throw new Error('Connection not set')

		const sub = conn
			.subscriptionBuilder()
			.onApplied(() => {
				console.log('Docs: subscribed')
			})
			.onError((err) => {
				console.error('Docs: subscription error', err)
			})
			.subscribe([tables.YjsFile])
		this._unsubs.push(() => sub.unsubscribe())

		conn.db.YjsFile.onInsert(this._onRemoteFileAdded)
		conn.db.YjsFile.onDelete(this._onRemoteFileRemove)
		conn.db.YjsFile.onUpdate(this._onRemoteFileUpdate)
		this._unsubs.push(() => {
			conn.db.YjsFile.removeOnInsert(this._onRemoteFileAdded)
			conn.db.YjsFile.removeOnDelete(this._onRemoteFileRemove)
			conn.db.YjsFile.removeOnUpdate(this._onRemoteFileUpdate)
		})
	}

	private _onRemoteFileAdded = (_ctx: any, row: YjsFile) => {
		console.log('Docs: received file', row)
		const doc = new Y.Doc({
			guid: u128ToUuid(row.guid),
		})
		Y.applyUpdate(doc, row.snapshot)
		const provider = new SpacetimeDocProvider(doc)
		this._providers.set(row.path, provider)
		if (this.onChange) this.onChange()
	}
	private _onRemoteFileRemove = (_ctx: any, row: YjsFile) => {
		console.log('Docs: received file remove', row)
		const provider = this._providers.get(row.path)
		if (provider) {
			provider.destroy()
			this._providers.delete(row.path)
			if (this.onChange) this.onChange()
		}
	}
	private _onRemoteFileUpdate = (
		_ctx: any,
		oldRow: YjsFile,
		newRow: YjsFile,
	) => {
		console.log('Docs: received file update', oldRow, newRow)
		const provider = this._providers.get(oldRow.path)
		if (provider) {
			if (oldRow.path !== newRow.path) {
				this._providers.delete(oldRow.path)
				this._providers.set(newRow.path, provider)
				if (this.onChange) this.onChange()
			}
		}
	}

	async createDoc(path: string) {
		const conn = getConnection()
		if (!conn) throw new Error('Connection not set')

		const provider = new SpacetimeDocProvider(new Y.Doc())
		this._providers.set(path, provider)
		await conn.reducers.addFile({
			guid: provider.guid,
			path,
			snapshot: Y.encodeStateAsUpdate(provider.doc),
		})
	}

	async removeDoc(path: string) {
		const conn = getConnection()
		if (!conn) throw new Error('Connection not set')

		const provider = this._providers.get(path)
		if (provider) {
			provider.destroy()
			this._providers.delete(path)
			await conn.reducers.removeFile({ guid: provider.guid })
		}
	}

	async renameDoc(oldPath: string, newPath: string) {
		const conn = getConnection()
		if (!conn) throw new Error('Connection not set')

		const provider = this._providers.get(oldPath)
		if (provider) {
			this._providers.delete(oldPath)
			this._providers.set(newPath, provider)
			await conn.reducers.renameFile({
				guid: provider.guid,
				path: newPath,
			})
		}
	}

	get providers(): ReadonlyMap<string, SpacetimeDocProvider> {
		return this._providers
	}

	destroy(): void {
		for (const provider of this._providers.values()) {
			provider.destroy()
		}
		this._providers.clear()
		this._unsubs.forEach((unsub) => unsub())
		this._unsubs = []
	}
}
