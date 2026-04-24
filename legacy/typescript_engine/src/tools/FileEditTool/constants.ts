// In its own file to avoid circular dependencies
export const FILE_EDIT_TOOL_NAME = 'Edit'

// Permission pattern for granting session-level access to the project's .kai/ folder
export const KAI_FOLDER_PERMISSION_PATTERN = '/.kai/**'

// Permission pattern for granting session-level access to the global ~/.kai/ folder
export const GLOBAL_KAI_FOLDER_PERMISSION_PATTERN = '~/.kai/**'

export const FILE_UNEXPECTEDLY_MODIFIED_ERROR =
  'File has been unexpectedly modified. Read it again before attempting to write it.'
