import { schema, table, t } from 'spacetimedb/server'

export const YjsDocument = table(
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

export const YjsUpdate = table(
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

export const YjsAwareness = table(
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

export const spacetimedb = schema(YjsDocument, YjsUpdate, YjsAwareness)
