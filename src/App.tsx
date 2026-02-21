import { Editor } from '@monaco-editor/react'
import { editor } from 'monaco-editor/esm/vs/editor/editor.api.js'
import { useSpacetimeDB } from 'spacetimedb/react'
import * as Y from 'yjs'
import { SpacetimeDBProvider } from './SpacetimeDBProvider'
import { MonacoBinding } from 'y-monaco'
import { DbConnection } from './module_bindings'

function App() {
	const { isActive, getConnection } = useSpacetimeDB()

	if (!isActive) {
		return <div>Loading...</div>
	}

	return (
		<div>
			<Editor
				height='90vh'
				defaultLanguage='javascript'
				theme='vs-dark'
				onMount={(editor: editor.IStandaloneCodeEditor) => {
					const yDoc = new Y.Doc()
					const conn = getConnection<DbConnection>()
					if (!conn) {
						console.error('No connection found')
						return
					}
					const provider = new SpacetimeDBProvider(
						conn,
						'a-file',
						yDoc,
					)
					const type = yDoc.getText('monaco')
					new Y.UndoManager(type)
					const model = editor.getModel()
					if (!model) {
						console.error('No model found')
						return
					}

					new MonacoBinding(
						type,
						model,
						new Set([editor]),
						provider.awareness,
					)
				}}
			/>
		</div>
	)
}

export default App
