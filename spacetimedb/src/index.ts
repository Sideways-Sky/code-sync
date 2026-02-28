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
		senderYid: t.u32(),
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
		senderYid: t.u32(),
		state: t.byteArray(),
	},
)

const spacetimedb = schema({
	YjsDocument,
	YjsUpdate,
	YjsAwareness,
})
export default spacetimedb

export const pushUpdate = spacetimedb.reducer(
	{ docId: t.string(), update: t.byteArray(), senderYid: t.u32() },
	(ctx, { docId, update, senderYid }) => {
		if (!docId) throw new SenderError('docId required')
		if (!update || update.byteLength === 0)
			throw new SenderError('update must be non-empty')

		ctx.db.YjsUpdate.insert({
			id: 0n,
			docId,
			update,
			senderYid,
			createdAt: ctx.timestamp,
		})
	},
)

export const saveSnapshot = spacetimedb.reducer(
	{
		docId: t.string(),
		snapshot: t.byteArray(),
		pruneBeforeId: t.u64(),
	},
	(ctx, { docId, snapshot, pruneBeforeId }) => {
		if (!docId) throw new SenderError('docId required')
		if (!snapshot || snapshot.length === 0)
			throw new SenderError('snapshot required')

		const doc = ctx.db.YjsDocument.docId.find(docId)
		if (doc) {
			ctx.db.YjsDocument.docId.update({
				...doc,
				snapshot,
				updatedAt: ctx.timestamp,
			})
		} else {
			console.log('Document not found', docId, 'creating...')
			ctx.db.YjsDocument.insert({
				docId,
				snapshot,
				updatedAt: ctx.timestamp,
			})
		}

		// Prune old updates that are before this snapshot
		let pruned = 0
		for (const update of ctx.db.YjsUpdate.docId.filter(docId)) {
			if (update.id <= pruneBeforeId) {
				ctx.db.YjsUpdate.id.delete(update.id)
				pruned++
			}
		}
		console.log('saveSnapshot pruned', pruned, 'updates')
	},
)

export const pushAwareness = spacetimedb.reducer(
	{
		docId: t.string(),
		state: t.byteArray(),
		senderYid: t.u32(),
	},
	(ctx, { docId, state, senderYid }) => {
		if (!docId) throw new SenderError('docId required')
		if (!state || state.length === 0)
			throw new SenderError('update must be non-empty')

		const existing = ctx.db.YjsAwareness.identity.find(ctx.sender)
		if (existing) {
			ctx.db.YjsAwareness.identity.update({
				...existing,
				senderYid,
				state,
			})
		} else {
			ctx.db.YjsAwareness.insert({
				identity: ctx.sender,
				docId,
				senderYid,
				state,
			})
		}
	},
)

export const onDisconnect = spacetimedb.clientDisconnected((ctx) => {
	ctx.db.YjsAwareness.identity.delete(ctx.sender)
})
