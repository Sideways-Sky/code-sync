import { Editor } from '@monaco-editor/react'
import { editor } from 'monaco-editor/esm/vs/editor/editor.api.js'
import { useSpacetimeDB } from 'spacetimedb/react'
import * as Y from 'yjs'
import { MonacoBinding } from 'y-monaco'
import { useEffect, useRef, useState } from 'react'
import { SpacetimeDocsProvider } from './SpacetimeProviders/Docs'

function App() {
	const { isActive } = useSpacetimeDB()
	const [docsProvider, setDocsProvider] =
		useState<SpacetimeDocsProvider | null>(null)

	useEffect(() => {
		if (!isActive) return
		if (!docsProvider) {
			const provider = new SpacetimeDocsProvider()
			setDocsProvider(provider)
		}
		return () => {
			docsProvider?.destroy()
			setDocsProvider(null)
		}
	}, [isActive])

	if (!isActive || !docsProvider) {
		return <div>Loading...</div>
	}

	return <EditorPage docsProvider={docsProvider} />
}

function EditorPage({ docsProvider }: { docsProvider: SpacetimeDocsProvider }) {
	const [files, setFiles] = useState<string[]>([])
	const [activeFile, setActiveFile] = useState<string | null>(null)
	const [monacoEditor, setMonacoEditor] =
		useState<editor.IStandaloneCodeEditor | null>(null)
	const bindingRef = useRef<MonacoBinding | null>(null)
	const [self, setSelf] = useState({
		name: 'sky',
		color: '#ff0000',
	})

	useEffect(() => {
		if (!activeFile) return
		const p = docsProvider.docs.get(activeFile)
		if (!p) return
		const prev = p.awareness.getLocalState()
		p.awareness.setLocalState({ ...prev, ...self })
	}, [self, activeFile])

	const refreshFiles = () => {
		setFiles([...(docsProvider.docs.keys() ?? [])])
	}

	useEffect(() => {
		docsProvider.onFilesChange = refreshFiles
		return () => {
			docsProvider.onFilesChange = null
		}
	}, [docsProvider])

	useEffect(() => {
		if (!monacoEditor || !activeFile) return

		// Tear down previous binding.
		bindingRef.current?.destroy()
		bindingRef.current = null

		const provider = docsProvider.docs.get(activeFile)
		if (!provider) {
			console.error('No provider for file', activeFile)
			return
		}

		const type = provider.doc.getText('monaco')
		new Y.UndoManager(type)

		const model = monacoEditor.getModel()
		if (!model) {
			console.error('No model found')
			return
		}

		bindingRef.current = new MonacoBinding(
			type,
			model,
			new Set([monacoEditor]),
			provider.awareness,
		)

		provider.awareness.setLocalState(self)
		const style = document.getElementById('style')
		if (!style) {
			console.error('No style element')
			return
		}
		const refreshAwareness = () => {
			provider.awareness.getStates().forEach((client, clientId) => {
				const selectionClass = `yRemoteSelection-${clientId}`
				const selectionHeadClass = `yRemoteSelectionHead-${clientId}`

				const red = parseInt(client.color.substring(1, 3), 16)
				const green = parseInt(client.color.substring(3, 5), 16)
				const blue = parseInt(client.color.substring(5, 7), 16)

				style.innerHTML = `
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
		}`
			})
		}

		provider.awareness.on('change', refreshAwareness)
		return () => {
			provider.awareness.off('change', refreshAwareness)
		}
	}, [activeFile, monacoEditor])

	return (
		<div className='flex h-screen w-screen'>
			{/* Sidebar */}
			<ul className='menu w-52 bg-base-200 overflow-y-auto shrink-0'>
				<button
					className='btn btn-sm btn-primary mb-4'
					onClick={async (e) => {
						e.stopPropagation()
						e.preventDefault()
						const path = prompt('Enter file name', 'untitled.js')
						if (!path) return
						await docsProvider.createDoc(path)
						refreshFiles()
						setActiveFile(path)
					}}
				>
					+ New File
				</button>
				{files.length === 0 && (
					<li className='menu-disabled'>No files yet</li>
				)}
				{files.map((path) => (
					<li
						key={path}
						className={`group flex flex-row items-center gap-1 ${
							activeFile === path ? 'menu-active' : ''
						}`}
						onClick={() => setActiveFile(path)}
					>
						<span className='flex-1 text-sm truncate'>{path}</span>
						<button
							className='btn btn-xs btn-ghost btn-info opacity-0 group-hover:opacity-100'
							title='Rename'
							onClick={async (e) => {
								e.stopPropagation()
								e.preventDefault()
								const newPath = prompt(
									'Enter new file name',
									path,
								)
								if (!newPath) return
								await docsProvider.renameDoc(path, newPath)
								refreshFiles()
							}}
						>
							✎
						</button>
						<button
							className='btn btn-xs btn-ghost btn-error opacity-0 group-hover:opacity-100'
							title='Delete'
							onClick={async (e) => {
								e.stopPropagation()
								e.preventDefault()
								if (!confirm(`Delete "${path}"?`)) return
								if (activeFile === path) {
									bindingRef.current?.destroy()
									bindingRef.current = null
									setActiveFile(null)
								}
								await docsProvider.removeDoc(path)
								refreshFiles()
							}}
						>
							✕
						</button>
					</li>
				))}
				<div className='join mt-auto'>
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
							setSelf((pre) => ({
								...pre,
								color: e.target.value,
							}))
						}
					/>
				</div>
			</ul>

			{/* Editor */}
			<div className='flex-1'>
				{activeFile ? (
					<Editor
						height='100vh'
						defaultLanguage='javascript'
						theme='vs-dark'
						onMount={(
							mountedEditor: editor.IStandaloneCodeEditor,
						) => {
							setMonacoEditor(mountedEditor)
						}}
					/>
				) : (
					<div className='flex h-full items-center justify-center text-base-content/40 text-sm'>
						Create or select a file to start editing
					</div>
				)}
			</div>
		</div>
	)
}

export default App
