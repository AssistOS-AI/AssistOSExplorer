export function normalizeOptionalTransportEnum(value) {
  return value === '' || value === null || value === undefined ? undefined : value;
}

export function createSchemas(z) {
  const ReadTextFileArgsSchema = z.object({
    path: z.string(),
    tail: z.number().optional().describe('If provided, returns only the last N lines of the file'),
    head: z.number().optional().describe('If provided, returns only the first N lines of the file')
  });
  const ReadMediaFileArgsSchema = z.object({ path: z.string() });
  const ReadMultipleFilesArgsSchema = z.object({ paths: z.array(z.string()) });
  const WriteFileArgsSchema = z.object({ path: z.string(), content: z.string() });
  const WriteBinaryFileArgsSchema = z.object({
    path: z.string(),
    content: z.string().describe('Base64-encoded binary content'),
    encoding: z.enum(['base64']).optional().default('base64')
  });
  const EditOperation = z.object({ oldText: z.string(), newText: z.string() });
  const EditFileArgsSchema = z.object({ path: z.string(), edits: z.array(EditOperation), dryRun: z.boolean().default(false) });
  const CreateDirectoryArgsSchema = z.object({ path: z.string() });
  const DeleteFileArgsSchema = z.object({ path: z.string() });
  const DeleteDirectoryArgsSchema = z.object({ path: z.string() });
  const ListDirectoryArgsSchema = z.object({ path: z.string() });
  const ListDirectoryWithSizesArgsSchema = z.object({ path: z.string(), sortBy: z.enum(['name', 'size']).optional().default('name') });
  const ListDirectoryDetailedArgsSchema = z.object({ path: z.string() });
  const DirectoryTreeArgsSchema = z.object({
    path: z.string(),
    maxDepth: z.number().int().positive().max(100).optional(),
    maxNodes: z.number().int().positive().max(20000).optional()
  });
  const MoveFileArgsSchema = z.object({ source: z.string(), destination: z.string() });
  const CopyFileArgsSchema = z.object({
    source: z.string(),
    destination: z.string(),
    overwrite: z.boolean().optional().default(false)
  });
  const SearchFilesArgsSchema = z.object({
    path: z.string(),
    pattern: z.string(),
    excludePatterns: z.array(z.string()).optional().default([]),
    maxResults: z.number().int().positive().max(20000).optional().default(5000),
    workspaceVersion: z.number().int().nonnegative().optional().default(0)
  });
  const SearchTextArgsSchema = z.object({
    path: z.string(),
    query: z.string(),
    caseSensitive: z.boolean().optional().default(false),
    useRegex: z.boolean().optional().default(false),
    wholeWord: z.boolean().optional().default(false),
    maxResults: z.number().int().positive().max(5000).optional().default(2000),
    excludePatterns: z.array(z.string()).optional().default([]),
    paths: z.array(z.string()).optional().default([]),
    workspaceVersion: z.number().int().nonnegative().optional().default(0)
  });
  const SearchTextStatusArgsSchema = z.object({
    jobId: z.string()
  });
  const SearchTextCancelArgsSchema = z.object({
    jobId: z.string()
  });
  const ReplaceTextArgsSchema = z.object({
    path: z.string(),
    query: z.string(),
    replaceWith: z.string(),
    caseSensitive: z.boolean().optional().default(false),
    useRegex: z.boolean().optional().default(false),
    wholeWord: z.boolean().optional().default(false),
    maxResults: z.number().int().positive().max(100000).optional().default(50000),
    excludePatterns: z.array(z.string()).optional().default([]),
    selectedMatchIds: z.array(z.string()).optional().default([]),
    workspaceVersion: z.number().int().nonnegative().optional().default(0),
    dryRun: z.boolean().optional().default(false)
  });
  const GetFileInfoArgsSchema = z.object({ path: z.string() });
  const MarkdownCrdtChangeTypeSchema = z.enum([
    'replaceTextRange',
    'replaceDocumentFromMarkdown',
    'replaceDocumentModel',
    'updateDocument',
    'updateDocumentMetadata',
    'addChapter',
    'deleteChapter',
    'reorderChapter',
    'updateChapter',
    'addParagraph',
    'deleteParagraph',
    'reorderParagraph',
    'updateParagraph',
    'updateMetadata'
  ]);
  const MarkdownCrdtChangeSchema = z.object({
    type: MarkdownCrdtChangeTypeSchema.optional(),
    from: z.number().optional(),
    deleteCount: z.number().optional(),
    insertText: z.string().optional(),
    markdown: z.string().optional(),
    model: z.any().optional(),
    metadata: z.any().optional(),
    patch: z.any().optional(),
    chapter: z.any().optional(),
    paragraph: z.any().optional(),
    chapterId: z.string().optional(),
    paragraphId: z.string().optional(),
    position: z.number().optional(),
    title: z.string().optional(),
    infoText: z.string().optional(),
    text: z.string().optional(),
    target: z.string().optional()
  });
  const OpenMarkdownCrdtDocumentArgsSchema = z.object({ path: z.string() });
  const ApplyMarkdownCrdtChangeArgsSchema = z.object({
    documentId: z.string(),
    baseHeads: z.array(z.string()).optional(),
    operation: MarkdownCrdtChangeTypeSchema.optional(),
    changeJson: z.string().optional(),
    change: MarkdownCrdtChangeSchema
  });
  const MergeMarkdownCrdtDocumentArgsSchema = z.object({
    documentId: z.string(),
    remoteDocumentId: z.string().optional(),
    remoteStateBase64: z.string().optional()
  }).refine((value) => Boolean(value.remoteDocumentId || value.remoteStateBase64), {
    message: 'remoteDocumentId or remoteStateBase64 is required'
  });
  const SaveMarkdownCrdtDocumentArgsSchema = z.object({
    documentId: z.string().optional(),
    path: z.string().optional()
  }).refine((value) => Boolean(value.documentId || value.path), {
    message: 'documentId or path is required'
  });
  const SyncMarkdownCrdtFromFileArgsSchema = z.object({ path: z.string() });
  const optionalTransportEnum = (values) => z.preprocess(
    normalizeOptionalTransportEnum,
    z.enum(values).optional()
  );
  const ScriptaViewSchema = z.object({
    mode: optionalTransportEnum(['document', 'paragraph']),
    chapterId: z.string().optional(),
    paragraphId: z.string().optional(),
    selectedVariantId: z.string().optional(),
    editingVariantId: z.string().optional(),
    editorParticipantId: z.string().optional(),
    focusTargetType: optionalTransportEnum(['chapter', 'paragraph']),
    autoFocusRevision: z.number().int().nonnegative().optional()
  });
  const optionalTransportInteger = (minimum) => z.preprocess((value) => {
    if (value === '' || value === null || value === undefined) return undefined;
    if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value);
    return value;
  }, z.number().int().min(minimum).optional());
  const ScriptaMutationArgsSchema = z.object({
    chapterId: z.string().optional(),
    paragraphId: z.string().optional(),
    variantId: z.string().optional(),
    variantOrdinal: optionalTransportInteger(1),
    // Some MCP runtimes materialize an omitted optional enum as an empty string.
    // It means “not supplied” for non-vote mutations, not an invalid vote.
    type: optionalTransportEnum(['like', 'dislike']),
    text: z.string().optional(),
    title: z.string().optional(),
    targetChapterId: z.string().optional(),
    targetIndex: optionalTransportInteger(0),
    roomId: z.string().optional(),
    roomFolderPath: z.string().regex(/^\/WebMeet\/[a-zA-Z0-9._-]+$/).optional(),
    assetId: z.string().optional(),
    imageId: z.string().optional(),
    imageOrdinal: optionalTransportInteger(1),
    alt: z.string().optional(),
    position: optionalTransportInteger(0),
    widthPercent: optionalTransportInteger(20),
    aspectRatio: optionalTransportEnum(['auto', '1:1', '4:3', '3:2', '16:9']),
    fit: optionalTransportEnum(['contain', 'cover']),
    alignment: optionalTransportEnum(['left', 'center', 'right']),
    showCaption: z.boolean().optional()
  });
  const ScriptaParagraphSeedSchema = z.object({
    id: z.string().optional(),
    text: z.string().optional()
  });
  const ScriptaChapterSeedSchema = z.object({
    id: z.string().optional(),
    title: z.string().optional(),
    paragraphs: z.array(ScriptaParagraphSeedSchema).optional()
  });
  const ScriptaInitializationSchema = z.object({
    title: z.string().optional(),
    objective: z.string().optional(),
    chapterTitle: z.string().optional(),
    visionParagraphs: z.array(ScriptaParagraphSeedSchema).optional(),
    planParagraphs: z.array(ScriptaParagraphSeedSchema).optional(),
    chapters: z.array(ScriptaChapterSeedSchema).optional()
  });
  const ScriptaCrdtOpenArgsSchema = z.object({
    path: z.string(),
    resourceId: z.string().optional(),
    viewerHash: z.string().min(1),
    view: ScriptaViewSchema.optional(),
    participantMap: z.record(z.string()).optional()
  });
  const ScriptaCrdtEnsureFolderArgsSchema = z.object({
    folderPath: z.string()
  });
  const ScriptaCrdtWorkspaceListArgsSchema = z.object({
    defaultFolder: z.string()
  });
  const ScriptaCrdtCreateArgsSchema = z.object({
    path: z.string(),
    title: z.string(),
    template: z.enum(['vision', 'plan', 'general']),
    initialization: ScriptaInitializationSchema.optional(),
    createdBy: z.string().min(1),
    resourceId: z.string().optional(),
    viewerHash: z.string().optional(),
    view: ScriptaViewSchema.optional()
  });
  const ScriptaCrdtMutateArgsSchema = z.object({
    path: z.string(),
    resourceId: z.string().optional(),
    operation: z.enum([
      'p-variant-add',
      'p-variant-vote',
      'p-variant-vote-withdraw',
      'p-variant-edit',
      'p-variant-delete',
      'p-variant-image-insert',
      'p-variant-image-replace',
      'p-variant-image-delete',
      'p-variant-image-layout',
      'chapter-add',
      'chapter-delete',
      'chapter-rename',
      'chapter-move',
      'paragraph-add',
      'paragraph-delete',
      'paragraph-move',
      'undo'
    ]),
    args: ScriptaMutationArgsSchema.optional(),
    participant: z.object({
      id: z.string(),
      hash: z.string(),
      label: z.string()
    }),
    viewerHash: z.string().optional(),
    view: ScriptaViewSchema.optional(),
    participantMap: z.record(z.string()).optional()
  });
  const ScriptaCrdtDeleteArgsSchema = z.object({
    phase: z.enum(['prepare', 'commit', 'rollback']),
    documentId: z.string().optional(),
    path: z.string().optional(),
    transactionId: z.string().optional()
  }).refine((value) => (
    value.phase === 'prepare'
      ? Boolean(value.documentId || value.path)
      : Boolean(value.transactionId)
  ), {
    message: 'prepare requires documentId or path; commit and rollback require transactionId'
  });
  const WebMeetMediaCommitArgsSchema = z.object({
    roomId: z.string().min(1),
    roomFolderPath: z.string().regex(/^\/WebMeet\/[a-zA-Z0-9._-]+$/),
    blobRef: z.object({
      id: z.string().regex(/^[a-f0-9]{48}$/),
      agent: z.string().min(1),
      localPath: z.string().min(1)
    }).strict()
  });
  const WebMeetMediaGetArgsSchema = z.object({
    roomId: z.string().min(1),
    roomFolderPath: z.string().regex(/^\/WebMeet\/[a-zA-Z0-9._-]+$/),
    assetId: z.string().min(1)
  });
  const ScriptaCollaborationOpenArgsSchema = ScriptaCrdtOpenArgsSchema;
  const ScriptaCollaborationPullArgsSchema = ScriptaCrdtOpenArgsSchema.extend({
    knownHeads: z.array(z.string()).optional()
  });
  const ScriptaCollaborationApplyArgsSchema = ScriptaCrdtMutateArgsSchema.extend({
    operation: z.literal('p-variant-edit'),
    changesBase64: z.array(z.string()).min(1).max(128),
    baseHeads: z.array(z.string()).optional()
  });
  const ScriptaCollaborationMergeMarkdownArgsSchema = z.object({
    path: z.string(),
    resourceId: z.string().optional(),
    markdown: z.string().min(1),
    baseStateBase64: z.string().optional(),
    participant: z.object({
      id: z.string(),
      hash: z.string(),
      label: z.string()
    }),
    viewerHash: z.string().optional(),
    view: ScriptaViewSchema.optional(),
    participantMap: z.record(z.string()).optional()
  });
  const LlmAutocompleteArgsSchema = z.object({
    path: z.string(),
    content: z.string(),
    cursorOffset: z.number(),
    language: z.string().optional().default('')
  });
  const CollectIDEPluginsArgsSchema = z.object({});
  const GetPluginSettingsArgsSchema = z.object({});
  const SetPluginEnabledArgsSchema = z.object({
    key: z.string(),
    enabled: z.boolean()
  });
  const ReadSkillsManifestStateArgsSchema = z.object({ folderPath: z.string() });
  const AddSkillsManifestRepoArgsSchema = z.object({
    folderPath: z.string(),
    url: z.string(),
    name: z.string().optional().nullable(),
    branch: z.string().optional().nullable()
  });
  const SetSkillsManifestSkillEnabledArgsSchema = z.object({
    folderPath: z.string(),
    repoName: z.string(),
    skill: z.string().optional(),
    skillset: z.string().optional(),
    enabled: z.boolean()
  });
  const RemoveSkillsManifestRepoArgsSchema = z.object({
    folderPath: z.string(),
    repoName: z.string()
  });
  const GetAvatarSettingsAgentsArgsSchema = z.object({});
  const UpdateAvatarSettingsAgentArgsSchema = z.object({
    agentId: z.string(),
    config: z.record(z.any())
  });
  const SetAvatarSettingsAgentVisibilityArgsSchema = z.object({
    agentId: z.string(),
    enabled: z.boolean()
  });

  return {
    ReadTextFileArgsSchema,
    ReadMediaFileArgsSchema,
    ReadMultipleFilesArgsSchema,
    WriteFileArgsSchema,
    WriteBinaryFileArgsSchema,
    EditOperation,
    EditFileArgsSchema,
    CreateDirectoryArgsSchema,
    DeleteFileArgsSchema,
    DeleteDirectoryArgsSchema,
    ListDirectoryArgsSchema,
    ListDirectoryWithSizesArgsSchema,
    ListDirectoryDetailedArgsSchema,
    DirectoryTreeArgsSchema,
    MoveFileArgsSchema,
    CopyFileArgsSchema,
    SearchFilesArgsSchema,
    SearchTextArgsSchema,
    SearchTextStatusArgsSchema,
    SearchTextCancelArgsSchema,
    ReplaceTextArgsSchema,
    GetFileInfoArgsSchema,
    MarkdownCrdtChangeSchema,
    OpenMarkdownCrdtDocumentArgsSchema,
    ApplyMarkdownCrdtChangeArgsSchema,
    MergeMarkdownCrdtDocumentArgsSchema,
    SaveMarkdownCrdtDocumentArgsSchema,
    SyncMarkdownCrdtFromFileArgsSchema,
    ScriptaCrdtOpenArgsSchema,
    ScriptaCrdtEnsureFolderArgsSchema,
    ScriptaCrdtWorkspaceListArgsSchema,
    ScriptaCrdtCreateArgsSchema,
    ScriptaCrdtMutateArgsSchema,
    WebMeetMediaCommitArgsSchema,
    WebMeetMediaGetArgsSchema,
    ScriptaCrdtDeleteArgsSchema,
    ScriptaCollaborationOpenArgsSchema,
    ScriptaCollaborationPullArgsSchema,
    ScriptaCollaborationApplyArgsSchema,
    ScriptaCollaborationMergeMarkdownArgsSchema,
    LlmAutocompleteArgsSchema,
    CollectIDEPluginsArgsSchema,
    GetPluginSettingsArgsSchema,
    SetPluginEnabledArgsSchema,
    ReadSkillsManifestStateArgsSchema,
    AddSkillsManifestRepoArgsSchema,
    SetSkillsManifestSkillEnabledArgsSchema,
    RemoveSkillsManifestRepoArgsSchema,
    GetAvatarSettingsAgentsArgsSchema,
    UpdateAvatarSettingsAgentArgsSchema,
    SetAvatarSettingsAgentVisibilityArgsSchema
  };
}
