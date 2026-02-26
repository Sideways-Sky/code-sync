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

import { snapshot } from 'yjs'
import { spacetimedb } from './schema'
import { t, SenderError } from 'spacetimedb/server'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// initDoc — ensure a document row exists; no-op if already present.
// Called by the client immediately after subscribing.
// ---------------------------------------------------------------------------
spacetimedb.reducer(
	'initDoc',
	{ docId: t.string(), snapshot: t.byteArray() },
	(ctx, { docId, snapshot }) => {
		if (!docId) throw new SenderError('docId required')

		const existing = ctx.db.yjsDocument.docId.find(docId)
		if (!existing) {
			console.log('initDoc', snapshot)
			ctx.db.yjsDocument.insert({
				docId,
				snapshot,
				updatedAt: ctx.timestamp,
			})
		} else {
			console.log('initDoc — already exists')
		}
	},
)

spacetimedb.reducer(
	'pushUpdate',
	{ docId: t.string(), update: t.byteArray(), senderYID: t.u32() },
	(ctx, { docId, update, senderYID }) => {
		if (!docId) throw new SenderError('docId required')
		if (!update || update.byteLength === 0)
			throw new SenderError('update must be non-empty')

		const doc = ctx.db.yjsDocument.docId.find(docId)
		if (!doc)
			throw new SenderError(
				`Document "${docId}" not found — call initDoc first`,
			)

		ctx.db.yjsUpdate.insert({
			id: 0n,
			docId,
			update,
			senderYID,
			createdAt: ctx.timestamp,
		})
	},
)

spacetimedb.reducer(
	'saveSnapshot',
	{
		docId: t.string(),
		snapshot: t.byteArray(),
	},
	(ctx, { docId, snapshot }) => {
		if (!docId) throw new SenderError('docId required')
		if (!snapshot || snapshot.length === 0)
			throw new SenderError('snapshot required')

		const doc = ctx.db.yjsDocument.docId.find(docId)
		if (!doc)
			throw new SenderError(
				`Document "${docId}" not found — call initDoc first`,
			)
		ctx.db.yjsDocument.docId.update({
			...doc,
			snapshot,
			updatedAt: ctx.timestamp,
		})

		// Prune old updates that are before this snapshot
		let pruned = 0
		for (const update of ctx.db.yjsUpdate.by_doc.filter(docId)) {
			if (update.createdAt < ctx.timestamp) {
				ctx.db.yjsUpdate.id.delete(update.id)
				pruned++
			}
		}
		console.log('saveSnapshot — pruned', pruned)
	},
)

spacetimedb.reducer(
	'pushAwareness',
	{
		docId: t.string(),
		update: t.byteArray(),
		senderYID: t.u32(),
	},
	(ctx, { docId, update, senderYID }) => {
		if (!docId) throw new SenderError('docId required')
		if (!update || update.byteLength === 0)
			throw new SenderError('update must be non-empty')

		const doc = ctx.db.yjsDocument.docId.find(docId)
		if (!doc)
			throw new SenderError(
				`Document "${docId}" not found — call initDoc first`,
			)

		ctx.db.yjsAwareness.insert({
			id: 0n,
			docId,
			update,
			updatedAt: ctx.timestamp,
			senderYID,
		})
	},
)

spacetimedb.reducer('clearAll', { docId: t.string() }, (ctx, { docId }) => {
	if (!docId) throw new SenderError('docId required')

	ctx.db.yjsAwareness.by_doc.delete(docId)
	ctx.db.yjsDocument.docId.delete(docId)
	ctx.db.yjsUpdate.by_doc.delete(docId)
})

spacetimedb.clientDisconnected((ctx) => {})
