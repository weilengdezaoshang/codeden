import { CodeDenError } from '../core/errors/codeden-error.js'
import { ErrorCodes } from '../core/errors/error-codes.js'

export function configNotFound(workspaceRoot: string): CodeDenError {
  return new CodeDenError({
    code: ErrorCodes.CONFIG_NOT_FOUND,
    category: 'validation',
    message: `未找到 .codeden/config.yaml（已从 ${workspaceRoot} 和当前目录向上查找）。请在 CodeDen 项目里创建配置，并只保存环境变量引用。`,
    retryable: false,
  })
}

export function configReadFailed(cause: string): CodeDenError {
  return new CodeDenError({
    code: ErrorCodes.CONFIG_READ_FAILED,
    category: 'validation',
    message: `无法读取配置文件: ${cause}`,
    retryable: false,
  })
}

export function configYamlInvalid(location: string, reason: string): CodeDenError {
  return new CodeDenError({
    code: ErrorCodes.CONFIG_YAML_INVALID,
    category: 'validation',
    message: `配置 YAML 无效 (${location}): ${reason}`,
    retryable: false,
  })
}

export function configSchemaInvalid(message: string): CodeDenError {
  return new CodeDenError({
    code: ErrorCodes.CONFIG_SCHEMA_INVALID,
    category: 'validation',
    message,
    retryable: false,
  })
}

export function literalSecretForbidden(): CodeDenError {
  return new CodeDenError({
    code: ErrorCodes.SECRET_LITERAL_FORBIDDEN,
    category: 'validation',
    message: '配置禁止保存明文 API Key，请使用 from: env 引用环境变量',
    retryable: false,
  })
}
