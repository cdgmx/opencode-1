import type { Provider } from "@opencode-ai/sdk/v2"

export function parseModel(model: string) {
  const [providerID, ...rest] = model.split("/")
  return {
    providerID,
    modelID: rest.join("/"),
  }
}

export function index(providers?: Provider[]) {
  return new Map((providers ?? []).map((provider) => [provider.id, provider]))
}

export function name(providers: Provider[] | ReadonlyMap<string, Provider> | undefined, providerID: string, modelID: string) {
  const provider = Array.isArray(providers)
    ? providers.find((item) => item.id === providerID)
    : providers?.get(providerID)
  if (!provider) return modelID
  const model = provider.models[modelID]
  if (!model) return modelID
  return model.name ? `${provider.name}/${model.name}` : `${provider.name}/${modelID}`
}
