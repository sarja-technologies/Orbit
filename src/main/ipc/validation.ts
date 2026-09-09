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
  projectId: idSchema,
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
  defaultModel: z.string().trim().min(1).max(200).nullable().default(null),
  lastReasoningEffort: reasoningEffortSchema.nullable(),
  modelReasoningEfforts: z.record(z.string().min(1).max(200), reasoningEffortSchema)
})

export const renameConversationSchema = z.object({
  conversationId: idSchema,
  title: z.string().trim().min(1).max(120)
})

export const deleteConversationSchema = z.object({
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
  projectId: idSchema,
  conversationId: idSchema,
  content: z.string().trim().min(1).max(100_000),
  attachmentFileIds: z.array(idSchema).optional(),
  referencedArtifactIds: z.array(idSchema).optional()
})

export const cancelRunSchema = z.object({
  runId: idSchema
})

export const attachFilesSchema = z.object({
  projectId: idSchema
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
