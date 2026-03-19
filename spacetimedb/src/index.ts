import { t, SenderError, schema, table } from 'spacetimedb/server'

const YjsFile = table(
	{
		name: 'yjs_file',
		public: true,
	},
	{
		id: t.u64().primaryKey().autoInc(),
		path: t.string().index(), // "docs/notes/hello.md"
		snapshot: t.byteArray(),
	},
)

const YjsUpdate = table(
	{
		name: 'yjs_update',
		public: true,
	},
	{
		id: t.u64().primaryKey().autoInc(),
		fileId: t.u64().index(),
		update: t.byteArray(),
		senderClientId: t.u32(),
	},
)

const YjsAwareness = table(
	{
		name: 'yjs_awareness',
		public: true,
	},
	{
		identity: t.identity().primaryKey(),
		fileId: t.u64().index(),
		clientId: t.u32(),
		state: t.byteArray(),
	},
)

const spacetimedb = schema({
	YjsFile,
	YjsUpdate,
	YjsAwareness,
})
export default spacetimedb

export const pushUpdate = spacetimedb.reducer(
	{ update: t.byteArray(), fileId: t.u64(), clientId: t.u32() },
	(ctx, { update, fileId, clientId }) => {
		if (!fileId) throw new SenderError('fileId required')
		if (!update || update.byteLength === 0)
			throw new SenderError('update must be non-empty')
		if (!clientId) throw new SenderError('clientId required')

		ctx.db.YjsUpdate.insert({
			id: 0n,
			fileId,
			update,
			senderClientId: clientId,
		})
	},
)

export const saveSnapshot = spacetimedb.reducer(
	{
		fileId: t.u128(),
		snapshot: t.byteArray(),
		pruneBeforeId: t.u64(),
	},
	(ctx, { fileId, snapshot, pruneBeforeId }) => {
		if (!fileId) throw new SenderError('fileId required')
		if (!snapshot || snapshot.length === 0)
			throw new SenderError('snapshot required')

		const file = ctx.db.YjsFile.id.find(fileId)
		if (!file) throw new SenderError('file not found')

		ctx.db.YjsFile.id.update({
			...file,
			snapshot,
		})

		// Prune old updates that are before this snapshot
		let pruned = 0
		for (const update of ctx.db.YjsUpdate.fileId.filter(fileId)) {
			if (update.id <= pruneBeforeId) {
				ctx.db.YjsUpdate.id.delete(update.id)
				pruned++
			}
		}
		console.log('saveSnapshot pruned', pruned, 'updates')
	},
)

export const addFile = spacetimedb.reducer(
	{
		path: t.string(),
		snapshot: t.byteArray(),
	},
	(ctx, { path, snapshot }) => {
		if (!path) throw new SenderError('path required')
		if (!snapshot || snapshot.length === 0)
			throw new SenderError('snapshot required')

		ctx.db.YjsFile.insert({
			id: 0n,
			path,
			snapshot,
		})
	},
)

export const removeFile = spacetimedb.reducer(
	{
		id: t.u64(),
	},
	(ctx, { id }) => {
		if (!id) throw new SenderError('id required')

		ctx.db.YjsFile.id.delete(id)
		ctx.db.YjsUpdate.fileId.delete(id)
		console.log('removeFile', id)
	},
)

export const renameFile = spacetimedb.reducer(
	{
		id: t.u64(),
		path: t.string(),
	},
	(ctx, { id, path }) => {
		if (!id) throw new SenderError('id required')
		if (!path) throw new SenderError('path required')

		const file = ctx.db.YjsFile.id.find(id)
		if (!file) throw new SenderError('file not found')

		ctx.db.YjsFile.id.update({
			...file,
			path,
		})

		console.log('renameFile', id, path)
	},
)

export const pushAwareness = spacetimedb.reducer(
	{
		fileId: t.u64(),
		clientId: t.u32(),
		state: t.byteArray(),
	},
	(ctx, { fileId, clientId, state }) => {
		if (!fileId) throw new SenderError('fileId required')
		if (!clientId) throw new SenderError('clientId required')
		if (!state || state.length === 0)
			throw new SenderError('update must be non-empty')

		const existing = ctx.db.YjsAwareness.identity.find(ctx.sender)
		if (existing) {
			ctx.db.YjsAwareness.identity.update({
				...existing,

				state,
			})
		} else {
			ctx.db.YjsAwareness.insert({
				identity: ctx.sender,
				clientId,
				fileId,
				state,
			})
		}
	},
)

export const onDisconnect = spacetimedb.clientDisconnected((ctx) => {
	ctx.db.YjsAwareness.identity.delete(ctx.sender)
})

// for testing - remove everything
export const reset = spacetimedb.reducer({}, (ctx) => {
	for (const file of ctx.db.YjsFile.iter()) {
		ctx.db.YjsFile.id.delete(file.id)
	}
	for (const update of ctx.db.YjsUpdate.iter()) {
		ctx.db.YjsUpdate.id.delete(update.id)
	}
	for (const awareness of ctx.db.YjsAwareness.iter()) {
		ctx.db.YjsAwareness.identity.delete(awareness.identity)
	}
})
