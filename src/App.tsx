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
	const provider = useRef<SpacetimeDBProvider | null>(null)
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
					const conn = getConnection() as DbConnection
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
					const selectionStyle = document.createElement('style')
					document.head.appendChild(selectionStyle)
					p.awareness.on('change', () => {
						p.awareness.getStates().forEach((client, clientId) => {
							const selectionClass = `yRemoteSelection-${clientId}`
							const selectionHeadClass = `yRemoteSelectionHead-${clientId}`

							const red = parseInt(
								client.color.substring(1, 3),
								16,
							)
							const green = parseInt(
								client.color.substring(3, 5),
								16,
							)
							const blue = parseInt(
								client.color.substring(5, 7),
								16,
							)

							selectionStyle.innerHTML = `
					.${selectionClass} {
						background-color: rgba(${red}, ${green}, ${blue}, 0.70);
						border-radius: 2px
					}

					.${selectionHeadClass} {
						z-index: 1;
						position: absolute;
						border-left: ${client.color} solid 2px;
						border-top: ${client.color} solid 2px;
						border-bottom: ${client.color} solid 2px;
						height: 100%;
						box-sizing: border-box;
					}

					.${selectionHeadClass}::after {
						position: absolute;
						content: ' ';
						border: 3px solid ${client.color};
						border-radius: 4px;
						left: -4px;
						top: -5px;
					}

					.${selectionHeadClass}:hover::before {
						content: '${client.name}';
						position: absolute;
						background-color: ${client.color};
						color: black;
						padding-right: 3px;
						padding-left: 3px;
						margin-top: -2px;
						font-size: 12px;
						border-top-right-radius: 4px;
						border-bottom-right-radius: 4px;
					}
					`
						})
					})
				}}
			/>
		</>
	)
}

export default App
