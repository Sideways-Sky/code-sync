/**
 * index.ts — Yjs/SpacetimeDB bridge reducers
 *
 * Lifecycle:
 *   1. Client calls `initDoc` to create the snapshot.
 *   2. Local Yjs changes are forwarded via `pushUpdate`.
 *   3. When the delta log grows large, the server-side `compactDoc` reducer
 *      collapses everything into a new snapshot atomically.
 *   4. Awareness state is kept alive via `upsertAwareness` and cleaned up
 *      with `removeAwareness` on disconnect.
 *
 * NOTE: Reducers are deterministic and transactional — no network, no random.
 */
import { t, SenderError, schema, table } from 'spacetimedb/server'

const YjsFile = table(
	{
		name: 'yjs_file',
		public: true,
	},
	{
		guid: t.u128().primaryKey(),
		path: t.string(), // "docs/notes/hello.md"
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
		guid: t.u128().index(),
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
		guid: t.u128().index(),
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
	{ update: t.byteArray(), guid: t.u128(), clientId: t.u32() },
	(ctx, { update, guid, clientId }) => {
		if (!guid) throw new SenderError('guid required')
		if (!update || update.byteLength === 0)
			throw new SenderError('update must be non-empty')
		if (!clientId) throw new SenderError('clientId required')

		ctx.db.YjsUpdate.insert({
			id: 0n,
			guid,
			update,
			senderClientId: clientId,
		})
	},
)

export const saveSnapshot = spacetimedb.reducer(
	{
		guid: t.u128(),
		snapshot: t.byteArray(),
		pruneBeforeId: t.u64(),
	},
	(ctx, { guid, snapshot, pruneBeforeId }) => {
		if (!guid) throw new SenderError('guid required')
		if (!snapshot || snapshot.length === 0)
			throw new SenderError('snapshot required')

		const file = ctx.db.YjsFile.guid.find(guid)
		if (!file) throw new SenderError('file not found')

		ctx.db.YjsFile.guid.update({
			...file,
			snapshot,
		})

		// Prune old updates that are before this snapshot
		let pruned = 0
		for (const update of ctx.db.YjsUpdate.guid.filter(guid)) {
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
		guid: t.u128(),
		path: t.string(),
		snapshot: t.byteArray(),
	},
	(ctx, { guid, path, snapshot }) => {
		if (!path) throw new SenderError('path required')
		if (!snapshot || snapshot.length === 0)
			throw new SenderError('snapshot required')

		const file = ctx.db.YjsFile.guid.find(guid)
		if (file) {
			ctx.db.YjsFile.guid.update({
				...file,
				path,
				snapshot,
			})
			return
		}

		ctx.db.YjsFile.insert({
			guid,
			path,
			snapshot,
		})
	},
)

export const removeFile = spacetimedb.reducer(
	{
		guid: t.u128(),
	},
	(ctx, { guid }) => {
		if (!guid) throw new SenderError('guid required')

		ctx.db.YjsFile.guid.delete(guid)
		ctx.db.YjsUpdate.guid.delete(guid)
		console.log('removeFile', guid)
	},
)

export const pushAwareness = spacetimedb.reducer(
	{
		guid: t.u128(),
		clientId: t.u32(),
		state: t.byteArray(),
	},
	(ctx, { guid, clientId, state }) => {
		if (!guid) throw new SenderError('guid required')
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
				guid,
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
		ctx.db.YjsFile.guid.delete(file.guid)
	}
	for (const update of ctx.db.YjsUpdate.iter()) {
		ctx.db.YjsUpdate.id.delete(update.id)
	}
	for (const awareness of ctx.db.YjsAwareness.iter()) {
		ctx.db.YjsAwareness.identity.delete(awareness.identity)
	}
})
