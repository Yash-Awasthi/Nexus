import { fileName, fileNameProblem } from '../contract/files.ts'
import { badRequest } from './errors.ts'

/** The name an upload is stored under, or 400 `invalid_attachment` when it's one no backend keeps. */
export function uploadName(name: string | null): string {
  const named = fileName(name)
  const problem = fileNameProblem(named)
  if (problem) throw badRequest(problem, 'invalid_attachment')
  return named
}
