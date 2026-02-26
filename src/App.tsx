import { Editor } from '@monaco-editor/react'
import { editor } from 'monaco-editor/esm/vs/editor/editor.api.js'
import { useReducer, useSpacetimeDB } from 'spacetimedb/react'
import * as Y from 'yjs'
import { SpacetimeDBProvider } from './SpacetimeDBProvider'
import { MonacoBinding } from 'y-monaco'
import { DbConnection, reducers } from './module_bindings'
import { useEffect, useRef, useState } from 'react'

function App() {
	const { isActive, getConnection } = useSpacetimeDB()
	const provider = useRef<SpacetimeDBProvider>()
	const [self, setSelf] = useState({
		name: 'sky',
		color: '#ff0000',
	})
	const clear = useReducer(reducers.clearAll)

	useEffect(() => {
		if (!isActive) return
		const p = provider.current
		if (!p) return
		const prev = p.awareness.getLocalState()
		p.awareness.setLocalState({ ...prev, ...self })
	}, [self, isActive])

	if (!isActive) {
		return <div>Loading...</div>
	}

	return (
		<>
			<div className='fixed bottom-4 right-4 z-10 join'>
				<button
					onClick={() => clear({ docId: 'a-file' })}
					className='btn btn-primary join-item'
				>
					Clear
				</button>
				<input
					type='text'
					className='input join-item'
					value={self.name}
					onChange={(e) =>
						setSelf((pre) => ({ ...pre, name: e.target.value }))
					}
				/>
				<input
					type='color'
					className='input join-item'
					value={self.color}
					onChange={(e) =>
						setSelf((pre) => ({ ...pre, color: e.target.value }))
					}
				/>
			</div>
			<Editor
				height='100vh'
				defaultLanguage='javascript'
				theme='vs-dark'
				onMount={(editor: editor.IStandaloneCodeEditor) => {
					const yDoc = new Y.Doc()
					const conn = getConnection<DbConnection>()
					if (!conn) {
						console.error('No connection found')
						return
					}
					provider.current = new SpacetimeDBProvider(
						conn,
						'a-file',
						yDoc,
					)
					const p = provider.current

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
						p.awareness,
					)

					p.awareness.setLocalState(self)

					p.awareness.on('change', () => {
						p.awareness.getStates().forEach((state, key) => {
							console.log('awareness state', key, state)
						})
					})
				}}
			/>
		</>
	)
}

export default App
