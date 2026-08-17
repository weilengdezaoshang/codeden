import type { ModelRequest, ModelResponse } from './model-types.js'

export interface ModelProvider {
  readonly name: string
  complete(request: ModelRequest): Promise<ModelResponse>
}
