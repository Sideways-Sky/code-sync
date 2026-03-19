import { getConnection } from '.'
import { tables } from '../module_bindings'
import { YjsFile } from '../module_bindings/types'
import { SpacetimeDocProvider } from './Doc'
import * as Y from 'yjs'

export class SpacetimeDocsProvider {
	private readonly _files = new Map<string, YjsFile>()
	private readonly _providers = new Map<string, SpacetimeDocProvider>()
	private _unsubs: Array<() => void> = []

	onFilesChange: (() => void) | null = null

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
		this._unsubs.push(() => {
			if (conn.isActive) sub.unsubscribe()
		})

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
		this._files.set(row.path, row)
		if (this.onFilesChange) this.onFilesChange()
	}

	private _onRemoteFileRemove = (_ctx: any, row: YjsFile) => {
		this._files.delete(row.path)
		const provider = this._providers.get(row.path)
		if (provider) {
			provider.destroy()
			this._providers.delete(row.path)
		}
		if (this.onFilesChange) this.onFilesChange()
	}

	private _onRemoteFileUpdate = (
		_ctx: any,
		oldRow: YjsFile,
		newRow: YjsFile,
	) => {
		this._files.delete(oldRow.path)
		this._files.set(newRow.path, newRow)

		if (oldRow.path !== newRow.path) {
			const provider = this._providers.get(oldRow.path)
			if (provider) {
				this._providers.delete(oldRow.path)
				this._providers.set(newRow.path, provider)
			}
			if (this.onFilesChange) this.onFilesChange()
		}
	}

	get docs(): {
		get(path: string): SpacetimeDocProvider | undefined
		keys(): IterableIterator<string>
	} {
		return {
			keys: () => this._files.keys(),
			get: (path: string) => {
				if (this._providers.has(path)) return this._providers.get(path)

				const file = this._files.get(path)
				if (!file) return undefined

				const doc = new Y.Doc()
				Y.applyUpdate(doc, file.snapshot)
				const provider = new SpacetimeDocProvider(doc, file.id)
				this._providers.set(path, provider)
				return provider
			},
		}
	}

	async createDoc(path: string) {
		const conn = getConnection()
		if (!conn) throw new Error('Connection not set')

		await conn.reducers.addFile({
			path,
			snapshot: Y.encodeStateAsUpdate(new Y.Doc()),
		})
	}

	async removeDoc(path: string) {
		const conn = getConnection()
		if (!conn) throw new Error('Connection not set')

		const file = this._files.get(path)
		if (file) {
			await conn.reducers.removeFile({ id: file.id })
		}
	}

	async renameDoc(oldPath: string, newPath: string) {
		const conn = getConnection()
		if (!conn) throw new Error('Connection not set')

		const file = this._files.get(oldPath)
		if (file) {
			await conn.reducers.renameFile({ id: file.id, path: newPath })
		}
	}

	destroy(): void {
		console.log('Docs: destroying')
		for (const provider of this._providers.values()) {
			provider.destroy()
		}
		this._providers.clear()
		this._files.clear()
		this._unsubs.forEach((unsub) => unsub())
		this._unsubs = []
	}
}
