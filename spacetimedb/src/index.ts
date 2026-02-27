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

const YjsDocument = table(
	{
		name: 'yjs_document',
		public: true,
		indexes: [],
	},
	{
		docId: t.string().primaryKey(),
		snapshot: t.byteArray(),
		updatedAt: t.timestamp(),
	},
)

const YjsUpdate = table(
	{
		name: 'yjs_update',
		public: true,
	},
	{
		id: t.u64().primaryKey().autoInc(),
		docId: t.string().index(),
		update: t.byteArray(),
		senderYID: t.u32(),
		createdAt: t.timestamp(),
	},
)

const YjsAwareness = table(
	{
		name: 'yjs_awareness',
		public: true,
	},
	{
		identity: t.identity().primaryKey(),
		docId: t.string().index(),
		senderYID: t.u32(),
		state: t.byteArray(),
	},
)

const spacetimedb = schema({
	YjsDocument,
	YjsUpdate,
	YjsAwareness,
})
export default spacetimedb

export const initDoc = spacetimedb.reducer(
	{ docId: t.string(), snapshot: t.byteArray() },
	(ctx, { docId, snapshot }) => {
		if (!docId) throw new SenderError('docId required')

		const existing = ctx.db.YjsDocument.docId.find(docId)
		if (!existing) {
			console.log('initDoc', snapshot)
			ctx.db.YjsDocument.insert({
				docId,
				snapshot,
				updatedAt: ctx.timestamp,
			})
		} else {
			console.log('initDoc — already exists')
		}
	},
)

export const pushUpdate = spacetimedb.reducer(
	{ docId: t.string(), update: t.byteArray(), senderYID: t.u32() },
	(ctx, { docId, update, senderYID }) => {
		if (!docId) throw new SenderError('docId required')
		if (!update || update.byteLength === 0)
			throw new SenderError('update must be non-empty')

		const doc = ctx.db.YjsDocument.docId.find(docId)
		if (!doc)
			throw new SenderError(
				`Document "${docId}" not found — call initDoc first`,
			)

		ctx.db.YjsUpdate.insert({
			id: 0n,
			docId,
			update,
			senderYID,
			createdAt: ctx.timestamp,
		})
	},
)

export const saveSnapshot = spacetimedb.reducer(
	{
		docId: t.string(),
		snapshot: t.byteArray(),
	},
	(ctx, { docId, snapshot }) => {
		if (!docId) throw new SenderError('docId required')
		if (!snapshot || snapshot.length === 0)
			throw new SenderError('snapshot required')

		const doc = ctx.db.YjsDocument.docId.find(docId)
		if (!doc)
			throw new SenderError(
				`Document "${docId}" not found — call initDoc first`,
			)
		ctx.db.YjsDocument.docId.update({
			...doc,
			snapshot,
			updatedAt: ctx.timestamp,
		})

		// Prune old updates that are before this snapshot
		let pruned = 0
		for (const update of ctx.db.YjsUpdate.docId.filter(docId)) {
			if (update.createdAt < ctx.timestamp) {
				ctx.db.YjsUpdate.id.delete(update.id)
				pruned++
			}
		}
		console.log('saveSnapshot — pruned', pruned)
	},
)

export const pushAwareness = spacetimedb.reducer(
	{
		docId: t.string(),
		state: t.byteArray(),
		senderYID: t.u32(),
	},
	(ctx, { docId, state, senderYID }) => {
		if (!docId) throw new SenderError('docId required')
		if (!state || state.length === 0)
			throw new SenderError('update must be non-empty')

		const doc = ctx.db.YjsDocument.docId.find(docId)
		if (!doc)
			throw new SenderError(
				`Document "${docId}" not found — call initDoc first`,
			)

		const existing = ctx.db.YjsAwareness.identity.find(ctx.sender)
		if (existing) {
			ctx.db.YjsAwareness.identity.update({
				...existing,
				senderYID,
				state,
			})
		} else {
			ctx.db.YjsAwareness.insert({
				identity: ctx.sender,
				docId,
				senderYID,
				state,
			})
		}
	},
)

export const clearAll = spacetimedb.reducer(
	{ docId: t.string() },
	(ctx, { docId }) => {
		if (!docId) throw new SenderError('docId required')

		ctx.db.YjsAwareness.docId.delete(docId)
		ctx.db.YjsDocument.docId.delete(docId)
		ctx.db.YjsUpdate.docId.delete(docId)
	},
)

export const onDisconnect = spacetimedb.clientDisconnected((ctx) => {
	ctx.db.YjsAwareness.identity.delete(ctx.sender)
})
