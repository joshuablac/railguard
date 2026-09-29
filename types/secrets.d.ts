export interface Finding {
  rule: string
  title: string
  file: string
  line: number
  column: number
  /** The match with the secret replaced by "********". */
  preview: string
}

export interface Rule {
  id: string
  title: string
  re: RegExp
  group: number
  validate?: (secret: string, ctx: { config: boolean; quoted: boolean }) => boolean
}

export interface EnvFileProblem {
  level: 'error' | 'warn'
  file: string
  message: string
}

export declare const RULES: Rule[]
export declare function scanText(text: string, options?: { file?: string }): Finding[]
export declare function scanFiles(options?: { cwd?: string; paths?: string[] }): { findings: Finding[]; scanned: number }
export declare function scanStaged(options?: { cwd?: string }): { findings: Finding[]; scanned: number }
export declare function checkEnvFiles(cwd?: string): EnvFileProblem[]
export declare function installHook(cwd?: string): { status: 'installed' | 'already-installed' | 'exists'; path: string; line: string }
export declare function listFiles(cwd?: string, paths?: string[]): string[]
export declare function isGitRepo(cwd?: string): boolean
export declare function mask(secret: string): string
