import { z } from 'zod'

export const idSchema = z.string().min(1)

/** A working folder is always an absolute OS path the user picked in the
 *  native dialog. null is a real value meaning "no folder of its own". */
export const folderPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .refine((value) => value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value), {
    message: 'A working folder must be an absolute path.'
  })

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  rootPath: folderPathSchema.nullish()
})

export const setProjectRootSchema = z.object({
  projectId: idSchema,
  rootPath: folderPathSchema.nullable()
})

export const createConversationSchema = z.object({
  // Null/absent means Unsorted: a session that belongs to no project.
  projectId: idSchema.nullish().transform((value) => value ?? null),
  title: z.string().trim().min(1).max(120).optional(),
  workingDirectory: folderPathSchema.nullish()
})

export const setConversationWorkingDirectorySchema = z.object({
  conversationId: idSchema,
  workingDirectory: folderPathSchema.nullable()
})

export const pickFolderSchema = z
  .object({
    defaultPath: folderPathSchema.nullish(),
    title: z.string().trim().min(1).max(120).optional()
  })
  .nullish()

const reasoningEffortSchema = z.enum(['low', 'medium', 'high'])

export const preferencesSchema = z.object({
  lastReasoningEffort: reasoningEffortSchema.nullable(),
  modelReasoningEfforts: z.record(z.string().min(1).max(200), reasoningEffortSchema),
  // Bounded here as well as clamped in the layout, so nothing outside a
  // plausible range is ever persisted in the first place.
  sidebarWidth: z.number().finite().min(120).max(900).nullable().default(null),
  lastActiveProjectId: idSchema.nullable().default(null),
  lastActiveConversationId: idSchema.nullable().default(null),
  defaultModelId: z.string().min(1).max(200).nullable().default(null),
  defaultPermissionMode: z.enum(['ask', 'skip']).nullable().default(null),
  showRepositoryActions: z.boolean().nullable().default(null)
})

/** Bounded so an enormous renderer string can never be pushed at the OS
 *  clipboard. A megabyte is far beyond any real message. */
/** The picker category the renderer may ask for. A closed enum: the
 *  renderer names one of three intents, and the main process owns the
 *  dialog and its filters — there is no way to ask for an arbitrary
 *  Electron dialog from here. */
export const attachmentPickerCategorySchema = z.enum(['image', 'video', 'files'])

export const assignConversationProjectSchema = z.object({
  conversationId: idSchema,
  projectId: idSchema
})

export const clearAllDataSchema = z.object({ confirmation: z.string().max(64) })

export const clipboardTextSchema = z.string().max(1_000_000)

export const setPermissionModeSchema = z.object({
  conversationId: idSchema,
  permissionMode: z.enum(['ask', 'skip'])
})

export const renameConversationSchema = z.object({
  conversationId: idSchema,
  title: z.string().trim().min(1).max(120)
})

export const deleteConversationSchema = z.object({
  conversationId: idSchema
})

/** Naming one existing session and nothing else. The main process resolves
 *  that session's real workspace itself — the renderer never supplies a
 *  path to run git in. */
export const repositoryStateSchema = z.object({
  conversationId: idSchema
})

export const setConversationModelSchema = z.object({
  conversationId: idSchema,
  // Both nullable on purpose: null means "Antigravity's own default", which
  // is a real, valid choice — not a missing value to be filled in.
  model: z.string().trim().min(1).max(200).nullable(),
  reasoningEffort: z.enum(['low', 'medium', 'high']).nullable()
})

export const setConversationTransportSchema = z.object({
  conversationId: idSchema,
  transport: z.enum(['structured', 'pty'])
})

/** Drag-and-drop paths originate from a real OS drag the user performed,
 *  but they are still renderer-supplied: require absolute paths and cap the
 *  batch. Existence/regular-file/size checks remain in FileStorage. */
export const attachPathsSchema = z.object({
  projectId: idSchema,
  paths: z.array(z.string().trim().min(1).max(4096)).min(1).max(20)
})

/** Pasted image bytes. The name is sanitized again in FileStorage; the
 *  size cap here is a cheap first gate before anything is written. */
export const attachImageSchema = z.object({
  projectId: idSchema,
  name: z.string().trim().min(1).max(200),
  data: z.instanceof(Uint8Array).refine((value) => value.byteLength > 0 && value.byteLength <= 100 * 1024 * 1024, {
    message: 'Pasted images must be between 1 byte and 100 MB.'
  })
})

export const respondToInteractionSchema = z.object({
  conversationId: idSchema,
  runId: idSchema,
  interactionId: z.string().trim().min(1).max(200),
  optionId: z.string().trim().min(1).max(200)
})

export const sendMessageSchema = z.object({
  // Null/absent is an Unsorted session — one that belongs to no project.
  // The conversation is what owns the turn; this is only ever a consistency
  // check against what the caller believed (see OrbitRuntime.sendMessage),
  // so requiring a string here rejected a legitimate state before the
  // runtime could look at it. Same semantics as createConversationSchema.
  projectId: idSchema.nullish().transform((value) => value ?? null),
  conversationId: idSchema,
  content: z.string().trim().min(1).max(100_000),
  attachmentFileIds: z.array(idSchema).optional(),
  referencedArtifactIds: z.array(idSchema).optional()
})

export const cancelRunSchema = z.object({
  runId: idSchema
})

/** Attachments are project-scoped for real, not by oversight: a stored file
 *  row requires a project (project_files.project_id is NOT NULL) and the
 *  bytes live under that project's directory. An Unsorted session therefore
 *  has nowhere to put one, and the composer disables the control rather
 *  than letting a send fail at this boundary. */
export const attachFilesSchema = z.object({
  projectId: idSchema,
  category: attachmentPickerCategorySchema.default('files')
})

export const importArtifactSchema = z.object({
  projectId: idSchema,
  conversationId: idSchema.nullish()
})

export const createReferenceSchema = z.object({
  projectId: idSchema,
  artifactId: idSchema,
  destinationConversationId: idSchema
})
