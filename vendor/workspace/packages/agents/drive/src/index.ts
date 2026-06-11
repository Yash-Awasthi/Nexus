/**
 * Agent-11: Drive
 * ───────────────
 * Google Drive file management: list, search, upload, download, share, organize.
 */
import {
  AgentBase, AgentTask, AgentResult, AgentConfig,
  MessageBus, StateStore, ToolDefinition,
} from '@workspace/core';
import * as GoogleDrive from '@workspace/integrations/googledrive';

const CONFIG: AgentConfig = {
  id:           'drive',
  name:         'Drive Agent',
  description:  'Google Drive — list, search, upload, download, share, create folders',
  version:      '1.0.0',
  capabilities: ['list_files','search_files','upload_file','download_file','share_file','create_folder'],
  model:        'claude-opus-4-6',
  systemPrompt: [
    'You are the Drive Agent. You manage Google Drive files for the user.',
    'Always confirm before overwriting existing files.',
    'When sharing, default to viewer access unless editor is explicitly required.',
    'Organize uploads into appropriate folders — create folders if needed.',
    'Prefer searching before creating to avoid duplicate files.',
  ].join(' '),
};

export class DriveAgent extends AgentBase {
  constructor(bus: MessageBus, state: StateStore) {
    super(CONFIG, bus, state);
  }

  protected registerTools(): void {
    const tools: ToolDefinition[] = [
      {
        name:        'list_files',
        description: 'List files in Google Drive, optionally filtered by folder',
        inputSchema: {
          type: 'object',
          properties: {
            folderId:   { type: 'string', description: 'Folder ID to list (default: root)' },
            maxResults: { type: 'number', description: 'Max files to return (default: 20)' },
            mimeType:   { type: 'string', description: 'Filter by MIME type' },
          },
        },
        handler: async ({ folderId, maxResults = 20, mimeType }:
          { folderId?: string; maxResults?: number; mimeType?: string }) => {
          return GoogleDrive.listFiles({ folderId, maxResults, mimeType });
        },
      },
      {
        name:        'search_files',
        description: 'Search Google Drive files by name or content query',
        inputSchema: {
          type: 'object',
          required: ['query'],
          properties: {
            query:      { type: 'string', description: 'Search query (Drive query syntax)' },
            maxResults: { type: 'number', description: 'Max results (default: 20)' },
          },
        },
        handler: async ({ query, maxResults = 20 }: { query: string; maxResults?: number }) => {
          return GoogleDrive.searchFiles({ query, maxResults });
        },
      },
      {
        name:        'upload_file',
        description: 'Upload a file to Google Drive from local path',
        inputSchema: {
          type: 'object',
          required: ['localPath', 'fileName'],
          properties: {
            localPath: { type: 'string', description: 'Local file system path to upload' },
            fileName:  { type: 'string', description: 'Desired file name in Drive' },
            folderId:  { type: 'string', description: 'Destination folder ID (default: root)' },
            mimeType:  { type: 'string', description: 'File MIME type' },
          },
        },
        handler: async ({ localPath, fileName, folderId, mimeType }:
          { localPath: string; fileName: string; folderId?: string; mimeType?: string }) => {
          return GoogleDrive.uploadFile({ localPath, fileName, folderId, mimeType });
        },
      },
      {
        name:        'download_file',
        description: 'Download a file from Google Drive to local filesystem',
        inputSchema: {
          type: 'object',
          required: ['fileId', 'destPath'],
          properties: {
            fileId:   { type: 'string', description: 'Google Drive file ID' },
            destPath: { type: 'string', description: 'Local destination path' },
          },
        },
        handler: async ({ fileId, destPath }: { fileId: string; destPath: string }) => {
          await GoogleDrive.downloadFile({ fileId, destPath });
          return { downloaded: true, fileId, destPath };
        },
      },
      {
        name:        'share_file',
        description: 'Share a Google Drive file with a user or make it public',
        inputSchema: {
          type: 'object',
          required: ['fileId'],
          properties: {
            fileId:      { type: 'string', description: 'Google Drive file ID' },
            email:       { type: 'string', description: 'Email to share with (omit for public)' },
            role:        { type: 'string', enum: ['reader','commenter','writer'], description: 'Permission role (default: reader)' },
            makePublic:  { type: 'boolean', description: 'Make file publicly readable' },
          },
        },
        handler: async ({ fileId, email, role = 'reader', makePublic = false }:
          { fileId: string; email?: string; role?: string; makePublic?: boolean }) => {
          return GoogleDrive.shareFile({ fileId, email, role, makePublic });
        },
      },
      {
        name:        'create_folder',
        description: 'Create a folder in Google Drive',
        inputSchema: {
          type: 'object',
          required: ['name'],
          properties: {
            name:     { type: 'string', description: 'Folder name' },
            parentId: { type: 'string', description: 'Parent folder ID (default: root)' },
          },
        },
        handler: async ({ name, parentId }: { name: string; parentId?: string }) => {
          return GoogleDrive.createFolder({ name, parentId });
        },
      },
    ];

    for (const t of tools) this.toolRegistry.register(t);
  }

  protected async handle(task: AgentTask): Promise<AgentResult> {
    const start = Date.now();
    const result = await this.runAgentLoop(task.input as string);
    return {
      taskId:     task.id,
      agentId:    this.config.id,
      success:    true,
      output:     result,
      durationMs: Date.now() - start,
    };
  }
}

export function createAgent(bus: MessageBus, state: StateStore): DriveAgent {
  return new DriveAgent(bus, state);
}
