import { z } from 'zod'

export const idSchema = z.string().min(1)

export const createProjectSchema = z.object({
  name: z.string().trim().min(1).max(120)
})

export const createConversationSchema = z.object({
  projectId: idSchema,
  title: z.string().trim().min(1).max(120).optional()
})

export const renameConversationSchema = z.object({
  conversationId: idSchema,
  title: z.string().trim().min(1).max(120)
})

export const setConversationTransportSchema = z.object({
  conversationId: idSchema,
  transport: z.enum(['structured', 'pty'])
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
