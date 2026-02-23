/**
 * index.ts — Yjs/SpacetimeDB bridge reducers
 *
 * Lifecycle:
 *   1. Client calls `initDoc` to obtain (or create) the snapshot + pending deltas.
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
	{ docId: t.string(), update: t.byteArray() },
	(ctx, { docId, update }) => {
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
			sender: ctx.sender,
			createdAt: ctx.timestamp,
		})
	},
)

spacetimedb.reducer(
	'upsertAwareness',
	{
		docId: t.string(),
		state: t.string(),
	},
	(ctx, { docId, state }) => {
		if (!docId) throw new SenderError('docId required')

		let existingId: bigint | null = null
		for (const row of ctx.db.yjsAwareness.by_doc.filter(docId)) {
			if (row.identity.isEqual(ctx.sender)) {
				existingId = row.id
				break
			}
		}

		if (existingId !== null) {
			const existing = ctx.db.yjsAwareness.id.find(existingId)!
			ctx.db.yjsAwareness.id.update({
				...existing,
				state,
				updatedAt: ctx.timestamp,
			})
		} else {
			ctx.db.yjsAwareness.insert({
				id: 0n,
				docId,
				identity: ctx.sender,
				state,
				updatedAt: ctx.timestamp,
			})
		}
	},
)

spacetimedb.reducer(
	'removeAwareness',
	{ docId: t.string() },
	(ctx, { docId }) => {
		for (const row of ctx.db.yjsAwareness.by_doc.filter(docId)) {
			if (row.identity.isEqual(ctx.sender)) {
				ctx.db.yjsAwareness.id.delete(row.id)
			}
		}
	},
)

spacetimedb.clientDisconnected((ctx) => {})
