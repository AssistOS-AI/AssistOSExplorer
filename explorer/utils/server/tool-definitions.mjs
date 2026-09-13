export function buildToolDefinitions(zodToJsonSchema, schemas) {
  const {
    ReadTextFileArgsSchema,
    ReadMediaFileArgsSchema,
    ReadMultipleFilesArgsSchema,
    WriteFileArgsSchema,
    WriteBinaryFileArgsSchema,
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
    ScriptaCrdtDeleteArgsSchema,
    WebMeetMediaCommitArgsSchema,
    WebMeetMediaGetArgsSchema,
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
  } = schemas;

  return [
    {
      name: 'read_file',
      description: 'Read the complete contents of a file as text. DEPRECATED: Use read_text_file instead.',
      inputSchema: zodToJsonSchema(ReadTextFileArgsSchema)
    },
    {
      name: 'read_text_file',
      description: 'Read the complete contents of a file from the file system as text. Handles encodings and optional head/tail.',
      inputSchema: zodToJsonSchema(ReadTextFileArgsSchema)
    },
    {
      name: 'read_media_file',
      description: 'Read an image or audio file and return base64 data with MIME type.',
      inputSchema: zodToJsonSchema(ReadMediaFileArgsSchema)
    },
    {
      name: 'read_multiple_files',
      description: 'Read the contents of multiple files simultaneously.',
      inputSchema: zodToJsonSchema(ReadMultipleFilesArgsSchema)
    },
    {
      name: 'write_file',
      description: 'Create or overwrite a file with new content.',
      inputSchema: zodToJsonSchema(WriteFileArgsSchema)
    },
    {
      name: 'write_binary_file',
      description: 'Create or overwrite a binary file using base64 encoded content.',
      inputSchema: zodToJsonSchema(WriteBinaryFileArgsSchema)
    },
    {
      name: 'edit_file',
      description: 'Apply textual edits to a file and return a diff.',
      inputSchema: zodToJsonSchema(EditFileArgsSchema)
    },
    {
      name: 'create_directory',
      description: 'Ensure a directory exists by creating it recursively.',
      inputSchema: zodToJsonSchema(CreateDirectoryArgsSchema)
    },
    {
      name: 'delete_file',
      description: 'Delete a file.',
      inputSchema: zodToJsonSchema(DeleteFileArgsSchema)
    },
    {
      name: 'delete_directory',
      description: 'Delete a directory.',
      inputSchema: zodToJsonSchema(DeleteDirectoryArgsSchema)
    },
    {
      name: 'list_directory',
      description: 'List files and directories within a path.',
      inputSchema: zodToJsonSchema(ListDirectoryArgsSchema)
    },
    {
      name: 'list_directory_with_sizes',
      description: 'List directory contents with sizes and summary.',
      inputSchema: zodToJsonSchema(ListDirectoryWithSizesArgsSchema)
    },
    {
      name: 'list_directory_detailed',
      description: 'List directory contents with metadata as JSON.',
      inputSchema: zodToJsonSchema(ListDirectoryDetailedArgsSchema)
    },
    {
      name: 'directory_tree',
      description: 'Return a JSON tree of files and directories.',
      inputSchema: zodToJsonSchema(DirectoryTreeArgsSchema)
    },
    {
      name: 'move_file',
      description: 'Move or rename files or directories.',
      inputSchema: zodToJsonSchema(MoveFileArgsSchema)
    },
    {
      name: 'copy_file',
      description: 'Copy files or directories. Supports recursive copies.',
      inputSchema: zodToJsonSchema(CopyFileArgsSchema)
    },
    {
      name: 'search_files',
      description: 'Recursive search for files and directories matching a pattern.',
      inputSchema: zodToJsonSchema(SearchFilesArgsSchema)
    },
    {
      name: 'search_text',
      description: 'Start a background text search in files under a path. Returns a jobId for polling.',
      inputSchema: zodToJsonSchema(SearchTextArgsSchema)
    },
    {
      name: 'search_text_status',
      description: 'Poll the status and results of a background text search job.',
      inputSchema: zodToJsonSchema(SearchTextStatusArgsSchema)
    },
    {
      name: 'search_text_cancel',
      description: 'Cancel a running background text search job.',
      inputSchema: zodToJsonSchema(SearchTextCancelArgsSchema)
    },
    {
      name: 'replace_text',
      description: 'Replace text matches inside files under a path.',
      inputSchema: zodToJsonSchema(ReplaceTextArgsSchema)
    },
    {
      name: 'get_file_info',
      description: 'Retrieve metadata about a file or directory.',
      inputSchema: zodToJsonSchema(GetFileInfoArgsSchema)
    },
    {
      name: 'open_markdown_crdt_document',
      description: 'Open or initialize the Automerge CRDT state for a Markdown document.',
      inputSchema: zodToJsonSchema(OpenMarkdownCrdtDocumentArgsSchema)
    },
    {
      name: 'apply_markdown_crdt_change',
      description: 'Apply an incremental Markdown CRDT change to an Automerge document.',
      inputSchema: zodToJsonSchema(ApplyMarkdownCrdtChangeArgsSchema)
    },
    {
      name: 'merge_markdown_crdt_document',
      description: 'Merge another Automerge Markdown CRDT state into a local Markdown document.',
      inputSchema: zodToJsonSchema(MergeMarkdownCrdtDocumentArgsSchema)
    },
    {
      name: 'save_markdown_crdt_document',
      description: 'Export an Automerge Markdown document state back to the .md file.',
      inputSchema: zodToJsonSchema(SaveMarkdownCrdtDocumentArgsSchema)
    },
    {
      name: 'sync_markdown_crdt_from_file',
      description: 'Synchronize an Automerge Markdown state from the current .md file contents.',
      inputSchema: zodToJsonSchema(SyncMarkdownCrdtFromFileArgsSchema)
    },
    {
      name: 'scripta_crdt_ensure_folder',
      description: 'Create a workspace-confined folder for SCRIPTA documents.',
      inputSchema: zodToJsonSchema(ScriptaCrdtEnsureFolderArgsSchema)
    },
    {
      name: 'scripta_crdt_workspace_list',
      description: 'List workspace Markdown documents for the SCRIPTA picker.',
      inputSchema: zodToJsonSchema(ScriptaCrdtWorkspaceListArgsSchema)
    },
    {
      name: 'scripta_crdt_create',
      description: 'Create and initialize a SCRIPTA Markdown document as an Automerge CRDT.',
      inputSchema: zodToJsonSchema(ScriptaCrdtCreateArgsSchema)
    },
    {
      name: 'scripta_crdt_open',
      description: 'Open a workspace-confined SCRIPTA Markdown CRDT document.',
      inputSchema: zodToJsonSchema(ScriptaCrdtOpenArgsSchema)
    },
    {
      name: 'scripta_crdt_mutate',
      description: 'Atomically mutate and save a SCRIPTA document through its Automerge state.',
      inputSchema: zodToJsonSchema(ScriptaCrdtMutateArgsSchema)
    },
    {
      name: 'scripta_crdt_delete',
      description: 'Prepare, commit, or roll back an atomic SCRIPTA document deletion.',
      inputSchema: zodToJsonSchema(ScriptaCrdtDeleteArgsSchema)
    },
    {
      name: 'webmeet_media_commit',
      description: 'Validate and commit a staged WebMeet attachment into the Explorer workspace media library.',
      inputSchema: zodToJsonSchema(WebMeetMediaCommitArgsSchema)
    },
    {
      name: 'webmeet_media_get',
      description: 'Resolve safe metadata for a WebMeet workspace media asset.',
      inputSchema: zodToJsonSchema(WebMeetMediaGetArgsSchema)
    },
    {
      name: 'scripta_collaboration_open',
      description: 'Open the public SCRIPTA Automerge replica without workspace metadata.',
      inputSchema: zodToJsonSchema(ScriptaCollaborationOpenArgsSchema)
    },
    {
      name: 'scripta_collaboration_pull',
      description: 'Return public SCRIPTA Automerge changes after the supplied heads.',
      inputSchema: zodToJsonSchema(ScriptaCollaborationPullArgsSchema)
    },
    {
      name: 'scripta_collaboration_apply',
      description: 'Validate, merge, and persist incremental public SCRIPTA Automerge changes.',
      inputSchema: zodToJsonSchema(ScriptaCollaborationApplyArgsSchema)
    },
    {
      name: 'scripta_collaboration_merge_markdown',
      description: 'Merge a complete Markdown revision made from a SCRIPTA collaboration snapshot.',
      inputSchema: zodToJsonSchema(ScriptaCollaborationMergeMarkdownArgsSchema)
    },
    {
      name: 'llm_autocomplete',
      description: 'Generate a code completion for the current cursor position using file context.',
      inputSchema: zodToJsonSchema(LlmAutocompleteArgsSchema)
    },
    {
      name: 'collect_ide_plugins',
      description: 'Aggregate IDE plugin configurations grouped by location based on config.json files.',
      inputSchema: zodToJsonSchema(CollectIDEPluginsArgsSchema)
    },
    {
      name: 'get_plugin_settings',
      description: 'Read persisted workspace plugin settings from /.data/explorer/plugin-settings.json.',
      inputSchema: zodToJsonSchema(GetPluginSettingsArgsSchema)
    },
    {
      name: 'set_plugin_enabled',
      description: 'Persist enabled or disabled state for a plugin in workspace settings.',
      inputSchema: zodToJsonSchema(SetPluginEnabledArgsSchema)
    },
    {
      name: 'read_skills_manifest_state',
      description: 'Read ploinky-skills-manifest.json and available cached skills for a workspace folder.',
      inputSchema: zodToJsonSchema(ReadSkillsManifestStateArgsSchema)
    },
    {
      name: 'add_skills_manifest_repo',
      description: 'Add a skill repository to ploinky-skills-manifest.json, cache it, and install all of its skills.',
      inputSchema: zodToJsonSchema(AddSkillsManifestRepoArgsSchema)
    },
    {
      name: 'set_skills_manifest_skill_enabled',
      description: 'Enable or disable a named skillset as a batch, or one skill for repositories without skillsets.md.',
      inputSchema: zodToJsonSchema(SetSkillsManifestSkillEnabledArgsSchema)
    },
    {
      name: 'remove_skills_manifest_repo',
      description: 'Remove a repository entry from ploinky-skills-manifest.json and resync installed skills.',
      inputSchema: zodToJsonSchema(RemoveSkillsManifestRepoArgsSchema)
    },
    {
      name: 'get_avatar_settings_agents',
      description: 'List AI agent avatar settings visible in the current workspace.',
      inputSchema: zodToJsonSchema(GetAvatarSettingsAgentsArgsSchema)
    },
    {
      name: 'update_avatar_settings_agent',
      description: 'Update one AI agent avatar configuration.',
      inputSchema: zodToJsonSchema(UpdateAvatarSettingsAgentArgsSchema)
    },
    {
      name: 'set_avatar_settings_agent_visibility',
      description: 'Enable or disable one AI agent avatar.',
      inputSchema: zodToJsonSchema(SetAvatarSettingsAgentVisibilityArgsSchema)
    },
    {
      name: 'list_allowed_directories',
      description: 'Return the directories that the server is permitted to access.',
      inputSchema: { type: 'object', properties: {}, required: [] }
    }
  ];
}
