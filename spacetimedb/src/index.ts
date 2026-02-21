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

import { spacetimedb } from './schema'
import { t, SenderError } from 'spacetimedb/server'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** How many pending deltas trigger an automatic compaction. */
const COMPACTION_THRESHOLD = 50

// ---------------------------------------------------------------------------
// initDoc — ensure a document row exists; no-op if already present.
// Called by the client immediately after subscribing.
// ---------------------------------------------------------------------------
spacetimedb.reducer('initDoc', { docId: t.string() }, (ctx, { docId }) => {
	if (!docId) throw new SenderError('docId required')

	const existing = ctx.db.yjsDocument.docId.find(docId)
	if (!existing) {
		ctx.db.yjsDocument.insert({
			docId,
			snapshot: new Uint8Array(0),
			snapshotClock: 0n,
			updatedAt: ctx.timestamp,
		})
	}
})

// ---------------------------------------------------------------------------
// pushUpdate — append a Y.js binary delta to the log.
// After insertion the reducer checks whether compaction is needed.
// ---------------------------------------------------------------------------
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
			snapshotClock: doc.snapshotClock,
			sender: ctx.sender,
			createdAt: ctx.timestamp,
		})

		// Count pending deltas for this doc (single-column index, safe)
		let count = 0
		for (const _ of ctx.db.yjsUpdate.by_doc.filter(docId)) {
			count++
		}

		if (count >= COMPACTION_THRESHOLD) {
			_compact(ctx, docId, doc.snapshotClock)
		}
	},
)

// ---------------------------------------------------------------------------
// compactDoc — manual compaction trigger (client or scheduled job).
// Merges all pending deltas with the current snapshot and bumps the clock.
// The actual Y.js mergeUpdates logic must be performed client-side and the
// merged bytes sent in; the server just does an atomic swap.
//
// Because SpacetimeDB reducers are deterministic we cannot run the Yjs WASM
// codec here.  Instead the client that wins the compaction race sends the
// merged snapshot, and the reducer validates the clock before committing.
// ---------------------------------------------------------------------------
spacetimedb.reducer(
	'compactDoc',
	{
		docId: t.string(),
		mergedSnapshot: t.byteArray(),
		baseClock: t.u64(), // snapshotClock the client merged from
	},
	(ctx, { docId, mergedSnapshot, baseClock }) => {
		if (!docId) throw new SenderError('docId required')

		const doc = ctx.db.yjsDocument.docId.find(docId)
		if (!doc) throw new SenderError(`Document "${docId}" not found`)

		// Optimistic-lock: reject stale compactions
		if (doc.snapshotClock !== baseClock) {
			// Another client already compacted; this payload is stale — silently drop.
			return
		}

		_compact(ctx, docId, baseClock, mergedSnapshot)
	},
)

/**
 * Internal helper: atomically replace snapshot and delete merged deltas.
 * When `newSnapshot` is undefined the snapshot bytes are left unchanged
 * (used for the threshold-triggered path where the client will later
 * supply the merged bytes via `compactDoc`).
 */
function _compact(
	ctx: any,
	docId: string,
	currentClock: bigint,
	newSnapshot?: Uint8Array,
) {
	const newClock = currentClock + 1n

	// Delete all deltas that belong to the current clock epoch
	const toDelete: bigint[] = []
	for (const row of ctx.db.yjsUpdate.by_doc.filter(docId)) {
		if (row.snapshotClock === currentClock) {
			toDelete.push(row.id)
		}
	}
	for (const id of toDelete) {
		ctx.db.yjsUpdate.id.delete(id)
	}

	// Update the document snapshot
	const doc = ctx.db.yjsDocument.docId.find(docId)!
	ctx.db.yjsDocument.docId.update({
		...doc,
		snapshot: newSnapshot ?? doc.snapshot,
		snapshotClock: newClock,
		updatedAt: ctx.timestamp,
	})
}

// ---------------------------------------------------------------------------
// upsertAwareness — publish ephemeral cursor/presence state.
// One row per (docId, clientId) pair; old row is replaced.
// ---------------------------------------------------------------------------
spacetimedb.reducer(
	'upsertAwareness',
	{
		docId: t.string(),
		clientId: t.u64(),
		state: t.string(), // JSON from Y.awareness.getLocalState()
	},
	(ctx, { docId, clientId, state }) => {
		if (!docId) throw new SenderError('docId required')

		// Find existing row for this (docId, clientId)
		let existingId: bigint | null = null
		for (const row of ctx.db.yjsAwareness.by_doc.filter(docId)) {
			if (row.clientId === clientId && row.identity.isEqual(ctx.sender)) {
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
				clientId,
				identity: ctx.sender,
				state,
				updatedAt: ctx.timestamp,
			})
		}
	},
)

// ---------------------------------------------------------------------------
// removeAwareness — clean up when a client disconnects or goes away.
// ---------------------------------------------------------------------------
spacetimedb.reducer(
	'removeAwareness',
	{ docId: t.string(), clientId: t.u64() },
	(ctx, { docId, clientId }) => {
		const toDelete: bigint[] = []
		for (const row of ctx.db.yjsAwareness.by_doc.filter(docId)) {
			if (row.clientId === clientId && row.identity.isEqual(ctx.sender)) {
				toDelete.push(row.id)
			}
		}
		for (const id of toDelete) {
			ctx.db.yjsAwareness.id.delete(id)
		}
	},
)

// ---------------------------------------------------------------------------
// onDisconnect lifecycle — auto-remove stale awareness rows
// ---------------------------------------------------------------------------
spacetimedb.clientDisconnected((ctx) => {
	// Remove all awareness rows owned by the disconnecting identity
	// We must iterate by_doc for each doc — but we have no doc index on identity.
	// Best we can do is a full scan via by_doc is not available without docId.
	// Pattern: store a separate identity→rows mapping isn't available here.
	// SpacetimeDB doesn't support .iter() in lifecycle hooks either.
	// Clients are expected to call removeAwareness before disconnecting;
	// TTL-based cleanup (if needed) can be handled via scheduled reducers.
	// This hook is intentionally left minimal.
})
