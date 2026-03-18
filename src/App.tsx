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
	const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
	const bindingRef = useRef<MonacoBinding | null>(null)

	const refreshFiles = () => {
		console.log('refreshFiles')
		setFiles([...(docsProvider.providers.keys() ?? [])])
	}

	useEffect(() => {
		docsProvider.onChange = refreshFiles
		return () => {
			docsProvider.onChange = null
		}
	}, [docsProvider])

	useEffect(() => {
		const monacoEditor = editorRef.current
		if (!monacoEditor || !activeFile) return

		// Tear down previous binding.
		bindingRef.current?.destroy()
		bindingRef.current = null

		const provider = docsProvider.providers.get(activeFile)
		if (!provider) return

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
		)
	}, [activeFile])

	// --- File operations ---

	const handleAddFile = async () => {
		const path = prompt('Enter file name', 'untitled.js')
		if (!path) return
		await docsProvider.createDoc(path)
		refreshFiles()
		setActiveFile(path)
	}

	const handleRemoveFile = async (path: string) => {
		if (!confirm(`Delete "${path}"?`)) return
		if (activeFile === path) {
			bindingRef.current?.destroy()
			bindingRef.current = null
			setActiveFile(null)
		}
		await docsProvider.removeDoc(path)
		refreshFiles()
	}

	const handleRenameFile = async (path: string) => {
		const newPath = prompt('Enter new file name', path)
		if (!newPath) return
		await docsProvider.renameDoc(path, newPath)
		refreshFiles()
	}

	return (
		<div className='flex h-screen w-screen'>
			{/* Sidebar */}

			<ul className='menu w-52 bg-base-200 overflow-y-auto shrink-0'>
				<button
					className='btn btn-sm btn-primary mb-4'
					onClick={handleAddFile}
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
							onClick={(e) => {
								e.stopPropagation()
								handleRenameFile(path)
							}}
						>
							✎
						</button>
						<button
							className='btn btn-xs btn-ghost btn-error opacity-0 group-hover:opacity-100'
							title='Delete'
							onClick={(e) => {
								e.stopPropagation()
								handleRemoveFile(path)
							}}
						>
							✕
						</button>
					</li>
				))}
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
							editorRef.current = mountedEditor
							// Trigger binding setup now that the editor is ready.
							// setActiveFile((f) => f)
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
