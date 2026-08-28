import type { ModelRequest, ModelResponse } from './model-types.js'

export interface ModelProvider {
  readonly name: string
  complete(request: ModelRequest): Promise<ModelResponse>
  /** Optional incremental output path. The returned response remains the canonical result. */
  stream?(
    request: ModelRequest,
    onTextDelta: (delta: string) => void | Promise<void>,
  ): Promise<ModelResponse>
}
