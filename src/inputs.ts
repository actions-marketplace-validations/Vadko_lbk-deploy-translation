import * as core from '@actions/core';
import { z } from 'zod';

/**
 * Kinds supported by the LBK upload API.
 *
 * Live spec: https://admin.lbklauncher.com/api-docs
 */
export const UPLOAD_KINDS = [
  'archive',
  'voice',
  'achievements',
  'epic',
  'gog',
  'xbox',
  'steam-linux',
  'steam-mac',
] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];

/**
 * Map kind → action.yml input key. Kebab-case kinds are passed through
 * unchanged (`steam-linux`, `steam-mac`).
 */
const KIND_INPUT: Record<UploadKind, string> = {
  archive: 'archive',
  voice: 'voice',
  achievements: 'achievements',
  epic: 'epic',
  gog: 'gog',
  xbox: 'xbox',
  'steam-linux': 'steam-linux',
  'steam-mac': 'steam-mac',
};

const percent = z.preprocess(
  (v) => (v === undefined || v === '' ? undefined : Number(v)),
  z.number().min(0).max(100).optional()
);

const InputsSchema = z.object({
  apiToken: z
    .string()
    .regex(
      /^lbk_[A-Za-z0-9_-]{43}$/,
      'expected "lbk_<43-char base64url>" (47 chars total). Get one at /settings.'
    ),
  gameId: z.uuid('expected UUID'),
  // .trim() before length check so a whitespace-only input is treated as
  // empty (action.yml uses a default '' so this catches the absence too).
  version: z.string().trim().min(1, 'version cannot be empty'),
  baseUrl: z.preprocess(
    (v) => (typeof v === 'string' && v ? v.replace(/\/+$/, '') : 'https://admin.lbklauncher.com'),
    z.url()
  ),
  // `planned` is excluded on purpose — it implies no archive upload,
  // and this action always supplies a file. The server also rejects planned for
  // submit-via-token API.
  status: z
    .enum(['completed', 'in-progress', 'tech-improvement'])
    .optional()
    .or(z.literal('').transform(() => undefined)),
  translationProgress: percent,
  editingProgress: percent,
  files: z.map(z.enum(UPLOAD_KINDS), z.string().min(1)).refine((m) => m.has('archive'), {
    message:
      'Main `archive` input is required (other kinds — voice/achievements/store-specific — are optional).',
  }),
});

export type ActionInputs = z.infer<typeof InputsSchema>;

export function parseInputs(): ActionInputs {
  const files = new Map<UploadKind, string>();
  for (const kind of UPLOAD_KINDS) {
    const raw = core.getInput(KIND_INPUT[kind]).trim();
    if (raw) files.set(kind, raw);
  }

  const result = InputsSchema.safeParse({
    apiToken: core.getInput('api-token', { required: true }),
    gameId: core.getInput('game-id', { required: true }),
    version: core.getInput('version', { required: true }),
    baseUrl: core.getInput('base-url'),
    status: core.getInput('status'),
    translationProgress: core.getInput('translation-progress'),
    editingProgress: core.getInput('editing-progress'),
    files,
  });

  if (!result.success) {
    const flat = result.error.issues
      .map((e) => `  - ${e.path.join('.') || '(root)'}: ${e.message}`)
      .join('\n');
    throw new Error(`Invalid action inputs:\n${flat}`);
  }

  return result.data;
}
